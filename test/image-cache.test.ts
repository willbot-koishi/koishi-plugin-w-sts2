import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, type TestContext } from 'node:test'
import { ImageCache, MAX_IMAGE_BYTES, readImage } from '../src/image-cache'
import { imageBytes } from './fixtures'

const url = 'https://cdn.spire-codex.com/cards-full/stable/zhs/bash.webp'

async function fixture(t: TestContext, request: (url: string) => Promise<Uint8Array> = async () => imageBytes) {
  const root = await mkdtemp(path.join(tmpdir(), 'w-sts2-images-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory = path.join(root, 'images')
  const calls: string[] = []
  const errors: string[] = []
  let now = Date.now()
  const create = (folder = directory) => new ImageCache(folder, 1000, async (url) => {
    calls.push(url)
    return request(url)
  }, operation => errors.push(operation), () => now)
  const filename = async () => path.join(directory, (await readdir(directory))[0])
  return { root, directory, calls, errors, create, cache: create(), filename,
    expire: async () => { await utimes(await filename(), (now - 2000) / 1000, (now - 2000) / 1000) },
    advance: (ms: number) => { now += ms } }
}

test('reuses raw image bytes on disk, including after a new cache instance starts', async (t) => {
  const { cache, create, calls, errors, filename } = await fixture(t)
  for (const current of [cache, cache, create()]) {
    const image = await current.get(url, 'stable')
    assert.deepEqual(image, { data: imageBytes, type: 'image/png', stale: false, persisted: true })
  }
  assert.deepEqual(calls, [url])
  assert.deepEqual(errors, [])
  assert.deepEqual(await readFile(await filename()), imageBytes)
})

test('coalesces concurrent requests until the file is fully written', async (t) => {
  let release: (bytes: Buffer) => void
  let requested: () => void
  const waiting = new Promise<Buffer>((resolve) => {
    release = resolve
  })
  const started = new Promise<void>((resolve) => {
    requested = resolve
  })
  t.after(() => release(imageBytes))
  const { cache, calls, directory } = await fixture(t, async () => {
    requested()
    return waiting
  })
  const first = cache.get(url, 'stable')
  const second = cache.get(url, 'stable')
  await started
  assert.equal(calls.length, 1)
  release(imageBytes)
  const images = await Promise.all([first, second])
  assert.deepEqual(images[0], images[1])
  assert.equal((await readdir(directory)).length, 1)
  assert.deepEqual(await cache.get(url, 'stable'), images[0])
  assert.equal(calls.length, 1)
})

test('isolates channels and URLs, preserving animated image bytes without conversion', async (t) => {
  const webp = Buffer.from('524946461000000057454250414e494d0400000000000000', 'hex')
  const { cache, calls, directory } = await fixture(t, async () => webp)
  const sources = [[url, 'stable'], [url, 'beta'], [url.replace('bash.webp', 'bash_upg.webp'), 'stable']] as const
  for (const [source, channel] of sources) {
    const image = await cache.get(source, channel)
    assert.equal(image.type, 'image/webp')
    assert.deepEqual(image.data, webp)
  }
  assert.equal(calls.length, 3)
  assert.equal((await readdir(directory)).length, 3)
})

test('refreshes expired images and atomically replaces the cache without temporary leftovers', async (t) => {
  const updated = Buffer.concat([imageBytes, Buffer.from('updated')])
  let version = imageBytes
  const { cache, calls, directory, filename, expire } = await fixture(t, async () => version)
  await cache.get(url, 'stable')
  await expire()
  version = updated
  const image = await cache.get(url, 'stable')
  assert.deepEqual(image.data, updated)
  assert.equal(image.stale, false)
  assert.deepEqual(await readFile(await filename()), updated)
  assert.equal((await readdir(directory)).length, 1)
  await cache.get(url, 'stable')
  assert.equal(calls.length, 2)
})

test('keeps the last good image on refresh failure and respects Retry-After before retrying', async (t) => {
  let fail = false
  const { cache, calls, errors, expire, advance, filename } = await fixture(t, async () => {
    if (fail) throw { response: { headers: new Headers({ 'retry-after': '120' }) } }
    return imageBytes
  })
  await cache.get(url, 'stable')
  await expire()
  fail = true
  const stale = await cache.get(url, 'stable')
  assert.deepEqual(stale, { data: imageBytes, type: 'image/png', stale: true, persisted: true })
  advance(60_000)
  assert.deepEqual(await cache.get(url, 'stable'), stale)
  assert.equal(calls.length, 2)
  assert.deepEqual(errors, ['download'])
  assert.deepEqual(await readFile(await filename()), imageBytes)
  advance(60_001)
  fail = false
  assert.equal((await cache.get(url, 'stable')).stale, false)
  assert.equal(calls.length, 3)
})

test('rejects HTML responses and backs off when no usable image exists', async (t) => {
  const { cache, calls, errors, directory } = await fixture(t, async () => Buffer.from('<html>CDN error</html>'))
  assert.equal(await cache.get(url, 'stable'), undefined)
  assert.equal(await cache.get(url, 'stable'), undefined)
  assert.equal(calls.length, 1)
  assert.deepEqual(errors, ['download'])
  await assert.rejects(readdir(directory), { code: 'ENOENT' })
})

test('repairs a corrupt disk entry rather than sending its bytes', async (t) => {
  const { cache, calls, errors, filename } = await fixture(t)
  await cache.get(url, 'stable')
  await writeFile(await filename(), 'not an image')
  assert.deepEqual((await cache.get(url, 'stable')).data, imageBytes)
  assert.equal(calls.length, 2)
  assert.deepEqual(errors, ['read'])
})

test('can still return a downloaded image if the cache cannot be written', async (t) => {
  const { root, create, errors } = await fixture(t)
  const blocked = path.join(root, 'not-a-directory')
  await writeFile(blocked, 'keep me')
  const cache = create(blocked)
  assert.deepEqual((await cache.get(url, 'stable')).data, imageBytes)
  assert.ok(errors.includes('write'))
  assert.equal(await readFile(blocked, 'utf8'), 'keep me')
})

test('does not request unsafe URLs', async (t) => {
  const { cache, calls } = await fixture(t)
  for (const unsafe of ['file:///etc/passwd', 'https://example.invalid/image.webp',
    'https://user:secret@spire-codex.com/image.webp', 'https://spire-codex.com:8443/image.webp']) {
    assert.equal(await cache.get(unsafe, 'stable'), undefined)
  }
  assert.deepEqual(calls, [])
})

test('bounds downloads with and without Content-Length and cancels oversized streams', async () => {
  let cancelled = false
  const oversized = () => new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)) },
    cancel() { cancelled = true },
  })
  await assert.rejects(readImage(new Response(oversized(), {
    headers: { 'content-length': String(MAX_IMAGE_BYTES + 1) },
  })), /size limit/)
  assert.equal(cancelled, true)
  cancelled = false
  await assert.rejects(readImage(new Response(oversized())), /size limit/)
  assert.equal(cancelled, true)
  assert.deepEqual(await readImage(new Response(imageBytes)), imageBytes)
})
