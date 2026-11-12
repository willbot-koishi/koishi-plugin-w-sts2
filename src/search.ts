import legacyNames from './data/legacy-names.json'
import type { Catalog, Channel, Entry, Kind } from './catalog'

export function parseChannel(value: string): Channel | undefined {
  const key = value.trim().toLowerCase()
  if (['stable', 'main', '正式', '正式版'].includes(key)) return 'stable'
  if (['beta', '测试', '测试版'].includes(key)) return 'beta'
}

export const normalize = (value: string) => value.normalize('NFKC').trim().toLocaleLowerCase('en-US')

export function aliasIDs(query: string): string[] {
  const needle = normalize(query)
  if (! needle) return []
  return Object.entries(legacyNames).filter(([, names]) => names.some(name => normalize(name).includes(needle))).map(([id]) => id)
}

export function search(catalog: Catalog, query: string, kind?: Kind): Entry[] {
  const needle = normalize(query)
  if (! needle) return []
  const entries: Entry[] = kind === 'card' ? catalog.cards : kind === 'relic' ? catalog.relics : [...catalog.cards, ...catalog.relics]
  const aliases: Record<string, string[]> = legacyNames
  const ranked = entries.map((entry) => {
    const names = [entry.name, ...(entry.kind === 'card' ? aliases[entry.id] ?? [] : [])].map(normalize)
    const id = normalize(entry.id)
    const rank = id === needle ? 0 : names.includes(needle) ? 1
      : names.some(name => name.includes(needle)) || id.includes(needle) ? 2 : 3
    return { entry, rank }
  }).filter(item => item.rank < 3)
  // Exact matches should not be buried among partial matches, but duplicate
  // localized names (e.g. five different Strikes) must remain disambiguated.
  const exact = ranked.filter(item => item.rank < 2)
  return (exact.length ? exact : ranked).sort((a, b) => a.rank - b.rank || a.entry.id.localeCompare(b.entry.id))
    .map(item => item.entry)
}
