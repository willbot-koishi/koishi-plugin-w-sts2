import type { Card, Entry } from './catalog'

export type Translate = (key: string, params?: Record<string, unknown>) => string

export function poolName(pool: string, t: Translate) {
  return ['ironclad', 'silent', 'regent', 'necrobinder', 'defect', 'colorless', 'curse', 'status',
    'event', 'token', 'ancient', 'shared', 'quest'].includes(pool) ? t(`pools.${pool}`) : pool
}

export function plainText(value: string, t: Translate) {
  return value.replace(/\[(energy|star):([^\]]+)\]/g, (_, type: string, amount: string) => t(type, { amount }))
    .replace(/\[\/?(?:gold|blue|purple|red|green|orange|yellow|white|gray|grey)\]/g, '').trim()
}

export function canUpgrade(card: Card) {
  return Object.keys(card.upgrade).length > 0 || card.upgradeDescription !== null || !! card.upgradedImage
}

function upgradedValue(base: number | null, value: string | number | undefined) {
  if (typeof value === 'number') return value
  if (typeof value === 'string' && /^[+-]\d+$/.test(value) && base !== null) return base + Number(value)
  return base
}

export function cardKeywords(card: Card, upgraded: boolean) {
  const keywords = [...card.keywords]
  if (! upgraded) return keywords
  // Null upgrade_description also occurs for keyword-only and cost-only
  // upgrades. It does NOT mean the card cannot be upgraded.
  for (const [key, name] of [['Exhaust', '消耗'], ['Ethereal', '虚无'], ['Innate', '固有'], ['Retain', '保留']]) {
    const index = card.keywordKeys.indexOf(key)
    const label = index >= 0 ? card.keywords[index] : name
    if (card.upgrade[`remove_${key.toLowerCase()}`]) {
      const found = keywords.indexOf(label)
      if (found >= 0) keywords.splice(found, 1)
    }
    if (card.upgrade[`add_${key.toLowerCase()}`] && ! keywords.includes(label)) keywords.push(label)
  }
  return keywords
}

export function describe(entry: Entry, upgraded: boolean, t: Translate) {
  const lines = [t('title', { name: entry.name + (upgraded ? '+' : ''), id: entry.id })]
  const pool = poolName(entry.pool, t)
  lines.push([t(entry.kind), pool, entry.rarity, entry.kind === 'card' ? entry.type : ''].filter(Boolean).join(' · '))
  if (entry.kind === 'card') {
    const cost = upgraded ? upgradedValue(entry.cost, entry.upgrade.cost) : entry.cost
    const costs = [t('cost', { value: entry.xCost ? 'X' : cost !== null && cost >= 0 ? cost : '—' })]
    const stars = upgraded ? upgradedValue(entry.starCost, entry.upgrade.star_cost) : entry.starCost
    if (entry.xStarCost || stars !== null) costs.push(t('star-cost', { value: entry.xStarCost ? 'X' : stars }))
    lines.push(costs.join(' · '))
    const keywords = cardKeywords(entry, upgraded)
    if (keywords.length) lines.push(keywords.join(' · '))
    const effect = upgraded ? entry.upgradeDescription ?? entry.description : entry.description
    if (effect.trim()) lines.push(plainText(effect, t))
  }
  else {
    lines.push(plainText(entry.description, t))
  }
  return lines.join('\n')
}

export function entryImage(entry: Entry, upgraded: boolean) {
  if (entry.kind === 'relic') return entry.image
  // Do not show a normal full render next to upgraded text. If the requested
  // full render is missing (e.g. Mad Science), use the neutral portrait.
  return (upgraded ? entry.upgradedImage : entry.cardImage) ?? entry.image
}
