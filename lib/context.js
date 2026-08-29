import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { nsRoot, readIndex, resolveNamespace } from './governance.js'

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

function escapeAttribute(value) {
  return compactText(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function readOpticalCatalog(storeDir, maxEntries) {
  if (!storeDir) return []
  try {
    const manifestPath = join(storeDir, 'memories.json')
    if (!existsSync(manifestPath)) return []
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : []
    return entries
      .filter((entry) => entry && entry.id && Array.isArray(entry.segments) && entry.segments.length > 0 && !entry.archived)
      .sort((a, b) => {
        const hitDelta = Number(b.hits || 0) - Number(a.hits || 0)
        if (hitDelta) return hitDelta
        return timestamp(b.lastAccessAt || b.createdAt) - timestamp(a.lastAccessAt || a.createdAt)
      })
      .slice(0, maxEntries)
      .map((entry) => {
        const source = escapeAttribute(entry.source || '')
        const id = escapeAttribute(entry.id)
        const tier = escapeAttribute(entry.tier || 'unknown')
        const segments = Math.max(0, Number(entry.segments.length) || 0)
        const hits = Math.max(0, Number(entry.hits || 0) || 0)
        return `- optical: ${source || id} [id=${id}, tier=${tier}, segments=${segments}, hits=${hits}]`
      })
  } catch {
    return []
  }
}

/**
 * Build a lightweight L1 prompt contribution. It exposes governed index
 * pointers and optical metadata, but never injects the stored memory bodies.
 * Detailed content is fetched through memory_read/memory_retrieve instead.
 */
export function readMemoryIndexContext({
  memoryDir,
  defaultNamespace = '',
  autoNamespace = true,
  opticalStoreDir = '',
  maxEntries = DEFAULT_MAX_ENTRIES,
  maxChars = DEFAULT_MAX_CHARS,
} = {}) {
  const limit = positiveInteger(maxEntries, DEFAULT_MAX_ENTRIES, 50)
  const charLimit = positiveInteger(maxChars, DEFAULT_MAX_CHARS, 20_000)
  const lines = ['[OCR1 memory index]']
  try {
    if (memoryDir) {
      const namespace = resolveNamespace({ defaultNamespace, autoNamespace })
      const index = readIndex(nsRoot(memoryDir, namespace))
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
        .trim()
      if (index) {
        lines.push(`<memory_index namespace="${escapeAttribute(namespace)}" source="user-writable">`)
        lines.push(index)
        lines.push('</memory_index>')
      }
    }
  } catch {
    // A missing namespace/index should not block prompt assembly.
  }

  const catalog = readOpticalCatalog(opticalStoreDir, limit)
  if (catalog.length) {
    lines.push('<optical_catalog source="metadata-only">')
    lines.push(...catalog)
    lines.push('</optical_catalog>')
  }
  if (lines.length === 1) return ''
  // 组装时始终保留闭合标签：超过预算时只截断正文，绝不剪掉 </memory_index> 或
  // </optical_catalog>（截断的不可信段若缺少闭合标记会污染后续 prompt 解析）。
  const header = lines[0]
  const rest = lines.slice(1)
  const closingLines = rest.filter((line) => line.startsWith('</'))
  const body = rest.filter((line) => !line.startsWith('</'))
  const closingText = closingLines.length ? closingLines.join('\n') : ''
  const fullLength = header.length + 1 + body.join('\n').length + (closingText ? 1 + closingText.length : 0)
  if (fullLength <= charLimit) return [header, ...body, ...closingLines].join('\n')
  const budget = Math.max(1, charLimit - (closingText ? 1 + closingText.length : 0))
  let bodyText = body.join('\n')
  if (bodyText.length > budget) bodyText = `${bodyText.slice(0, Math.max(1, budget - 1)).trimEnd()}…`
  return [header, bodyText, ...closingLines].join('\n')
}
