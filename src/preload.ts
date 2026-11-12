import type { CatalogCache, Channel } from './catalog'
import type { ImageCache } from './image-cache'

export interface PreloadProgress {
  channel: Channel
  done: number
  total: number
}

export interface PreloadResult extends PreloadProgress {
  cards: number
  relics: number
  success: number
  failed: number
  stale: boolean
}

export async function preload(
  full: CatalogCache, images: ImageCache, channel: Channel, textOnly: boolean,
  progress: PreloadProgress, active: () => boolean,
): Promise<PreloadResult> {
  const { catalog, stale } = await full.refresh(channel, true)
  const urls = new Set<string>()
  if (! textOnly) {
    for (const entry of [...catalog.cards, ...catalog.relics]) {
      if (entry.image) urls.add(entry.image)
      if (entry.kind === 'card') {
        if (entry.cardImage) urls.add(entry.cardImage)
        if (entry.upgradedImage) urls.add(entry.upgradedImage)
      }
    }
  }
  progress.total = urls.size
  const sources = [...urls]
  let cursor = 0
  let success = 0
  let failed = 0
  // Limit downloads and do not retain image buffers after each iteration.
  const worker = async () => {
    while (active() && cursor < sources.length) {
      const url = sources[cursor ++]
      try {
        const image = await images.get(url, channel)
        if (image && ! image.stale && image.persisted) success ++
        else failed ++
      }
      catch {
        failed ++
      }
      progress.done ++
    }
  }
  await Promise.all(Array.from({ length: 3 }, worker))
  return { ...progress, cards: catalog.cards.length, relics: catalog.relics.length, success, failed, stale }
}
