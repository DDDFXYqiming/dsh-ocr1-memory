import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const DEFAULT_MAX_ENTRIES = 5
const DEFAULT_MAX_CHARS = 4000

function positiveInteger(value, fallback, max) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 1) return fallback
  return Math.min(max, Math.floor(n))
}

function timestamp(value) {
  const n = new Date(value).getTime()
  return Number.isFinite(n) ? n : 0
}

function compactText(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Build a small synchronous prompt contribution from the optical manifest.
 * This is intentionally disk-only: system-prompt providers are synchronous and
 * must never start OCR, embeddings, or another network request.
 */
export function readMemoryContextSnapshot({
  storeDir,
  maxEntries = DEFAULT_MAX_ENTRIES,
  maxChars = DEFAULT_MAX_CHARS,
} = {}) {
  if (!storeDir) return ''
  const manifestPath = join(storeDir, 'memories.json')
  try {
    if (!existsSync(manifestPath)) return ''
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : []
    const limit = positiveInteger(maxEntries, DEFAULT_MAX_ENTRIES, 50)
    const charLimit = positiveInteger(maxChars, DEFAULT_MAX_CHARS, 20_000)
    const ranked = entries
      .filter((entry) => entry && Array.isArray(entry.segments) && entry.segments.length > 0)
      .map((entry) => ({
        entry,
        body: compactText(entry.segments.map((segment) => segment?.content || '').join(' ')),
      }))
      .filter(({ body }) => body)
      .sort((a, b) => {
        const hitDelta = Number(b.entry.hits || 0) - Number(a.entry.hits || 0)
        if (hitDelta) return hitDelta
        return timestamp(b.entry.lastAccessAt || b.entry.createdAt) - timestamp(a.entry.lastAccessAt || a.entry.createdAt)
      })
      .slice(0, limit)

    if (!ranked.length) return ''
    const lines = ['[OCR1 memory context]']
    for (const { entry, body } of ranked) {
      const id = compactText(entry.id) || 'unknown'
      const source = compactText(entry.source)
      const tier = compactText(entry.tier) || 'unknown'
      const hits = Math.max(0, Number(entry.hits || 0) || 0)
      const label = source ? `${source} (${id})` : id
      lines.push(`- ${label} [${tier}, hits=${hits}]: ${body}`)
    }
    if (lines.length === 1) return ''

    const text = lines.join('\n')
    if (text.length <= charLimit) return text
    return `${text.slice(0, Math.max(1, charLimit - 1)).trimEnd()}…`
  } catch {
    // A malformed or concurrently-written manifest must not break prompt assembly.
    return ''
  }
}
