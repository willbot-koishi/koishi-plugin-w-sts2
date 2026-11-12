import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Context, h, Schema, Time, type Session } from 'koishi'
import { API_BASE, CatalogCache, type Channel } from './catalog'
import { canUpgrade, describe, entryImage, poolName } from './format'
import { parseChannel, search } from './search'
import { ImageCache, readImage } from './image-cache'
import { loadQuery, LookupCache } from './lookup'
import { preload, type PreloadProgress } from './preload'
import zhCN from './locales/zh-CN.yml'
import enUS from './locales/en-US.yml'

export const name = 'w-sts2'
export const inject = ['http']

export interface Config {
  defaultChannel: 'stable' | 'beta'
  cacheAge: number
  dataCacheDir: string
  timeout: number
  apiKey: string
  showImages: boolean
  imageCacheDir: string
  imageCacheAge: number
  maxResults: number
}

export const Config: Schema<Config> = Schema.object({
  defaultChannel: Schema.union(['stable', 'beta']).default('stable'),
  cacheAge: Schema.number().min(Time.minute).role('ms').default(Time.hour),
  dataCacheDir: Schema.string().default('cache/w-sts2/data'),
  timeout: Schema.number().min(1000).role('ms').default(30_000),
  apiKey: Schema.string().role('secret').default(''),
  showImages: Schema.boolean().default(true),
  imageCacheDir: Schema.string().default('cache/w-sts2/images'),
  imageCacheAge: Schema.number().min(Time.minute).role('ms').default(Time.day),
  maxResults: Schema.natural().min(1).max(30).default(10),
}).i18n({ 'zh-CN': zhCN._config, 'en-US': enUS._config })

export function apply(ctx: Context, config: Config) {
  ctx.i18n.define('zh-CN', zhCN)
  ctx.i18n.define('en-US', enUS)
  const logger = ctx.logger(name)
  const forward = (...elements: h[]) => h('message', { forward: true }, h('message', {}, elements))
  const translate = (session: Session) => (key: string, params?: Record<string, unknown>) => session.i18n(`sts2.${key}`, params)
    .map(element => element.toString(true)).join('')
  let job: PreloadProgress | undefined
  let disposed = false
  let nextDownload = 0
  const abort = new AbortController()
  ctx.on('dispose', () => {
    disposed = true
    abort.abort()
  })
  const images = new ImageCache(path.resolve(ctx.baseDir, config.imageCacheDir), config.imageCacheAge,
    async (url) => {
      if (job) {
        // At most four new image requests per second during bulk warming.
        const due = Math.max(Date.now(), nextDownload)
        nextDownload = due + 250
        await delay(Math.max(0, due - Date.now()), undefined, { signal: abort.signal })
      }
      return ctx.http.get<Buffer>(url, { responseType: readImage, timeout: config.timeout, redirect: 'error' })
    }, (operation, error) => {
      // Keep API credentials and HTTP request details out of logs.
      logger.warn('image cache %s failed (%s)', operation, error instanceof Error ? error.name : 'unknown error')
    })
  const request = (path: string, channel: Channel, search?: string) => ctx.http.get(`${API_BASE}${path}`, {
    params: { lang: 'zhs', ...(channel === 'beta' ? { channel } : {}), ...(search === undefined ? {} : { search }) },
    headers: config.apiKey ? { 'X-API-Key': config.apiKey } : {},
    timeout: config.timeout,
  })
  const onError = (channel: Channel, error: unknown) => {
    // Do not log HTTP config/errors: they can include the private API key.
    logger.warn('could not refresh %s catalog (%s)', channel, error instanceof Error ? error.name : 'unknown error')
  }
  const full = new CatalogCache(request, config.cacheAge, onError, Date.now, path.resolve(ctx.baseDir, config.dataCacheDir))
  const cache = new LookupCache(full, (channel, query, kind) => loadQuery(request, channel, query, kind), config.cacheAge, onError)

  for (const [command, kind] of [['sts2', undefined], ['sts2.card', 'card'], ['sts2.relic', 'relic']] as const) {
    // A greedy :text argument consumes trailing options. Variadic strings let
    // users put -c/-u after a multiword card name as well as before it.
    ctx.command(`${command} [...query:string]`)
      .option('channel', '-c <channel:string>')
      .option('upgrade', '-u')
      .option('index', '-i <index:posint>')
      .option('text', '-t')
      .action(async ({ session, options }, ...words) => {
        // Build plain text first, then escape exactly once with h.text().
        const t = translate(session)
        const query = words.join(' ').trim()
        if (! query) return h.text(t('missing-query'))
        const channel = parseChannel(options.channel ?? config.defaultChannel)
        if (! channel) return h.text(t('invalid-channel'))
        let result: Awaited<ReturnType<LookupCache['get']>>
        try {
          result = await cache.get(channel, query, kind)
        }
        catch {
          return h.text(t('unavailable', { channel: t(`channels.${channel}`) }))
        }
        const entries = search(result.catalog, query, kind)
        const lines = [t('source', { channel: t(`channels.${channel}`) })]
        if (result.stale) lines.push(t('stale', { time: new Date(result.catalog.fetchedAt).toISOString() }))
        const finish = (message: string) => h.text([...lines, message].join('\n'))
        if (! entries.length) return finish(t('not-found', { query }))
        if (options.index !== undefined && options.index > entries.length) return finish(t('invalid-index', { count: entries.length }))
        if (entries.length > 1 && options.index === undefined) {
          const list = entries.slice(0, config.maxResults).map((entry, index) => t('candidate', {
            index: index + 1, name: entry.name, id: entry.id, kind: t(entry.kind), pool: poolName(entry.pool, t),
          }))
          return forward(finish([t('multiple', { count: entries.length }), ...list,
            ...(entries.length > config.maxResults ? [t('truncated', { count: config.maxResults })] : []),
            t('select-hint')].join('\n')))
        }
        const entry = entries[(options.index ?? 1) - 1]
        if (options.upgrade && (entry.kind !== 'card' || ! canUpgrade(entry))) return finish(t('cannot-upgrade'))
        const upgraded = !! options.upgrade
        const image = config.showImages && ! options.text ? entryImage(entry, upgraded) : undefined
        const content = [finish(describe(entry, upgraded, t))]
        if (image) {
          const cached = await images.get(image, channel)
          if (cached) {
            if (cached.stale) content.push(h.text('\n' + t('image-stale')))
            // Send bytes, not a local file: adapters may run on another host.
            content.push(h.text('\n'), h.image(cached.data, cached.type))
          }
          else content.push(h.text('\n' + t('image-unavailable')))
        }
        return forward(...content)
      })
  }

  ctx.command('sts2.cache', { authority: 3 })
    .option('channel', '-c <channel:string>')
    .option('all', '-a')
    .option('text', '-t')
    .action(async ({ session, options }) => {
      const t = translate(session)
      const channel = parseChannel(options.channel ?? config.defaultChannel)
      if (! channel) return h.text(t('invalid-channel'))
      if (job) return h.text(t('cache-busy', { ...job, channel: t(`channels.${job.channel}`) }))
      const channels: Channel[] = options.all ? ['stable', 'beta'] : [channel]
      job = { channel: channels[0], done: 0, total: 0 }
      try {
        await session.send(h.text(t('cache-start', { channels: channels.map(channel => t(`channels.${channel}`)).join(' / ') })))
        const reports: string[] = []
        for (const channel of channels) {
          if (disposed) break
          job = { channel, done: 0, total: 0 }
          try {
            const result = await preload(full, images, channel, !! options.text, job, () => ! disposed)
            reports.push(t('cache-result', { ...result, channel: t(`channels.${channel}`) }))
            if (result.stale) reports.push(t('cache-stale', { channel: t(`channels.${channel}`) }))
          }
          catch {
            reports.push(t('cache-failed', { channel: t(`channels.${channel}`) }))
          }
        }
        if (! disposed) return h.text(reports.join('\n'))
      }
      finally {
        job = undefined
      }
    })
}
