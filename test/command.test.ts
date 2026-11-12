import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { mkdtemp, readFile, readdir, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Context, h, type Plugin } from 'koishi'
import memory from '@koishijs/plugin-database-memory'
import Mock from '@koishijs/plugin-mock'
import * as sts2 from '../src'
import { card, imageBytes, relic } from './fixtures'

const fixtures: Array<{ ctx: Context, mock: { dispose(): boolean }, directory: string }> = []

afterEach(async () => {
  for (const { ctx, mock, directory } of fixtures.splice(0)) {
    mock.dispose()
    await ctx.stop()
    await rm(directory, { recursive: true, force: true })
  }
})

async function fixture(config: Partial<sts2.Config> = {}, locale = 'zh-CN', fail = false,
  requestImage: (url: string) => Promise<Uint8Array | Response> = async () => imageBytes) {
  const ctx = new Context()
  const directory = await mkdtemp(path.join(tmpdir(), 'w-sts2-command-'))
  ctx.baseDir = directory
  const calls: Array<{ url: string, config: any }> = []
  const imageCalls: Array<{ url: string, config: any }> = []
  const sent: h[][] = []
  ctx.set('http', {
    async get(url: string, config: any) {
      if (! url.includes('/api/')) {
        imageCalls.push({ url, config })
        const result = await requestImage(url)
        return config.responseType(result instanceof Response ? result : new Response(Buffer.from(result)))
      }
      calls.push({ url, config })
      if (fail) throw new Error('offline')
      const cards = [card({ description: config.params.channel === 'beta' ? '测试版效果。' : '正式版效果。' }),
        card({ id: 'EXPERTISE', name: '独门技术', color: 'silent' }),
        card({ id: 'STRIKE_IRONCLAD', name: '打击' }), card({ id: 'STRIKE_SILENT', name: '打击', color: 'silent' }),
        card({ id: 'NO_UPGRADE', name: '不可升级', upgrade: null, upgrade_description: null, image_url_card_upg: null }),
        card({ id: 'INJECT', name: '<at id="all"/>', description: '<image src="file:///etc/passwd"/>' }),
        card({ id: 'MULTIWORD', name: '有 空格的名称' })]
      const route = new URL(url).pathname
      const rows = route.startsWith('/api/relics') ? [relic()] : cards
      const id = route.split('/')[3]
      if (id) {
        const row = rows.find(row => row.id === decodeURIComponent(id).toUpperCase())
        if (! row) throw Object.assign(new Error('not found'), { response: { status: 404 } })
        return row
      }
      if (config.params.search !== undefined) {
        return rows.filter(row => config.params.search.toLowerCase().split(/\s+/)
          .every((word: string) => `${row.name} ${row.description}`.toLowerCase().includes(word)))
      }
      return rows
    },
  } as unknown as Context['http'])
  ctx.plugin(memory)
  const mock = ctx.plugin(Mock as Plugin.Constructor)
  const plugin = ctx.plugin(sts2, config)
  ctx.on('before-send', (session) => {
    sent.push(session.elements)
  })
  fixtures.push({ ctx, mock, directory })
  await ctx.start()
  await ctx.mock.initUser('user', 1, { locales: [locale] })
  await ctx.mock.initUser('admin', 3, { locales: [locale] })
  return { ctx, plugin, client: ctx.mock.client('user'), admin: ctx.mock.client('admin'), calls, imageCalls, sent, directory }
}

test('sends card and relic details as one forward node, including upgrades and text-only queries', async () => {
  const { client, sent } = await fixture()
  const queries = [
    ['sts2 BASH', /痛击 \[BASH\]/, true],
    ['sts2.card BASH -u', /痛击\+ \[BASH\]/, true],
    ['sts2.card BASH -t', /痛击 \[BASH\]/, false],
    ['sts2.relic 燃烧之血', /燃烧之血 \[BURNING_BLOOD\]/, true],
    ['sts2.card 打击 -i 2', /打击 \[STRIKE_SILENT\]/, true],
  ] as const
  for (const [query, title, image] of queries) {
    const count = sent.length
    assert.equal((await client.receive(query)).length, 1)
    assert.equal(sent.length, count + 1)
    const elements = sent[count]
    assert.equal(elements.length, 1)
    const [forward] = elements
    assert.equal(forward.type, 'message')
    assert.equal(forward.attrs.forward, true)
    assert.equal(forward.children.length, 1)
    const [node] = forward.children
    assert.equal(node.type, 'message')
    assert.match(node.toString(true), /Spire Codex · 正式版/)
    assert.match(node.toString(true), title)
    assert.equal(h.select(node.children, 'img').length, image ? 1 : 0)
  }
})

test('keeps candidates, source and selection hints inside one text-only forward', async () => {
  const { client, sent } = await fixture({ maxResults: 1 })
  await client.receive('sts2.card 打击')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].length, 1)
  const [forward] = sent[0]
  assert.equal(forward.type, 'message')
  assert.equal(forward.attrs.forward, true)
  assert.equal(forward.children.length, 1)
  assert.equal(forward.children[0].type, 'message')
  assert.match(forward.children[0].toString(true), /Spire Codex · 正式版[\s\S]*找到 2 个结果：[\s\S]*1\. 打击 · 铁甲战士[\s\S]*仅显示前 1 项[\s\S]*请追加 -i 序号/)
  assert.doesNotMatch(forward.toString(true), /STRIKE_SILENT/)
  assert.equal(h.select(forward.children, 'img').length, 0)
})

test('keeps validation, no-match and network-error replies as ordinary messages', async () => {
  const { client, sent } = await fixture()
  for (const query of ['sts2', 'sts2 BASH -c invalid', 'sts2.relic BASH', 'sts2.card 打击 -i 3', 'sts2.relic 燃烧之血 -u']) {
    await client.receive(query)
    assert.equal(h.select(sent[sent.length - 1], 'message').length, 0)
  }
  const offline = await fixture({}, 'zh-CN', true)
  await offline.client.receive('sts2 BASH')
  assert.equal(h.select(offline.sent[0], 'message').length, 0)
})

test('queries cards, relics and legacy names; sends Chinese full-card images', async () => {
  const { client, calls, imageCalls } = await fixture()
  await client.shouldReply('sts2.card BASH', /痛击 \[BASH\][\s\S]*正式版效果。[\s\S]*data:image\/png;base64/)
  await client.shouldReply('sts2.relic 燃烧之血', /燃烧之血 \[BURNING_BLOOD\][\s\S]*回复6点生命/)
  await client.shouldReply('sts2 专长 -t', /独门技术 \[EXPERTISE\]/)
  assert.equal(calls.length, 5)
  assert.equal(calls[0].config.params.lang, 'zhs')
  assert.equal(calls[0].config.params.channel, undefined)
  assert.match(imageCalls[0].url, /cards-full\/stable\/zhs\/bash.webp$/)
})

test('switches channels per query and honors a beta default', async () => {
  const { client, calls } = await fixture({ defaultChannel: 'beta', showImages: false })
  await client.shouldReply('sts2.card BASH', /测试版（beta）[\s\S]*测试版效果/)
  await client.shouldReply('sts2.card BASH -c stable', /正式版[\s\S]*正式版效果/)
  await client.shouldReply('sts2.card BASH -c BETA', /测试版效果/)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].config.params.channel, 'beta')
})

test('disambiguates same-name cards with stable numbered results and validates selection', async () => {
  const { client } = await fixture({ showImages: false })
  await client.shouldReply('sts2.card 打击', /找到 2 个结果：[\s\S]*1\. 打击 · 铁甲战士[\s\S]*2\. 打击 · 静默猎手/)
  await client.shouldReply('sts2.card 打击 -i 2', /打击 \[STRIKE_SILENT\]/)
  await client.shouldReply('sts2.card 打击 -i 3', /序号超出范围/)
  await client.shouldReply('sts2.card 打击 -i 0', /选项 index 输入无效/)
})

test('shows upgraded effects and images, supports text only, and rejects unavailable upgrades', async () => {
  const { client, imageCalls } = await fixture()
  await client.shouldReply('sts2.card BASH -u', /痛击\+ \[BASH\][\s\S]*造成10点伤害。[\s\S]*data:image\/png;base64/)
  assert.match(imageCalls[0].url, /bash_upg.webp$/)
  const [reply] = await client.receive('sts2.card BASH -t', 1)
  assert.doesNotMatch(reply, /<img|<image|webp/)
  await client.shouldReply('sts2.card NO_UPGRADE -u', /没有可查询的升级版本/)
  await client.shouldReply('sts2.relic 燃烧之血 -u', /没有可查询的升级版本/)
  assert.equal(imageCalls.length, 1)
})

test('reuses image bytes across repeated lookups and sends no CDN credentials or local paths', async () => {
  const { client, imageCalls, sent, directory } = await fixture({ apiKey: 'test-only-key' })
  await client.receive('sts2.card BASH')
  await client.receive('sts2.card BASH')
  assert.equal(imageCalls.length, 1)
  assert.equal(imageCalls[0].config.headers, undefined)
  assert.equal(imageCalls[0].config.redirect, 'manual')
  const [image] = h.select(sent[0], 'img')
  assert.equal(image.attrs.src, `data:image/png;base64,${imageBytes.toString('base64')}`)
  assert.doesNotMatch(sent[0].join(''), new RegExp(directory))
  assert.doesNotMatch(sent[0].join(''), /test-only-key|https:\/\/cdn/)
})

test('follows relic redirects without forwarding API credentials and caches bytes under the original URL', async () => {
  const source = 'https://spire-codex.com/static/images/relics/burning_blood.webp'
  const target = 'https://cdn.spire-codex.com/relics/burning_blood.webp'
  const { client, imageCalls, sent } = await fixture({ apiKey: 'test-only-key' }, 'zh-CN', false, async url => url === source
    ? new Response(null, { status: 301, headers: { location: target } })
    : imageBytes)
  await client.shouldReply('sts2.relic 燃烧之血', /data:image\/png;base64/)
  await client.shouldReply('sts2.relic 燃烧之血', /data:image\/png;base64/)
  assert.deepEqual(imageCalls.map(call => call.url), [source, target])
  assert.ok(imageCalls.every(call => call.config.headers === undefined && call.config.redirect === 'manual'))
  assert.doesNotMatch(sent.map(elements => elements.join('')).join(''), /test-only-key|https:\/\//)
})

test('keeps channels and normal/upgraded images separate and skips disabled images', async () => {
  const { client, imageCalls } = await fixture()
  await client.receive('sts2 BASH')
  await client.receive('sts2 BASH -u')
  await client.receive('sts2 BASH -c beta')
  await client.receive('sts2 BASH -c beta')
  await client.receive('sts2 BASH -t')
  await client.receive('sts2.card 打击')
  assert.equal(imageCalls.length, 3)
  const text = await fixture({ showImages: false })
  await text.client.receive('sts2 BASH')
  assert.equal(text.imageCalls.length, 0)
})

test('falls back to text on image failures without retry storms, including English feedback', async () => {
  for (const locale of ['zh-CN', 'en-US']) {
    const { client, imageCalls, sent } = await fixture({}, locale, false, async () => {
      throw new Error('offline')
    })
    await client.shouldReply('sts2 BASH', locale === 'zh-CN' ? /图片暂时无法加载/ : /Image unavailable/)
    await client.receive('sts2 BASH')
    assert.equal(imageCalls.length, 1)
    assert.equal(h.select(sent[0], 'img').length, 0)
    assert.equal(sent[0][0].attrs.forward, true)
    assert.match(sent[0].join(''), /痛击/)
  }
})

test('warns when an image refresh fails while still sending the previously cached bytes', async () => {
  let fail = false
  const { client, directory, imageCalls, sent } = await fixture({}, 'zh-CN', false, async () => {
    if (fail) throw new Error('offline')
    return imageBytes
  })
  await client.receive('sts2 BASH')
  const cacheDir = path.join(directory, 'cache/w-sts2/images')
  const [filename] = await readdir(cacheDir)
  const old = (Date.now() - 2 * 24 * 60 * 60 * 1000) / 1000
  await utimes(path.join(cacheDir, filename), old, old)
  fail = true
  await client.shouldReply('sts2 BASH', /图片刷新失败，使用已缓存的图片/)
  const [image] = h.select(sent[1], 'img')
  assert.equal(image.attrs.src, `data:image/png;base64,${imageBytes.toString('base64')}`)
  await client.receive('sts2 BASH')
  assert.equal(imageCalls.length, 2)
})

test('handles missing queries, invalid channels and no matches without unnecessary requests', async () => {
  const { client, calls } = await fixture()
  await client.shouldReply('sts2', /请输入名称/)
  await client.shouldReply('sts2.card BASH -c unknown', /无效的分支/)
  assert.equal(calls.length, 0)
  await client.shouldReply('sts2.relic BASH', /没有找到/)
  assert.equal(calls.length, 2)
})

test('uses a friendly network error and backs off repeated failures', async () => {
  const { client, calls } = await fixture({}, 'zh-CN', true)
  await client.shouldReply('sts2.card BASH', /正式版数据暂时无法获取/)
  await client.shouldReply('sts2.card BASH', /正式版数据暂时无法获取/)
  assert.equal(calls.length, 1)
})

test('passes optional API credentials only as a request header', async () => {
  const { client, calls } = await fixture({ apiKey: 'test-only-key', showImages: false })
  await client.shouldReply('sts2 BASH', /痛击/)
  assert.equal(calls[0].config.headers['X-API-Key'], 'test-only-key')
  assert.doesNotMatch(calls[0].url, /test-only-key/)
})

test('escapes provider content so it cannot become message elements', async () => {
  const { client, ctx } = await fixture({ showImages: false })
  let inspected = false
  ctx.on('before-send', (session) => {
    inspected = true
    assert.equal(h.select(session.elements, 'at,img,image').length, 0)
    assert.match(session.content, /&lt;image/)
  })
  const [reply] = await client.receive('sts2.card INJECT', 1)
  assert.match(reply, /<at id="all"\/>/)
  assert.equal(inspected, true)
})

test('localizes commands, errors and configuration (game content stays Chinese)', async () => {
  const { client, ctx } = await fixture({ showImages: false }, 'en-US')
  await client.shouldReply('sts2.card BASH -c invalid', 'Invalid channel. Use -c stable or -c beta.')
  await client.shouldReply('sts2.card BASH', /Stable[\s\S]*Energy: 2/)
  const session = ctx.mock.session({})
  session.locales = ['en-US']
  assert.equal(session.text('commands.sts2.card.description'), 'Look up Slay the Spire 2 cards')
  for (const field of Object.values(sts2.Config.dict)) assert.ok(field.meta.description['en-US'])
})

test('parses long options on either side of multiword names and limits candidate lists', async () => {
  const { client } = await fixture({ maxResults: 1 })
  await client.shouldReply('sts2.card --channel beta BASH --text', /测试版效果/)
  await client.shouldReply('sts2.card 有 空格的名称 --text --channel beta', /测试版（beta）[\s\S]*有 空格的名称 \[MULTIWORD\]/)
  await client.shouldReply('sts2.card 打击 --text', /找到 2 个结果：[\s\S]*仅显示前 1 项/)
  await client.shouldReply('sts2.card --index 2 打击 --text', /STRIKE_SILENT/)
  await client.shouldReply('sts2.card BASH --upgrade --text', /痛击\+/)
})

test('ordinary queries use only exact or filtered requests and never create full snapshots', async () => {
  const { client, calls, directory } = await fixture({ showImages: false })
  await client.receive('sts2.card BASH')
  await client.receive('sts2.relic 燃烧之血')
  assert.ok(calls.every(call => new URL(call.url).pathname.split('/').length > 3 || !! call.config.params.search))
  assert.equal(calls[0].url, 'https://spire-codex.com/api/cards/BASH')
  await assert.rejects(readdir(path.join(directory, 'cache/w-sts2/data')), { code: 'ENOENT' })
})

test('requires authority 3 before starting a bulk cache and validates its channel', async () => {
  const { ctx, client, admin, calls, imageCalls } = await fixture()
  assert.equal(ctx.$commander.get('sts2.cache').config.authority, 3)
  await client.receive('sts2.cache')
  assert.equal(calls.length, 0)
  assert.equal(imageCalls.length, 0)
  await admin.shouldReply('sts2.cache -c invalid', /无效的分支/)
  assert.equal(calls.length, 0)
})

test('bulk text caching saves both channels and ordinary lookups reuse their snapshots after reload', async () => {
  const { ctx, plugin, client, admin, calls, imageCalls, directory } = await fixture()
  const replies = await admin.receive('sts2.cache -a -t')
  assert.equal(replies.length, 2)
  assert.match(replies[0], /开始全量缓存/)
  assert.match(replies[1], /正式版缓存完成[\s\S]*测试版（beta）缓存完成/)
  assert.equal(calls.length, 4)
  assert.ok(calls.every(call => call.config.params.search === undefined))
  assert.equal(imageCalls.length, 0)
  const folder = path.join(directory, 'cache/w-sts2/data')
  assert.deepEqual((await readdir(folder)).sort(), ['beta.json', 'stable.json'])
  assert.equal(JSON.parse(await readFile(path.join(folder, 'beta.json'), 'utf8')).channel, 'beta')
  plugin.dispose()
  ctx.plugin(sts2)
  await ctx.lifecycle.flush()
  await client.shouldReply('sts2 BASH -t', /正式版效果/)
  await client.shouldReply('sts2 BASH -t -c beta', /测试版效果/)
  assert.equal(calls.length, 4)
})

test('bulk caching warms all distinct images, including upgrades, and reports partial failures', async () => {
  const { admin, client, calls, imageCalls } = await fixture({}, 'zh-CN', false, async (url) => {
    if (url.endsWith('bash_upg.webp')) throw new Error('image unavailable')
    return imageBytes
  })
  const replies = await admin.receive('sts2.cache')
  assert.match(replies[1], /图片有效 3\/4，失败 1/)
  assert.equal(imageCalls.length, 4)
  assert.equal(calls.length, 2)
  await client.receive('sts2 BASH')
  assert.equal(calls.length, 2)
  assert.equal(imageCalls.length, 4)
  await admin.receive('sts2.cache')
  assert.equal(imageCalls.length, 4)
})

test('a duplicate bulk command returns progress instead of starting a second job', async () => {
  let release: () => void
  let started: () => void
  let finished: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const firstImage = new Promise<void>((resolve) => {
    started = resolve
  })
  const complete = new Promise<void>((resolve) => {
    finished = resolve
  })
  const { admin, ctx, calls } = await fixture({}, 'zh-CN', false, async () => {
    started()
    await gate
    return imageBytes
  })
  ctx.on('before-send', (session) => {
    if (session.content.includes('缓存完成')) finished()
  })
  await admin.receive('sts2.cache', 1)
  await firstImage
  try {
    const [busy] = await admin.receive('sts2.cache', 1)
    assert.match(busy, /已有全量缓存任务正在运行[\s\S]*0\/4/)
    assert.equal(calls.length, 2)
  }
  finally {
    release()
    await complete
  }
})

test('bulk cache errors remain friendly and localized instead of claiming success', async () => {
  const { admin } = await fixture({}, 'en-US', true)
  const replies = await admin.receive('sts2.cache -t')
  assert.match(replies[1], /could not be fetched or saved/)
  assert.doesNotMatch(replies[1], /cache finished/)
})
