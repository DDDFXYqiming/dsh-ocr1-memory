// Local end-to-end smoke test for the OCR1 memory core.
// Uses the real Python Pillow renderer + a mock OCR adapter (no GPU needed).
// Run: node scripts/smoke.mjs
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  createMemoryStore,
  createMockOcr,
  createRenderer,
  DEFAULT_TIERS,
} from '../lib/core.js'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'ocr1mem-smoke-'))
  try {
    const renderer = createRenderer({
      python: process.env.PYTHON || 'python',
      renderCommand: join(PLUGIN_ROOT, 'scripts', 'render_memory.py'),
    })
    const store = await createMemoryStore({
      storeDir: dir,
      renderer,
      ocr: createMockOcr({ transcript: 'orbit api login token' }),
      tiers: DEFAULT_TIERS,
    })
    const a = await store.add({ text: 'Orbit API 需要登录并携带 token。\n\n登录态 10 分钟过期。', source: 'smoke' })
    const b = await store.add({ text: '今天的天气很好。', source: 'smoke' })
    const res = await store.retrieve('orbit token', { topK: 5 })
    console.log('STORE_A', JSON.stringify(a))
    console.log('STORE_B', JSON.stringify(b))
    console.log('LIST', JSON.stringify((await store.list()).map((e) => ({ id: e.id, tier: e.tier, resolution: e.resolution, segments: e.segments }))))
    console.log('RETRIEVE_RESULTS', JSON.stringify(res.results.map((r) => ({ id: r.entryId, seg: r.segmentId, score: r.score, tier: r.tier, preview: r.content.slice(0, 40) }))))
    if (res.results.length === 0) throw new Error('smoke: no result returned')
    console.log('SMOKE_OK')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
