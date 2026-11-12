import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { imageURL, retryDelay, type Channel } from './catalog'

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024

interface Image {
  data: Buffer
  type: string
}

export interface CachedImage extends Image {
  stale: boolean
  persisted: boolean
}

// Inspect bytes instead of trusting a CDN's Content-Type or URL extension:
// an HTML error page must never become a cached image.
function imageType(data: Buffer) {
  if (data.length < 12) return
  if (data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png'
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (['GIF87a', 'GIF89a'].includes(data.toString('ascii', 0, 6))) return 'image/gif'
  if (data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
}

// Limit the stream as it arrives, not after arrayBuffer() has allocated it.
export async function readImage(response: Response): Promise<Buffer> {
  if (! response.body) throw new Error('Missing image body')
  if (Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES) {
    await response.body.cancel()
    throw new Error('Image exceeds size limit')
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return Buffer.concat(chunks)
      size += value.byteLength
      if (size > MAX_IMAGE_BYTES) throw new Error('Image exceeds size limit')
      chunks.push(value)
    }
  }
  finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export class ImageCache {
  private pending = new Map<string, Promise<CachedImage | undefined>>()
  private retryAt = new Map<string, number>()

  constructor(
    private directory: string,
    private maxAge: number,
    private request: (url: string) => Promise<Uint8Array>,
    private onError: (operation: 'read' | 'download' | 'write', error: unknown) => void,
    private now = Date.now,
  ) {}

  async get(url: string, channel: Channel): Promise<CachedImage | undefined> {
    const safe = imageURL(url)
    if (! safe) return
    // Include the channel even if a provider reuses the same URL in both.
    const key = createHash('sha256').update(`${channel}\0${safe}`).digest('hex')
    const pending = this.pending.get(key)
    if (pending) return pending
    const task = this.load(key, safe).finally(() => this.pending.delete(key))
    this.pending.set(key, task)
    return task
  }

  private async read(filename: string): Promise<{ image: Image, fetchedAt: number } | undefined> {
    try {
      // A single file descriptor keeps bytes and mtime from the same snapshot
      // if another plugin instance atomically replaces this cache entry.
      const handle = await open(filename, 'r')
      try {
        const stat = await handle.stat()
        if (! stat.isFile() || stat.size > MAX_IMAGE_BYTES) throw new Error('Invalid cached image size')
        const data = await handle.readFile()
        const type = imageType(data)
        if (! type) throw new Error('Invalid cached image format')
        return { image: { data, type }, fetchedAt: stat.mtimeMs }
      }
      finally {
        await handle.close()
      }
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.onError('read', error)
    }
  }

  private async write(filename: string, data: Buffer) {
    await mkdir(this.directory, { recursive: true })
    const temporary = `${filename}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, data, { flag: 'wx', mode: 0o600 })
      await rename(temporary, filename)
    }
    finally {
      await rm(temporary, { force: true })
    }
  }

  private async load(key: string, url: string): Promise<CachedImage | undefined> {
    const filename = path.join(this.directory, `${key}.image`)
    const cached = await this.read(filename)
    if (cached && this.now() - cached.fetchedAt < this.maxAge) return { ...cached.image, stale: false, persisted: true }
    if (this.now() < (this.retryAt.get(key) ?? 0)) return cached && { ...cached.image, stale: true, persisted: true }
    let image: Image
    try {
      const data = Buffer.from(await this.request(url))
      const type = imageType(data)
      if (! type || data.length > MAX_IMAGE_BYTES) throw new Error('Invalid image response')
      image = { data, type }
    }
    catch (error) {
      this.retryAt.set(key, this.now() + retryDelay(error, this.now()))
      this.onError('download', error)
      return cached && { ...cached.image, stale: true, persisted: true }
    }
    this.retryAt.delete(key)
    try {
      await this.write(filename, image.data)
    }
    catch (error) {
      // Read-only/full disks should not prevent sending a successful download.
      this.onError('write', error)
      return { ...image, stale: false, persisted: false }
    }
    return { ...image, stale: false, persisted: true }
  }
}
