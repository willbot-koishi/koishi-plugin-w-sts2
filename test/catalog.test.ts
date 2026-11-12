import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CatalogCache, imageURL, parseCatalog } from '../src/catalog'
import { canUpgrade, cardKeywords, describe, entryImage, plainText } from '../src/format'
import { parseChannel, search } from '../src/search'
import { card, relic } from './fixtures'

const translate = (key: string, params?: Record<string, unknown>) => `${key}${params ? ':' + Object.values(params).join(',') : ''}`

test('validates nonempty catalogs, identity and duplicate IDs without collapsing duplicate names', () => {
  assert.throws(() => parseCatalog('stable', [], [relic()]), /Invalid/)
  assert.throws(() => parseCatalog('stable', { detail: 'rate limited' }, [relic()]), /Invalid/)
  assert.throws(() => parseCatalog('stable', [card({ name: '' })], [relic()]), /Invalid/)
  assert.throws(() => parseCatalog('stable', [card(), card()], [relic()]), /Duplicate/)
  assert.throws(() => parseCatalog('stable', [card()], [relic(), relic()]), /Duplicate/)
  const catalog = parseCatalog('stable', [card(), card({ id: 'OTHER' })], [relic()])
  assert.equal(catalog.cards.length, 2)
})

test('uses Chinese full renders, resolves beta portraits and rejects unsafe image URLs', () => {
  assert.equal(imageURL('https://cdn.spire-codex.com/cards-full/beta/0.111.0/bash.webp', true),
    'https://cdn.spire-codex.com/cards-full/beta/0.111.0/zhs/bash.webp')
  assert.equal(imageURL('https://cdn.spire-codex.com/cards-full/stable/zhs/bash.webp', true),
    'https://cdn.spire-codex.com/cards-full/stable/zhs/bash.webp')
  assert.equal(imageURL('/static/images/beta/v0.111.0/relics/foo.webp'),
    'https://spire-codex.com/static/images/beta/v0.111.0/relics/foo.webp')
  for (const unsafe of ['file:///etc/passwd', 'http://spire-codex.com/foo', '//localhost/foo', 'https://attacker.invalid/foo', '']) {
    assert.equal(imageURL(unsafe), undefined)
  }
  const [entry] = parseCatalog('stable', [card({ image_url_card: null, image_url_card_upg: null })], [relic()]).cards
  assert.equal(entryImage(entry, false), 'https://spire-codex.com/static/images/cards/bash.webp')
  assert.equal(entryImage(entry, true), entry.image)
})

test('keeps keyword-only cards and handles cost-only upgrades with null descriptions', () => {
  const cards = [
    card({ id: 'WOUND', description: '', keywords: ['不能被打出'], keywords_key: ['Unplayable'], cost: - 1,
      upgrade: null, upgrade_description: null, image_url_card_upg: null }),
    card({ id: 'TUTOR', cost: 1, upgrade: { cost: 0 }, upgrade_description: null }),
  ]
  const [wound, tutor] = parseCatalog('beta', cards, [relic()]).cards
  assert.equal(canUpgrade(wound), false)
  assert.match(describe(wound, false, translate), /不能被打出/)
  assert.equal(canUpgrade(tutor), true)
  const result = describe(tutor, true, translate)
  assert.match(result, /cost:0/)
  assert.match(result, /造成8点伤害/)
})

test('updates keyword-only upgrades without mutating the base card', () => {
  const [entry] = parseCatalog('stable', [card({
    keywords: ['消耗', '虚无'], keywords_key: ['Exhaust', 'Ethereal'],
    upgrade: { remove_exhaust: 1, add_innate: 1 }, upgrade_description: null,
  })], [relic()]).cards
  assert.deepEqual(cardKeywords(entry, true), ['虚无', '固有'])
  assert.deepEqual(cardKeywords(entry, false), ['消耗', '虚无'])
})

test('formats X-energy, star costs and rich text without stripping literal brackets', () => {
  const [entry] = parseCatalog('stable', [card({ cost: - 1, is_x_cost: true, star_cost: 7, upgrade: { cost: 0 } })], [relic()]).cards
  assert.match(describe(entry, false, translate), /cost:X/)
  assert.match(describe(entry, false, translate), /star-cost:7/)
  assert.equal(plainText('[gold]获得[/gold][energy:2]和[star:1]。[literal]', translate), '获得energy:2和star:1。[literal]')
})

test('searches IDs, current and legacy names; exact matches win and same names stay ambiguous', () => {
  const catalog = parseCatalog('stable', [card(), card({ id: 'EXPERTISE', name: '独门技术' }),
    card({ id: 'BASH_OTHER', name: '痛击的伙伴' }), card({ id: 'STRIKE_IRONCLAD', name: '打击' }),
    card({ id: 'STRIKE_SILENT', name: '打击', color: 'silent' })], [relic()])
  assert.deepEqual(search(catalog, '专长').map(entry => entry.id), ['EXPERTISE'])
  assert.deepEqual(search(catalog, ' ｂａｓｈ ').map(entry => entry.id), ['BASH'])
  assert.deepEqual(search(catalog, '痛击').map(entry => entry.id), ['BASH'])
  assert.equal(search(catalog, '打击').length, 2)
  assert.equal(search(catalog, '燃烧').length, 1)
  assert.equal(search(catalog, '燃烧', 'card').length, 0)
  assert.equal(search(catalog, '  ').length, 0)
  assert.equal(parseChannel('BETA'), 'beta')
  assert.equal(parseChannel('正式版'), 'stable')
  assert.equal(parseChannel('invalid'), undefined)
})

test('coalesces concurrent requests and keeps stable and beta snapshots independent', async () => {
  let now = 1000
  let calls = 0
  const cache = new CatalogCache(async (path, channel) => {
    calls ++
    return path === '/api/cards' ? [card({ description: channel })] : [relic()]
  }, 100, () => assert.fail('unexpected failure'), () => now)
  const results = await Promise.all([cache.refresh('stable'), cache.refresh('stable'), cache.refresh('beta')])
  assert.equal(calls, 4)
  assert.equal(results[0].catalog, results[1].catalog)
  assert.equal(results[0].catalog.cards[0].description, 'stable')
  assert.equal(results[2].catalog.cards[0].description, 'beta')
  await cache.refresh('stable')
  assert.equal(calls, 4)
  now += 101
  await cache.refresh('stable')
  assert.equal(calls, 6)
})

test('retains only a last-good same-channel snapshot and backs off failed refreshes', async () => {
  let now = 1000
  let fail = false
  let calls = 0
  let logged = 0
  const cache = new CatalogCache(async (path, channel) => {
    calls ++
    if (fail || channel === 'beta') throw new Error('offline')
    return path === '/api/cards' ? [card()] : [relic()]
  }, 100, () => logged ++, () => now)
  const first = await cache.refresh('stable')
  fail = true
  now += 101
  const stale = await cache.refresh('stable')
  assert.equal(stale.catalog, first.catalog)
  assert.equal(stale.stale, true)
  await cache.refresh('stable')
  assert.equal(calls, 4)
  assert.equal(logged, 1)
  await assert.rejects(cache.refresh('beta'), /offline/)
  await assert.rejects(cache.refresh('beta'), /offline/)
  assert.equal(calls, 6)
  now += 60_001
  fail = false
  assert.equal((await cache.refresh('stable')).stale, false)
  assert.equal(calls, 8)
})

test('honors Retry-After before retrying a failed initial load', async () => {
  let now = 1000
  let calls = 0
  const error = Object.assign(new Error('429'), { response: { headers: new Headers({ 'retry-after': '120' }) } })
  const cache = new CatalogCache(async () => {
    calls ++
    throw error
  }, 100, () => {}, () => now)
  await assert.rejects(cache.refresh('stable'), /429/)
  now += 61_000
  await assert.rejects(cache.refresh('stable'), /429/)
  assert.equal(calls, 2)
  now += 60_000
  await assert.rejects(cache.refresh('stable'), /429/)
  assert.equal(calls, 4)
})

test('an invalid refresh cannot replace a good snapshot', async () => {
  let now = 1000
  let invalid = false
  const cache = new CatalogCache(async path => path === '/api/cards' ? [card()] : invalid ? [] : [relic()], 100, () => {}, () => now)
  const first = await cache.refresh('stable')
  invalid = true
  now += 101
  const result = await cache.refresh('stable')
  assert.equal(result.catalog, first.catalog)
  assert.equal(result.stale, true)
})

test('keeps a failed batch in flight until its other request also settles', async () => {
  let calls = 0
  let release: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const cache = new CatalogCache(async (path) => {
    calls ++
    if (path === '/api/cards') throw new Error('cards unavailable')
    await gate
    return [relic()]
  }, 100, () => {})
  const first = assert.rejects(cache.refresh('stable'), /cards unavailable/)
  // Give the early rejection a chance to be processed before another query.
  await new Promise(resolve => setImmediate(resolve))
  const second = assert.rejects(cache.refresh('stable'), /cards unavailable/)
  assert.equal(calls, 2)
  release()
  await Promise.all([first, second])
  assert.equal(calls, 2)
})

test('reads full snapshots without network requests and persists them across cache instances', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'w-sts2-full-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  let calls = 0
  const create = () => new CatalogCache(async (path) => {
    calls ++
    return path === '/api/cards' ? [card()] : [relic()]
  }, 1000, () => assert.fail('unexpected snapshot failure'), () => 1000, directory)
  const cache = create()
  assert.equal(await cache.read('stable'), undefined)
  assert.equal(calls, 0)
  await cache.refresh('stable')
  assert.equal(calls, 2)
  assert.equal((await create().read('stable')).catalog.cards[0].id, 'BASH')
  assert.equal(await create().read('beta'), undefined)
  assert.equal(calls, 2)
  assert.deepEqual(await readdir(directory), ['stable.json'])
  assert.equal(JSON.parse(await readFile(path.join(directory, 'stable.json'), 'utf8')).fetchedAt, 1000)
})

test('rejects corrupted or wrong-channel snapshots without silently downloading everything', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'w-sts2-full-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  let errors = 0
  const cache = new CatalogCache(async () => assert.fail('must remain read-only'), 1000, () => errors ++, () => 1000, directory)
  await writeFile(path.join(directory, 'stable.json'), JSON.stringify({
    version: 1, channel: 'beta', fetchedAt: 1000, cards: [card()], relics: [relic()],
  }))
  await writeFile(path.join(directory, 'beta.json'), 'broken JSON')
  assert.equal(await cache.read('stable'), undefined)
  assert.equal(await cache.read('beta'), undefined)
  assert.equal(errors, 2)
})
