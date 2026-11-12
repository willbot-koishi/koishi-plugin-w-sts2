export function card(overrides: Record<string, unknown> = {}) {
  return {
    id: 'BASH', name: '痛击', description: '造成[gold]8[/gold]点伤害。',
    type: '攻击', rarity: '基础', color: 'ironclad', cost: 2,
    keywords: null, keywords_key: null, upgrade: { damage: '+2' },
    upgrade_description: '造成[gold]10[/gold]点伤害。',
    image_url: '/static/images/cards/bash.webp',
    image_url_card: 'https://cdn.spire-codex.com/cards-full/stable/bash.webp',
    image_url_card_upg: 'https://cdn.spire-codex.com/cards-full/stable/bash_upg.webp',
    ...overrides,
  }
}

export function relic(overrides: Record<string, unknown> = {}) {
  return {
    id: 'BURNING_BLOOD', name: '燃烧之血', description: '战斗结束时，回复[blue]6[/blue]点生命。',
    rarity: '初始遗物', pool: 'ironclad', image_url: '/static/images/relics/burning_blood.webp',
    ...overrides,
  }
}

export const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=', 'base64')
