import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CatalogCache, parseCatalog } from '../src/catalog'
import type { ImageCache } from '../src/image-cache'
import { preload, type PreloadProgress } from '../src/preload'
import { card, imageBytes, relic } from './fixtures'

test('bulk image preloading deduplicates sources, bounds concurrency and counts unusable disk results', async () => {
  const catalog = parseCatalog('stable', [card(), card({ id: 'OTHER', image_url: '/static/other.webp' })], [relic()])
  const full = { refresh: async () => ({ catalog, stale: false }) } as unknown as CatalogCache
  let running = 0
  let maxRunning = 0
  let calls = 0
  const images = { get: async () => {
    const index = calls ++
    running ++
    maxRunning = Math.max(maxRunning, running)
    await new Promise(resolve => setImmediate(resolve))
    running --
    return { data: imageBytes, type: 'image/png', stale: index === 1, persisted: index !== 2 }
  } } as unknown as ImageCache
  const progress: PreloadProgress = { channel: 'stable', done: 0, total: 0 }
  const result = await preload(full, images, 'stable', false, progress, () => true)
  assert.equal(calls, 5)
  assert.equal(maxRunning, 3)
  assert.equal(result.success, 3)
  assert.equal(result.failed, 2)
  assert.equal(progress.done, 5)
})

test('text-only caching never schedules images, and stopped jobs schedule no new work', async () => {
  const full = new CatalogCache(async path => path === '/api/cards' ? [card()] : [relic()], 1000, () => {})
  const images = { get: async () => assert.fail('unexpected image download') } as unknown as ImageCache
  const progress: PreloadProgress = { channel: 'stable', done: 0, total: 0 }
  assert.equal((await preload(full, images, 'stable', true, progress, () => true)).total, 0)
  assert.equal((await preload(full, images, 'stable', false, progress, () => false)).done, 0)
})
