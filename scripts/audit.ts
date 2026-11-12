import legacyNames from '../src/data/legacy-names.json'
import { API_BASE, parseCatalog, type Channel } from '../src/catalog'

async function request(path: string, channel?: Channel) {
  const url = new URL(path, API_BASE)
  url.searchParams.set('lang', 'zhs')
  if (channel === 'beta') url.searchParams.set('channel', channel)
  const response = await fetch(url, {
    signal: AbortSignal.timeout(30_000),
    headers: process.env.SPIRE_CODEX_API_KEY ? { 'X-API-Key': process.env.SPIRE_CODEX_API_KEY } : {},
  })
  if (! response.ok) throw new Error(`Spire Codex ${response.status}: ${path} (${channel ?? 'metadata'})`)
  return response.json() as Promise<unknown>
}

async function main() {
  const reports = []
  const catalogs = []
  for (const channel of ['stable', 'beta'] as const) {
    const [cards, relics] = await Promise.all([request('/api/cards', channel), request('/api/relics', channel)])
    const catalog = parseCatalog(channel, cards, relics)
    catalogs.push(catalog)
    const templates = [...catalog.cards, ...catalog.relics].filter(entry => /\{[^}]+\}/.test(entry.description)
      || (entry.kind === 'card' && /\{[^}]+\}/.test(entry.upgradeDescription ?? ''))).map(entry => entry.id)
    const unusable = catalog.cards.filter(card => ! card.description && ! card.keywords.length).map(card => card.id)
    const emptyRelics = catalog.relics.filter(relic => ! relic.description.trim()).map(relic => relic.id)
    const aliases = Object.entries(legacyNames).filter(([id, names]) => {
      const card = catalog.cards.find(card => card.id === id)
      return card && ! names.includes(card.name)
    })
    reports.push({
      channel, fetchedAt: new Date(catalog.fetchedAt).toISOString(), cards: catalog.cards.length, relics: catalog.relics.length,
      keywordOnlyCards: catalog.cards.filter(card => ! card.description && card.keywords.length).map(card => card.id),
      missingFullCardImages: catalog.cards.filter(card => ! card.cardImage).map(card => card.id),
      missingPortraits: [...catalog.cards, ...catalog.relics].filter(entry => ! entry.image).map(entry => entry.id),
      unresolvedTemplates: templates, unusableCards: unusable, emptyRelicDescriptions: emptyRelics,
      renamedLegacyCards: Object.fromEntries(aliases),
      legacyIDsAbsent: Object.keys(legacyNames).filter(id => ! catalog.cards.some(card => card.id === id)),
    })
    if (templates.length || unusable.length || emptyRelics.length) process.exitCode = 1
  }
  const [stable, beta] = catalogs
  console.log(JSON.stringify({
    source: API_BASE, betaVersion: await request('/api/beta/version'), reports,
    betaOnlyCards: beta.cards.filter(card => ! stable.cards.some(other => other.id === card.id)).map(card => card.id),
    betaOnlyRelics: beta.relics.filter(relic => ! stable.relics.some(other => other.id === relic.id)).map(relic => relic.id),
  }, null, 2))
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Data audit failed')
  process.exitCode = 1
})
