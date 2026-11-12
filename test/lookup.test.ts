import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CatalogCache, parseCatalog } from '../src/catalog'
import { loadQuery, LookupCache } from '../src/lookup'
import { search } from '../src/search'
import { card, relic } from './fixtures'

test('uses exact ID endpoints and permits empty filtered results without full-table fallback', async () => {
  const calls: Array<{ path: string, query?: string }> = []
  const request = async (path: string, _channel: string, query?: string) => {
    calls.push({ path, query })
    if (path.endsWith('/BASH')) return card()
    if (path.split('/').length > 3) throw Object.assign(new Error('not found'), { response: { status: 404 } })
    assert.ok(query, 'ordinary list requests must have a nonempty filter')
    return []
  }
  const exact = await loadQuery(request, 'stable', 'ｂａｓｈ', 'card')
  assert.equal(exact.cards[0].id, 'BASH')
  assert.deepEqual(calls, [{ path: '/api/cards/BASH', query: undefined }])
  const empty = await loadQuery(request, 'stable', '不存在的名称')
  assert.equal(empty.cards.length + empty.relics.length, 0)
  await assert.rejects(loadQuery(request, 'stable', '  '), /Empty/)
})

test('resolves legacy names through individual IDs and ignores deleted aliases', async () => {
  const calls: string[] = []
  const request = async (path: string, _channel: string, query?: string) => {
    calls.push(path)
    if (path === '/api/cards/EXPERTISE') return card({ id: 'EXPERTISE', name: '独门技术' })
    if (path.split('/').length > 3) throw Object.assign(new Error('deleted'), { response: { status: 404 } })
    assert.ok(query)
    return []
  }
  const legacy = await loadQuery(request, 'stable', '专长', 'card')
  assert.equal(search(legacy, '专长')[0].id, 'EXPERTISE')
  assert.deepEqual(calls, ['/api/cards', '/api/cards/EXPERTISE'])
  assert.equal((await loadQuery(request, 'stable', '跟进', 'card')).cards.length, 0)
})

test('rejects ID mismatches and malformed query responses instead of caching them', async () => {
  await assert.rejects(loadQuery(async () => card({ id: 'OTHER' }), 'stable', 'BASH', 'card'), /mismatch/)
  await assert.rejects(loadQuery(async () => ({ detail: 'error' }), 'stable', '痛击', 'card'), /Invalid/)
})

test('ordinary lookups never refresh a whole catalog and reuse just their own query results', async () => {
  const full = new CatalogCache(async () => assert.fail('ordinary lookup downloaded full catalog'), 1000, () => {})
  let calls = 0
  const cache = new LookupCache(full, async (channel, query) => {
    calls ++
    return { ...parseCatalog(channel, [card()], [relic()]), cards: query === 'empty' ? [] : [parseCatalog(channel, [card()], [relic()]).cards[0]], relics: [] }
  }, 1000, () => {})
  await cache.get('stable', 'BASH', 'card')
  await cache.get('stable', 'ｂａｓｈ', 'card')
  assert.equal(calls, 1)
  assert.equal((await cache.get('stable', 'empty', 'card')).catalog.cards.length, 0)
  await cache.get('stable', 'empty', 'card')
  assert.equal(calls, 2)
  assert.equal(await full.read('stable'), undefined)
})

test('uses a fresh full snapshot, then only queries the requested term when it expires', async () => {
  let now = 1000
  let bulkCalls = 0
  let queries = 0
  const full = new CatalogCache(async (path) => {
    bulkCalls ++
    return path === '/api/cards' ? [card()] : [relic()]
  }, 100, () => {}, () => now)
  await full.refresh('stable')
  const cache = new LookupCache(full, async (channel) => {
    queries ++
    return parseCatalog(channel, [card()], [relic()], now)
  }, 100, () => {}, () => now)
  await cache.get('stable', 'BASH', 'card')
  assert.equal(queries, 0)
  now += 101
  await cache.get('stable', 'BASH', 'card')
  assert.equal(queries, 1)
  assert.equal(bulkCalls, 2)
  assert.equal((await full.read('stable')).stale, true)
})

test('coalesces concurrent identical lookups and backs off failures without leaking other results', async () => {
  let now = 1000
  let calls = 0
  let fail = false
  const full = new CatalogCache(async () => assert.fail('must not bulk load'), 100, () => {})
  const cache = new LookupCache(full, async (channel) => {
    calls ++
    if (fail) throw new Error('offline')
    return parseCatalog(channel, [card()], [relic()], now)
  }, 100, () => {}, () => now)
  const [first, second] = await Promise.all([cache.get('stable', 'BASH'), cache.get('stable', 'BASH')])
  assert.equal(calls, 1)
  assert.equal(first.catalog, second.catalog)
  now += 101
  fail = true
  assert.equal((await cache.get('stable', 'BASH')).stale, true)
  await assert.rejects(cache.get('stable', 'other query'), /offline/)
  assert.equal(calls, 2)
  await assert.rejects(cache.get('beta', 'BASH'), /offline/)
  assert.equal(calls, 3)
})

test('falls back to a stale full snapshot without refreshing it when a targeted request fails', async () => {
  let now = 1000
  let bulkCalls = 0
  const full = new CatalogCache(async (path) => {
    bulkCalls ++
    return path === '/api/cards' ? [card()] : [relic()]
  }, 100, () => {}, () => now)
  await full.refresh('stable')
  now += 101
  const cache = new LookupCache(full, async () => {
    throw new Error('offline')
  }, 100, () => {}, () => now)
  assert.equal((await cache.get('stable', 'BASH')).stale, true)
  assert.equal(bulkCalls, 2)
})
