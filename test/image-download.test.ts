import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { HTTP } from 'koishi'
import { retryDelay } from '../src/catalog'
import { MAX_IMAGE_BYTES } from '../src/image-cache'
import { describeImageError, downloadImage, MAX_IMAGE_REDIRECTS } from '../src/image-download'
import { imageBytes } from './fixtures'

const source = 'https://spire-codex.com/static/images/cards/bash.webp'
const target = 'https://cdn.spire-codex.com/cards/bash.webp'

function fixture(t: TestContext, respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string, init: RequestInit }> = []
  t.mock.method(globalThis, 'fetch', async (url: URL, init: RequestInit) => {
    calls.push({ url: url.href, init })
    return respond(url.href, init)
  })
  return { http: new HTTP(), calls }
}

test('downloads provider images through validated redirects, including the production card and relic routes', async (t) => {
  const { http, calls } = fixture(t, url => url.includes('/static/images/')
    ? new Response(null, { status: 301, headers: { location: url.replace('spire-codex.com/static/images', 'cdn.spire-codex.com') } })
    : new Response(imageBytes))
  for (const kind of ['cards', 'relics']) {
    assert.deepEqual(await downloadImage(http, source.replace('/cards/', `/${kind}/`), 1000), imageBytes)
  }
  assert.deepEqual(calls.map(call => call.url), [source, target, source.replace('/cards/', '/relics/'), target.replace('/cards/', '/relics/')])
  assert.ok(calls.every(call => call.init.redirect === 'manual'))
})

test('supports all standard redirect statuses and relative Location values', async (t) => {
  for (const status of [301, 302, 303, 307, 308]) {
    await t.test(String(status), async (t) => {
      const { http, calls } = fixture(t, url => url === source
        ? new Response(null, { status, headers: { location: '/cards/bash.webp' } })
        : new Response(imageBytes))
      assert.deepEqual(await downloadImage(http, source, 1000), imageBytes)
      assert.equal(calls[1].url, 'https://spire-codex.com/cards/bash.webp')
    })
  }
})

test('does not send any request for unsafe initial URLs', async (t) => {
  const { http, calls } = fixture(t, () => {
    throw new Error('must not request')
  })
  for (const url of ['http://spire-codex.com/image.webp', 'file:///etc/passwd', 'https://example.invalid/image.webp']) {
    await assert.rejects(downloadImage(http, url, 1000), /Unsafe image URL/)
  }
  assert.equal(calls.length, 0)
})

test('rejects unsafe or malformed redirects before connecting and cancels their bodies', async (t) => {
  for (const location of ['http://cdn.spire-codex.com/image.webp', 'https://example.invalid/image.webp',
    '//cdn.spire-codex.com.example.invalid/image.webp', 'https://127.0.0.1/image.webp',
    'https://user:secret@cdn.spire-codex.com/image.webp', 'https://cdn.spire-codex.com:8443/image.webp',
    'file:///etc/passwd', 'https://[']) {
    await t.test(location, async (t) => {
      let cancelled = false
      const { http, calls } = fixture(t, () => new Response(new ReadableStream({
        cancel() { cancelled = true },
      }), { status: 302, headers: { location } }))
      await assert.rejects(downloadImage(http, source, 1000), /Unsafe image redirect/)
      assert.equal(calls.length, 1)
      assert.equal(cancelled, true)
    })
  }
})

test('revalidates every hop, not just the first redirect', async (t) => {
  const { http, calls } = fixture(t, url => new Response(null, {
    status: 302, headers: { location: url === source ? target : 'https://example.invalid/image.webp' },
  }))
  await assert.rejects(downloadImage(http, source, 1000), /Unsafe image redirect/)
  assert.deepEqual(calls.map(call => call.url), [source, target])
})

test('rejects missing Location values and stops redirect loops before a repeat request', async (t) => {
  let loop = false
  const { http, calls } = fixture(t, () => new Response(null, { status: 301, headers: loop ? { location: source } : {} }))
  await assert.rejects(downloadImage(http, source, 1000), /Image redirect missing Location/)
  loop = true
  await assert.rejects(downloadImage(http, source, 1000), /Image redirect loop/)
  assert.equal(calls.length, 2)
})

test('limits redirect chains while still allowing exactly the configured maximum', async (t) => {
  let respondWithImage = false
  let hops = 0
  const { http, calls } = fixture(t, () => {
    if (respondWithImage && hops === MAX_IMAGE_REDIRECTS) return new Response(imageBytes)
    return new Response(null, { status: 302, headers: { location: `/redirect/${++ hops}` } })
  })
  await assert.rejects(downloadImage(http, source, 1000), /Image redirect limit exceeded/)
  assert.equal(calls.length, MAX_IMAGE_REDIRECTS + 1)
  hops = 0
  respondWithImage = true
  assert.deepEqual(await downloadImage(http, source, 1000), imageBytes)
  assert.equal(calls.length, 2 * (MAX_IMAGE_REDIRECTS + 1))
})

test('shares one timeout budget between hops instead of restarting it on each redirect', async (t) => {
  let now = 1000
  t.mock.method(Date, 'now', () => now)
  const { http, calls } = fixture(t, (url) => {
    now += 600
    return new Response(null, { status: 301, headers: { location: url === source ? target : '/last.webp' } })
  })
  const timeouts: number[] = []
  const get = http.get.bind(http)
  t.mock.method(http, 'get', (url, config) => {
    timeouts.push(config.timeout)
    return get(url, config)
  })
  await assert.rejects(downloadImage(http, source, 1000), /Image request timed out/)
  assert.deepEqual(timeouts, [1000, 400])
  assert.equal(calls.length, 2)
})

test('does not follow redirects after plugin disposal and forwards cancellation to active fetches', async (t) => {
  const abort = new AbortController()
  const { http, calls } = fixture(t, (url, init) => {
    abort.abort()
    assert.equal(init.signal.aborted, true)
    return new Response(null, { status: 302, headers: { location: target } })
  })
  await assert.rejects(downloadImage(http, source, 1000, abort.signal), { name: 'AbortError' })
  assert.equal(calls.length, 1)
  await assert.rejects(downloadImage(http, source, 1000, abort.signal), { name: 'AbortError' })
  assert.equal(calls.length, 1)
})

test('rejects HTTP failures without reading their bodies and preserves Retry-After', async (t) => {
  let cancelled = false
  const { http } = fixture(t, () => new Response(new ReadableStream({
    cancel() { cancelled = true },
  }), { status: 429, headers: { 'retry-after': '120' } }))
  await assert.rejects(downloadImage(http, source, 1000), (error) => {
    assert.equal(describeImageError(error), 'ImageDownloadError: Unexpected image HTTP status: HTTP 429')
    assert.equal(retryDelay(error, Date.now()), 120_000)
    return true
  })
  assert.equal(cancelled, true)
})

test('still bounds image bytes after a redirect', async (t) => {
  let cancelled = false
  const { http } = fixture(t, url => url === source
    ? new Response(null, { status: 301, headers: { location: target } })
    : new Response(new ReadableStream({ cancel() { cancelled = true } }), {
        headers: { 'content-length': String(MAX_IMAGE_BYTES + 1) },
      }))
  await assert.rejects(downloadImage(http, source, 1000), /Image exceeds size limit/)
  assert.equal(cancelled, true)
})

test('reports nested network and disk error codes without leaking URLs, credentials, headers or paths', () => {
  const secret = 'test-secret-do-not-log'
  const cause = Object.assign(new Error(`connect https://user:${secret}@example.invalid/?key=${secret}`), { code: 'ECONNRESET' })
  const error = new Error(`fetch https://spire-codex.com/?apiKey=${secret} failed`, {
    cause: new TypeError('fetch failed', { cause }),
  })
  const summary = describeImageError(error)
  assert.equal(summary, 'Error -> TypeError: fetch failed -> Error: ECONNRESET')
  assert.doesNotMatch(summary, new RegExp(`${secret}|https|example|apiKey`))
  assert.equal(describeImageError(Object.assign(new Error(`open /private/${secret}`), { code: 'EACCES' })), 'Error: EACCES')
  assert.equal(describeImageError({ name: secret, message: secret, code: secret, response: { status: 404, data: secret } }), 'Error: HTTP 404')
  assert.equal(describeImageError(secret), 'unknown error')
})

test('summarizes AggregateError causes and terminates on cyclic error chains', () => {
  const error = new AggregateError([Object.assign(new Error('private address'), { code: 'ENETUNREACH' })], 'private message')
  error.cause = error
  assert.equal(describeImageError(error), 'AggregateError -> Error: ENETUNREACH')
})
