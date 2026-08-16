// Migrate curated content from the legacy dsh-memory store into dsh-ocr1-memory.
//
// Scope:
//   - facts.md sections (root + namespace 39795)
//   - SOP files under <old>/sops and <old>/39795/sops
//   - root memory_management_sop.md
// Pending/archive/history files are intentionally not migrated.
//
// Usage:
//   node scripts/migrate-from-dsh-memory.mjs
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, basename, extname } from 'node:path'
import { createMemoryStore, createRenderer, createEmbeddingHttpClient, DEFAULT_TIERS } from '../lib/core.js'

const OLD_ROOT = process.env.OLD_MEMORY_ROOT || 'C:\\Users\\39795\\.dsh\\memory'
const STORE_DIR = process.env.OCR1_STORE_DIR || 'C:\\Users\\39795\\.dsh\\ocr1-memory'
const EMBEDDING_BASE = process.env.OCR1_EMBEDDING_BASE || 'http://127.0.0.1:18080/v1'
const RENDER_SCRIPT = join(process.cwd(), 'scripts', 'render_memory.py')
const MAX_ITEMS = Number(process.env.MAX_ITEMS || 0)
const NO_EMBEDDING = process.env.OCR1_NO_EMBEDDING === '1'
const ONLY_SOPS = process.env.ONLY_SOPS === '1'

function slugify(input) {
  return String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'item'
}

function parseFactsSections(filePath, prefix) {
  if (!existsSync(filePath)) return []
  const text = readFileSync(filePath, 'utf8')
  const lines = text.split(/\r?\n/)
  const sections = []
  let current = null
  for (const line of lines) {
    if (line.startsWith('## ')) {
      if (current && current.body.trim()) {
        sections.push({ source: `${prefix}-${slugify(current.title)}`, text: current.body.trim() })
      }
      current = { title: line.slice(3).trim(), body: line + '\n' }
    } else if (current) {
      current.body += line + '\n'
    }
  }
  if (current && current.body.trim()) {
    sections.push({ source: `${prefix}-${slugify(current.title)}`, text: current.body.trim() })
  }
  return sections
}

function collectSopFiles() {
  const dirs = [join(OLD_ROOT, 'sops'), join(OLD_ROOT, '39795', 'sops')]
  const files = []
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.md')) continue
      const filePath = join(dir, name)
      files.push({ source: `sop-${slugify(basename(name, extname(name)))}`, filePath, text: readFileSync(filePath, 'utf8') })
    }
  }
  const rootSop = join(OLD_ROOT, 'memory_management_sop.md')
  if (existsSync(rootSop)) {
    files.push({ source: 'sop-memory-management', filePath: rootSop, text: readFileSync(rootSop, 'utf8') })
  }
  return files
}

async function main() {
  const renderer = createRenderer({ python: process.env.PYTHON || 'python', renderCommand: RENDER_SCRIPT })
  const embedding = NO_EMBEDDING ? null : createEmbeddingHttpClient({ baseUrl: EMBEDDING_BASE, model: 'deepseek-ocr', emptyPromptTokens: 1 })
  const store = await createMemoryStore({ storeDir: STORE_DIR, renderer, embedding, tiers: DEFAULT_TIERS })

  let items = []
  if (!ONLY_SOPS) {
    items.push(
      ...parseFactsSections(join(OLD_ROOT, 'facts.md'), 'fact-root'),
      ...parseFactsSections(join(OLD_ROOT, '39795', 'facts.md'), 'fact-ns'),
    )
  }
  items.push(...collectSopFiles())
  if (MAX_ITEMS > 0) items = items.slice(0, MAX_ITEMS)

  console.log(`Migrating ${items.length} items into ${STORE_DIR} ...`)
  let ok = 0
  let fail = 0
  for (const item of items) {
    try {
      const result = await store.add({ text: item.text, source: item.source })
      console.log(`OK ${item.source} -> ${result.id} (${result.segments} segs)`)
      ok++
    } catch (err) {
      console.error(`FAIL ${item.source}: ${err?.message || err}`)
      fail++
    }
  }
  console.log(`\nDone: ${ok} ok, ${fail} failed, ${items.length} total.`)
  process.exit(fail ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
