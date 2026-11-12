import { CatalogCache, parseEntries, retryDelay, type Card, type Catalog, type Channel, type Entry, type Kind, type Relic } from './catalog'
import { aliasIDs, normalize } from './search'

type RequestQuery = (path: string, channel: Channel, search?: string) => Promise<unknown>

async function settled<T>(requests: Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(requests)
  const failure = results.find(result => result.status === 'rejected')
  if (failure?.status === 'rejected') throw failure.reason
  return results.map(result => (result as PromiseFulfilledResult<T>).value)
}

// A lookup uses either an exact entity endpoint or a filtered list. Never
// replace either with an unfiltered catalog load on a miss or failure.
export async function loadQuery(request: RequestQuery, channel: Channel, query: string, kind?: Kind): Promise<Catalog> {
  const kinds: Kind[] = kind ? [kind] : ['card', 'relic']
  const needle = normalize(query)
  if (! needle) throw new Error('Empty lookup query')
  const exact = async (kind: Kind, id: string): Promise<Entry[]> => {
    try {
      const row = await request(`/api/${kind}s/${encodeURIComponent(id.toUpperCase())}`, channel)
      const entries = parseEntries(channel, kind, [row])
      if (entries[0].id.toUpperCase() !== id.toUpperCase()) throw new Error('Entity ID mismatch')
      return entries
    }
    catch (error) {
      if ((error as { response?: { status?: number } }).response?.status === 404) return []
      throw error
    }
  }
  const catalog = (entries: Entry[]): Catalog => ({
    channel, fetchedAt: Date.now(),
    cards: entries.filter((entry): entry is Card => entry.kind === 'card'),
    relics: entries.filter((entry): entry is Relic => entry.kind === 'relic'),
  })
  if (/^[a-z0-9_]+$/.test(needle)) {
    const entries = (await settled(kinds.map(kind => exact(kind, needle)))).flat()
    if (entries.length) return catalog(entries)
  }
  const entries = (await settled(kinds.map(async kind => parseEntries(channel, kind,
    await request(`/api/${kind}s`, channel, needle))))).flat()
  if (kind !== 'relic') {
    // The provider cannot search old Chinese names. Resolve just the missing
    // alias hits by ID, ignoring deleted cards (404), without a full-table pull.
    const missing = aliasIDs(needle).filter(id => ! entries.some(entry => entry.kind === 'card' && entry.id === id))
    for (let offset = 0; offset < missing.length; offset += 3) {
      entries.push(...(await settled(missing.slice(offset, offset + 3).map(id => exact('card', id)))).flat())
    }
  }
  return catalog(entries)
}

interface EntryCache {
  catalog?: Catalog
  pending?: Promise<Catalog>
}

export class LookupCache {
  private entries = new Map<string, EntryCache>()
  private failures = new Map<Channel, { error: unknown, retryAt: number }>()

  constructor(
    private full: CatalogCache,
    private request: (channel: Channel, query: string, kind?: Kind) => Promise<Catalog>,
    private maxAge: number,
    private onError: (channel: Channel, error: unknown) => void,
    private now = Date.now,
  ) {}

  async get(channel: Channel, query: string, kind?: Kind): Promise<{ catalog: Catalog, stale: boolean }> {
    const full = await this.full.read(channel)
    if (full && ! full.stale) return full
    const key = JSON.stringify([channel, kind, normalize(query)])
    let entry = this.entries.get(key)
    if (! entry) this.entries.set(key, entry = {})
    // Bound per-query memory without evicting in-flight work.
    this.entries.delete(key)
    this.entries.set(key, entry)
    for (const [oldKey, old] of this.entries) {
      if (this.entries.size <= 256) break
      if (oldKey !== key && ! old.pending) this.entries.delete(oldKey)
    }
    if (entry.catalog && this.now() - entry.catalog.fetchedAt < this.maxAge) return { catalog: entry.catalog, stale: false }
    const failure = this.failures.get(channel)
    if (! entry.pending && (! failure || this.now() >= failure.retryAt)) {
      entry.pending = this.request(channel, query, kind).then((catalog) => {
        entry.catalog = catalog
        this.failures.delete(channel)
        return catalog
      }).catch((error: unknown) => {
        this.failures.set(channel, { error, retryAt: this.now() + retryDelay(error, this.now()) })
        this.onError(channel, error)
        throw error
      }).finally(() => {
        entry.pending = undefined
      })
    }
    try {
      if (entry.pending) await entry.pending
      else throw failure?.error
      return { catalog: entry.catalog, stale: false }
    }
    catch (error) {
      // A stale full snapshot is also a safe fallback, but never a partial
      // result from another query or a snapshot belonging to another channel.
      const cached = entry.catalog && (! full || entry.catalog.fetchedAt >= full.catalog.fetchedAt) ? entry.catalog : full?.catalog
      if (cached) return { catalog: cached, stale: true }
      throw error
    }
  }
}
