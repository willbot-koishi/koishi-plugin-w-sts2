import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const API_BASE = 'https://spire-codex.com'

export type Channel = 'stable' | 'beta'
export type Kind = 'card' | 'relic'

interface Entity {
  id: string
  name: string
  description: string
  rarity: string
  pool: string
  image?: string
}

export interface Card extends Entity {
  kind: 'card'
  type: string
  cost: number | null
  xCost: boolean
  starCost: number | null
  xStarCost: boolean
  keywords: string[]
  keywordKeys: string[]
  upgrade: Record<string, number | string>
  upgradeDescription: string | null
  cardImage?: string
  upgradedImage?: string
}

export interface Relic extends Entity {
  kind: 'relic'
}

export type Entry = Card | Relic

export interface Catalog {
  channel: Channel
  fetchedAt: number
  cards: Card[]
  relics: Relic[]
}

function record(value: unknown): value is Record<string, unknown> {
  return !! value && typeof value === 'object' && ! Array.isArray(value)
}

function text(value: unknown) {
  return typeof value === 'string' ? value : ''
}

function number(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

// Only provider-owned HTTPS images may be downloaded.
export function imageURL(value: unknown, localized = false) {
  if (typeof value !== 'string' || ! value) return
  try {
    const url = new URL(value, API_BASE)
    if (url.protocol !== 'https:' || ! ['spire-codex.com', 'cdn.spire-codex.com'].includes(url.hostname)) return
    if (url.username || url.password || url.port) return
    // The API's full renders default to English even with lang=zhs. Portraits
    // and beta_image_url (alternate art, NOT the beta channel) are different.
    if (localized && url.hostname === 'cdn.spire-codex.com' && url.pathname.startsWith('/cards-full/')) {
      const slash = url.pathname.lastIndexOf('/')
      if (! url.pathname.slice(0, slash).endsWith('/zhs')) {
        url.pathname = `${url.pathname.slice(0, slash)}/zhs${url.pathname.slice(slash)}`
      }
    }
    return url.href
  }
  catch {
    return
  }
}

export function parseEntries(channel: Channel, kind: Kind, rows: unknown, allowEmpty = true): Entry[] {
  if (! Array.isArray(rows) || (! allowEmpty && ! rows.length)) throw new Error(`Invalid ${channel} ${kind} catalog`)
  const ids = new Set<string>()
  return rows.map((row) => {
    if (! record(row) || ! text(row.id).trim() || ! text(row.name).trim() || typeof row.description !== 'string') {
      throw new Error(`Invalid ${channel} ${kind} entry`)
    }
    const id = row.id as string
    if (ids.has(id)) throw new Error(`Duplicate ${channel} ${kind} ID: ${id}`)
    ids.add(id)
    const entity: Entity = {
      id, name: row.name as string, description: row.description,
      rarity: text(row.rarity), pool: text(kind === 'card' ? row.color : row.pool),
      image: imageURL(row.image_url),
    }
    if (kind === 'relic') return { ...entity, kind }
    const upgrade: Card['upgrade'] = {}
    if (record(row.upgrade)) {
      for (const [key, value] of Object.entries(row.upgrade)) {
        if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) upgrade[key] = value
      }
    }
    return {
      ...entity, kind, type: text(row.type), cost: number(row.cost), xCost: row.is_x_cost === true,
      starCost: number(row.star_cost), xStarCost: row.is_x_star_cost === true,
      keywords: strings(row.keywords), keywordKeys: strings(row.keywords_key), upgrade,
      upgradeDescription: typeof row.upgrade_description === 'string' ? row.upgrade_description : null,
      cardImage: imageURL(row.image_url_card, true), upgradedImage: imageURL(row.image_url_card_upg, true),
    }
  })
}

export function parseCatalog(channel: Channel, cards: unknown, relics: unknown, fetchedAt = Date.now()): Catalog {
  return { channel, fetchedAt, cards: parseEntries(channel, 'card', cards, false) as Card[],
    relics: parseEntries(channel, 'relic', relics, false) as Relic[] }
}

export type RequestCatalog = (path: '/api/cards' | '/api/relics', channel: Channel) => Promise<unknown>

interface CacheEntry {
  ready?: Promise<void>
  catalog?: Catalog
  pending?: Promise<Catalog>
  error?: unknown
  retryAt: number
}

export class CatalogCache {
  private entries = new Map<Channel, CacheEntry>()

  constructor(
    private request: RequestCatalog,
    private maxAge: number,
    private onError: (channel: Channel, error: unknown) => void,
    private now = Date.now,
    private directory?: string,
  ) {}

  private async entry(channel: Channel): Promise<CacheEntry> {
    let entry = this.entries.get(channel)
    if (! entry) {
      entry = { retryAt: 0 }
      this.entries.set(channel, entry)
      entry.ready = this.readDisk(channel).then((catalog) => {
        entry.catalog = catalog
      })
    }
    await entry.ready
    return entry
  }

  // Read-only: ordinary lookups must never implicitly load a whole catalog.
  async read(channel: Channel): Promise<{ catalog: Catalog, stale: boolean } | undefined> {
    const entry = await this.entry(channel)
    if (entry.catalog) return { catalog: entry.catalog, stale: this.now() - entry.catalog.fetchedAt >= this.maxAge }
  }

  async refresh(channel: Channel, force = false): Promise<{ catalog: Catalog, stale: boolean }> {
    const entry = await this.entry(channel)
    if (! force && entry.catalog && this.now() - entry.catalog.fetchedAt < this.maxAge) {
      return { catalog: entry.catalog, stale: false }
    }
    if (! entry.pending && this.now() >= entry.retryAt) {
      entry.pending = this.load(channel).then((catalog) => {
        entry.catalog = catalog
        entry.error = undefined
        return catalog
      }).catch((error: unknown) => {
        entry.error = error
        // Back off after errors (including provider rate limits), also when
        // there is no usable snapshot yet. Never fall back to another branch.
        entry.retryAt = this.now() + retryDelay(error, this.now())
        this.onError(channel, error)
        throw error
      }).finally(() => {
        entry.pending = undefined
      })
    }
    try {
      if (entry.pending) await entry.pending
      else if (! entry.catalog) throw entry.error
      if (! entry.catalog) throw entry.error
      return { catalog: entry.catalog, stale: this.now() - entry.catalog.fetchedAt >= this.maxAge }
    }
    catch (error) {
      if (entry.catalog) return { catalog: entry.catalog, stale: true }
      throw error
    }
  }

  private async load(channel: Channel) {
    // Wait for BOTH requests before clearing pending, even if one fails early.
    const rows = await Promise.allSettled([
      this.request('/api/cards', channel), this.request('/api/relics', channel),
    ])
    const failure = rows.find(row => row.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
    const cards = (rows[0] as PromiseFulfilledResult<unknown>).value
    const relics = (rows[1] as PromiseFulfilledResult<unknown>).value
    const catalog = parseCatalog(channel, cards, relics, this.now())
    if (this.directory) {
      await mkdir(this.directory, { recursive: true })
      const filename = path.join(this.directory, `${channel}.json`)
      const temporary = `${filename}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, JSON.stringify({ version: 1, channel, fetchedAt: catalog.fetchedAt, cards, relics }), { flag: 'wx' })
        await rename(temporary, filename)
      }
      finally {
        await rm(temporary, { force: true })
      }
    }
    return catalog
  }

  private async readDisk(channel: Channel): Promise<Catalog | undefined> {
    if (! this.directory) return
    try {
      const data = JSON.parse(await readFile(path.join(this.directory, `${channel}.json`), 'utf8'))
      if (data.version !== 1 || data.channel !== channel || ! Number.isFinite(data.fetchedAt) || data.fetchedAt < 0) {
        throw new Error('Invalid catalog snapshot')
      }
      return parseCatalog(channel, data.cards, data.relics, data.fetchedAt)
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.onError(channel, error)
    }
  }
}

export function retryDelay(error: unknown, now: number) {
  if (! record(error) || ! record(error.response)) return 60_000
  const headers = error.response.headers
  const value = headers instanceof Headers ? headers.get('retry-after')
    : record(headers) ? headers['retry-after'] : undefined
  if (typeof value !== 'string') return 60_000
  const delay = /^\d+(\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now
  return Number.isFinite(delay) ? Math.max(60_000, delay) : 60_000
}
