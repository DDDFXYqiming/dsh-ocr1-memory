// Import every Markdown memory from the legacy dsh-memory store.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { createMemoryStore, createRenderer, DEFAULT_TIERS, splitSegments } from '../lib/core.js'

const OLD_ROOT = process.env.OLD_MEMORY_ROOT || 'C:\\Users\\39795\\.dsh\\memory'
const STORE_DIR = process.env.OCR1_STORE_DIR || 'C:\\Users\\39795\\.dsh\\ocr1-memory'
const RENDER_SCRIPT = join(process.cwd(), 'scripts', 'render_memory.py')
const MAX_SEGMENTS_PER_IMAGE = 12

function collectMarkdown(root) {
  const files = []
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const filePath = join(dir, entry.name)
      if (entry.isDirectory()) walk(filePath)
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) files.push(filePath)
    }
  }
  walk(root)
  return files.sort((a, b) => a.localeCompare(b))
}

async function main() {
  const files = collectMarkdown(OLD_ROOT)
  const renderer = createRenderer({ python: process.env.PYTHON || 'python', renderCommand: RENDER_SCRIPT })
  const store = await createMemoryStore({ storeDir: STORE_DIR, renderer, embedding: null, tiers: DEFAULT_TIERS })
  let manifestEntries = []
  try {
    manifestEntries = JSON.parse(readFileSync(join(STORE_DIR, 'memories.json'), 'utf8')).entries || []
  } catch {}
  const existingSources = new Set()
  for (const entry of manifestEntries) {
    if (!entry?.source?.startsWith('legacy/')) continue
    if (entry.imagePath && existsSync(entry.imagePath)) existingSources.add(entry.source)
    else await store.remove(entry.id)
  }

  let imported = 0
  let existing = 0
  let skipped = 0
  let failed = 0
  let chunks = 0
  for (const filePath of files) {
    const text = readFileSync(filePath, 'utf8')
    const relativePath = relative(OLD_ROOT, filePath).split('\\').join('/')
    const baseSource = `legacy/${relativePath}`
    if (!text.trim()) {
      skipped++
      console.log(`SKIP ${baseSource} (empty)`)
      continue
    }
    const segments = splitSegments(text)
    const batches = []
    for (let offset = 0; offset < segments.length; offset += MAX_SEGMENTS_PER_IMAGE) {
      batches.push(segments.slice(offset, offset + MAX_SEGMENTS_PER_IMAGE))
    }
    for (let i = 0; i < batches.length; i++) {
      const source = batches.length === 1
        ? baseSource
        : `${baseSource}#chunk-${String(i + 1).padStart(3, '0')}`
      if (existingSources.has(source)) {
        existing++
        continue
      }
      try {
        const result = await store.add({ segments: batches[i].map((segment) => segment.content), source })
        existingSources.add(source)
        imported++
        chunks += batches.length > 1 ? 1 : 0
        console.log(`OK ${source} -> ${result.id} (${result.segments} segs)`)
      } catch (error) {
        failed++
        console.error(`FAIL ${source}: ${error?.message || error}`)
      }
    }
  }

  console.log(`MIGRATION_RESULT files=${files.length} imported=${imported} existing=${existing} chunks=${chunks} skipped=${skipped} failed=${failed}`)
  if (failed) process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
