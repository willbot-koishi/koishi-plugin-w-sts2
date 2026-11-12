import type { Context } from 'koishi'
import { imageURL } from './catalog'
import { readImage } from './image-cache'

export const MAX_IMAGE_REDIRECTS = 5
const redirects = new Set([301, 302, 303, 307, 308])

class ImageDownloadError extends Error {
  readonly response?: { status: number, headers: Headers }

  constructor(message: string, response?: Response) {
    super(message)
    this.name = 'ImageDownloadError'
    if (response) this.response = { status: response.status, headers: response.headers }
  }
}

export async function downloadImage(http: Pick<Context['http'], 'get'>, source: string, timeout: number, signal?: AbortSignal) {
  let url = imageURL(source)
  if (! url) throw new ImageDownloadError('Unsafe image URL')
  const visited = new Set<string>()
  const deadline = Date.now() + timeout
  for (let hops = 0; ; hops ++) {
    signal?.throwIfAborted()
    if (visited.has(url)) throw new ImageDownloadError('Image redirect loop')
    visited.add(url)
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new ImageDownloadError('Image request timed out')
    const result = await http.get<{ data: Buffer } | { location: string }>(url, {
      // Automatic following would bypass imageURL() on subsequent hops.
      redirect: 'manual',
      timeout: remaining,
      signal,
      // Handle errors here too, so HTTP never buffers an unbounded error page.
      validateStatus: () => true,
      responseType: async (response) => {
        if (response.status >= 200 && response.status < 300) return { data: await readImage(response) }
        await response.body?.cancel().catch(() => {})
        if (! redirects.has(response.status)) throw new ImageDownloadError('Unexpected image HTTP status', response)
        const location = response.headers.get('location')
        if (! location) throw new ImageDownloadError('Image redirect missing Location', response)
        if (hops >= MAX_IMAGE_REDIRECTS) throw new ImageDownloadError('Image redirect limit exceeded', response)
        let target: string | undefined
        try {
          target = imageURL(new URL(location, url).href)
        }
        catch { /* Invalid Location values must not reach the HTTP client. */ }
        if (! target) throw new ImageDownloadError('Unsafe image redirect', response)
        return { location: target }
      },
    })
    if ('data' in result) return result.data
    url = result.location
  }
}

const safeMessages = new Set([
  'Unsafe image URL', 'Unsafe image redirect', 'Image redirect loop', 'Image redirect limit exceeded',
  'Image redirect missing Location', 'Unexpected image HTTP status', 'Image request timed out',
  'Missing image body', 'Image exceeds size limit', 'Invalid image response',
  'Invalid cached image size', 'Invalid cached image format',
  'fetch failed', 'unexpected redirect', 'request timeout', 'context disposed',
])
const safeNames = new Set(['Error', 'TypeError', 'RangeError', 'AbortError', 'TimeoutError', 'AggregateError', 'ImageDownloadError'])

// HTTP errors may contain API keys, URLs, headers or filesystem paths. Only
// emit known messages and structured status/codes, including nested causes.
export function describeImageError(error: unknown) {
  const pending = [error]
  const seen = new Set<unknown>()
  const details: string[] = []
  while (pending.length && details.length < 6) {
    const value = pending.shift()
    if (! value || typeof value !== 'object' || seen.has(value)) continue
    seen.add(value)
    const current = value as Error & { code?: unknown, response?: { status?: unknown }, errors?: unknown[] }
    const parts = [safeNames.has(current.name) ? current.name : 'Error']
    if (safeMessages.has(current.message)) parts.push(current.message)
    if (typeof current.code === 'string' && /^(?:E[A-Z0-9_]{1,63}|UND_ERR_[A-Z0-9_]{1,56}|CERT_HAS_EXPIRED|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE)$/.test(current.code)) {
      parts.push(current.code)
    }
    const status = current.response?.status
    if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) parts.push(`HTTP ${status}`)
    details.push(parts.join(': '))
    if (current.cause) pending.push(current.cause)
    if (Array.isArray(current.errors)) pending.push(...current.errors.slice(0, 2))
  }
  return details.join(' -> ') || 'unknown error'
}
