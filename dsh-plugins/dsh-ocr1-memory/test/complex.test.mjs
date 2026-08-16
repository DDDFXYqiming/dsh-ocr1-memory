import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createMemoryStore,
  createMockRenderer,
  createMockOcr,
  createOcrHttpClient,
  createRenderer,
  DEFAULT_TIERS,
  memoryMetrics,
  measureTextOnlyPromptTokens,
} from '../lib/core.js'

function tmpStore() {
  const dir = mkdtempSync(join(tmpdir(), 'ocr1mem-complex-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

async function ocrServerUp() {
  try {
    const res = await fetch('http://127.0.0.1:18080/health', { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return false
    const json = await res.json()
    return json.status === 'ok'
  } catch {
    return false
  }
}

test('T1 time-travel tiers + active recall', async () => {
  const t = tmpStore()
  try {
    const store = await createMemoryStore({ storeDir: t.dir, renderer: createMockRenderer(), ocr: createMockOcr({ transcript: 'target keyword' }), tiers: DEFAULT_TIERS })
    await store.add({ text: 'target keyword content', source: 't1' })
    store.entries[0].createdAt = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString()
    assert.equal((await store.list())[0].tier, 'fuzzy')
    const res = await store.retrieve('target', { topK: 1 })
    assert.equal(res.results.length, 1)
    assert.equal((await store.list())[0].tier, 'vivid')
  } finally {
    t.cleanup()
  }
})

test('T2 fuzzy active recall isolation', async () => {
  const t = tmpStore()
  try {
    const store = await createMemoryStore({ storeDir: t.dir, renderer: createMockRenderer(), ocr: createMockOcr({ transcript: '' }), tiers: DEFAULT_TIERS })
    for (let i = 0; i < 30; i++) await store.add({ text: `unrelated memory number ${i}`, source: `u${i}` })
    await store.add({ text: 'needle unique secret', source: 'needle' })
    for (const e of store.entries) e.createdAt = new Date(Date.now() - 20 * 24 * 3600 * 1000).toISOString()
    const res = await store.retrieve('needle', { topK: 5 })
    assert.ok(res.results.some((r) => r.content.includes('needle')))
    const after = await store.list()
    assert.equal(after.find((e) => e.id.includes('needle')).tier, 'vivid')
    assert.equal(after.filter((e) => e.tier === 'vivid').length, 1)
  } finally {
    t.cleanup()
  }
})

test('T3 multi-memory isolation', async () => {
  const t = tmpStore()
  try {
    const store = await createMemoryStore({ storeDir: t.dir, renderer: createMockRenderer(), ocr: createMockOcr({ transcript: '' }), tiers: DEFAULT_TIERS })
    await store.add({ text: 'Orbit API login token', source: 'orbit' })
    await store.add({ text: 'weather sunny today', source: 'weather' })
    await store.add({ text: 'python async code sample', source: 'code' })
    const r1 = await store.retrieve('orbit token', { topK: 3 })
    const r2 = await store.retrieve('weather', { topK: 3 })
    const r3 = await store.retrieve('python code', { topK: 3 })
    assert.ok(r1.results.every((r) => r.content.includes('Orbit')))
    assert.ok(r2.results.every((r) => r.content.includes('weather')))
    assert.ok(r3.results.every((r) => r.content.includes('python')))
  } finally {
    t.cleanup()
  }
})

test('T4 large text target segment', async () => {
  const t = tmpStore()
  try {
    const store = await createMemoryStore({ storeDir: t.dir, renderer: createMockRenderer(), ocr: createMockOcr({ transcript: '' }), tiers: DEFAULT_TIERS })
    const paragraphs = []
    for (let i = 1; i <= 50; i++) paragraphs.push(`这是第 ${i} 段，包含 unique-key-${i} 和足够长的说明文字。`)
    await store.add({ text: paragraphs.join('\n\n'), source: 'large' })
    const res = await store.retrieve('unique-key-37', { topK: 3 })
    assert.ok(res.results.some((r) => r.content.includes('unique-key-37')))
  } finally {
    t.cleanup()
  }
})

test('T5 special chars and unicode', async () => {
  const t = tmpStore()
  try {
    const store = await createMemoryStore({ storeDir: t.dir, renderer: createMockRenderer(), ocr: createMockOcr({ transcript: '' }), tiers: DEFAULT_TIERS })
    await store.add({ text: '中文 English 日本語 🚀 # ** {} => <tag> "quotes" \'single\'', source: 'weird' })
    const res = await store.retrieve('日本語', { topK: 3 })
    assert.equal(res.results.length, 1)
    assert.ok(res.results[0].content.includes('日本語'))
  } finally {
    t.cleanup()
  }
})

test('T7 OCR down behavior', async () => {
  const t = tmpStore()
  try {
    const deadOcr = createOcrHttpClient({ baseUrl: 'http://127.0.0.1:1/v1', timeoutMs: 500 })
    const strict = await createMemoryStore({ storeDir: join(t.dir, 'strict'), renderer: createMockRenderer(), ocr: deadOcr, tiers: DEFAULT_TIERS, requireOcr: true })
    await strict.add({ text: 'hello world', source: 'strict' })
    let threw = false
    try { await strict.retrieve('hello', { topK: 1 }) } catch { threw = true }
    assert.equal(threw, true)

    const relaxed = await createMemoryStore({ storeDir: join(t.dir, 'relaxed'), renderer: createMockRenderer(), ocr: deadOcr, tiers: DEFAULT_TIERS, requireOcr: false })
    await relaxed.add({ text: 'hello world', source: 'relaxed' })
    const res = await relaxed.retrieve('hello', { topK: 1 })
    assert.equal(res.results.length, 1)
  } finally {
    t.cleanup()
  }
})

test('T8 concurrent store integrity', async () => {
  const t = tmpStore()
  try {
    const store = await createMemoryStore({ storeDir: t.dir, renderer: createMockRenderer(), ocr: createMockOcr({ transcript: '' }), tiers: DEFAULT_TIERS })
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.add({ text: `concurrent item ${i}`, source: `c${i}` })))
    assert.equal(store.entries.length, 20)
    const manifest = JSON.parse(await import('node:fs/promises').then((fs) => fs.readFile(join(t.dir, 'memories.json'), 'utf8')))
    assert.equal(manifest.entries.length, 20)
  } finally {
    t.cleanup()
  }
})

test('T9 path traversal safety', async () => {
  const t = tmpStore()
  try {
    const store = await createMemoryStore({ storeDir: t.dir, renderer: createMockRenderer(), ocr: createMockOcr({ transcript: '' }), tiers: DEFAULT_TIERS })
    const evil = await store.add({ text: 'safe content', source: '../../../../outside' })
    assert.ok(!evil.id.includes('..'))
    assert.ok(!evil.id.includes('/'))
    assert.ok(!evil.id.includes('\\'))
    assert.ok(!existsSync(join(t.dir, '..', 'outside-file')))
  } finally {
    t.cleanup()
  }
})

test('T10 corrupt store recovery', async () => {
  const t = tmpStore()
  try {
    const store = await createMemoryStore({ storeDir: t.dir, renderer: createMockRenderer(), ocr: createMockOcr({ transcript: '' }), tiers: DEFAULT_TIERS })
    await store.add({ text: 'before corruption', source: 'x' })
    writeFileSync(join(t.dir, 'memories.json'), '{bad json', 'utf8')
    const store2 = await createMemoryStore({ storeDir: t.dir, renderer: createMockRenderer(), ocr: createMockOcr({ transcript: '' }), tiers: DEFAULT_TIERS })
    assert.equal(store2.entries.length, 0)
  } finally {
    t.cleanup()
  }
})

test('T11 long-run 500 rounds', async () => {
  const t = tmpStore()
  try {
    const store = await createMemoryStore({ storeDir: t.dir, renderer: createMockRenderer(), ocr: createMockOcr({ transcript: '' }), tiers: DEFAULT_TIERS })
    for (let i = 0; i < 500; i++) {
      const text = `round ${i} content ${i}`
      await store.add({ text, source: `r${i}` })
      const res = await store.retrieve(`content ${i}`, { topK: 1 })
      assert.equal(res.results.length, 1)
      await store.remove(res.results[0].entryId)
    }
    assert.equal(store.entries.length, 0)
  } finally {
    t.cleanup()
  }
})

test('T12 concurrent active recall', async () => {
  const t = tmpStore()
  try {
    const store = await createMemoryStore({ storeDir: t.dir, renderer: createMockRenderer(), ocr: createMockOcr({ transcript: '' }), tiers: DEFAULT_TIERS })
    for (let i = 0; i < 10; i++) await store.add({ text: `other ${i}`, source: `o${i}` })
    await store.add({ text: 'shared target needle', source: 'target' })
    for (const e of store.entries) e.createdAt = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString()
    await Promise.all(Array.from({ length: 10 }, () => store.retrieve('needle', { topK: 1 })))
    const after = await store.list()
    assert.equal(after.find((e) => e.id.includes('target')).tier, 'vivid')
    assert.equal(after.filter((e) => e.tier === 'vivid').length, 1)
  } finally {
    t.cleanup()
  }
})

test('T13 OCR1 resolution mode alignment', async () => {
  const t = tmpStore()
  try {
    const store = await createMemoryStore({ storeDir: t.dir, renderer: createMockRenderer(), ocr: createMockOcr({ transcript: '' }), tiers: DEFAULT_TIERS })
    const fresh = await store.add({ text: 'mode test', source: 'mode' })
    assert.ok(fresh.imagePath.includes('vivid.png'))
    store.entries[0].createdAt = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString()
    assert.equal((await store.list())[0].resolution, 1024)
    store.entries[0].createdAt = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString()
    assert.equal((await store.list())[0].resolution, 640)
  } finally {
    t.cleanup()
  }
})

test('T14 compression ratio metrics', async () => {
  const t = tmpStore()
  try {
    const store = await createMemoryStore({ storeDir: t.dir, renderer: createMockRenderer(), ocr: createMockOcr({ transcript: '' }), tiers: DEFAULT_TIERS })
    await store.add({ text: 'Orbit API 需要登录并携带 token。', source: 'm1' })
    const entries = store.entries
    const metrics = memoryMetrics(entries, DEFAULT_TIERS)
    assert.equal(metrics.length, 1)
    assert.equal(metrics[0].tier, 'vivid')
    assert.equal(metrics[0].visualTokens, 400)
    assert.ok(metrics[0].compressionRatio > 0)
    assert.ok(metrics[0].textTokens > 0)
    assert.equal(metrics[0].measuredPromptTokens, null)
  } finally {
    t.cleanup()
  }
})

test('T15 real OCR measured prompt tokens', { skip: !(await ocrServerUp()) }, async () => {
  const t = tmpStore()
  try {
    const renderer = createRenderer({ python: process.env.PYTHON || 'python', renderCommand: join(process.cwd(), 'scripts', 'render_memory.py') })
    const store = await createMemoryStore({
      storeDir: t.dir,
      renderer,
      ocr: createOcrHttpClient({ baseUrl: 'http://127.0.0.1:18080/v1', model: 'deepseek-ocr', repeatPenalty: 1.2, noRepeatNgramSize: 30, timeoutMs: 120000 }),
      tiers: DEFAULT_TIERS,
      requireOcr: true,
    })
    await store.add({ text: 'Orbit API 需要登录并携带 token。', source: 'real-metrics' })
    await store.ensureOcr(store.entries[0])
    assert.ok(store.entries[0].ocrUsage, 'expected ocrUsage to be recorded')
    assert.ok(store.entries[0].ocrUsage.promptTokens > 0, 'expected measured prompt_tokens > 0')
  } finally {
    t.cleanup()
  }
})

test('T16 real OCR approximate visual token metrics', { skip: !(await ocrServerUp()) }, async () => {
  const t = tmpStore()
  try {
    const renderer = createRenderer({ python: process.env.PYTHON || 'python', renderCommand: join(process.cwd(), 'scripts', 'render_memory.py') })
    const store = await createMemoryStore({
      storeDir: t.dir,
      renderer,
      ocr: createOcrHttpClient({ baseUrl: 'http://127.0.0.1:18080/v1', model: 'deepseek-ocr', repeatPenalty: 1.2, noRepeatNgramSize: 30, timeoutMs: 120000 }),
      tiers: DEFAULT_TIERS,
      requireOcr: true,
    })
    await store.add({ text: 'Orbit API 需要登录并携带 token。', source: 'real-metrics2' })
    await store.ensureOcr(store.entries[0])
    const metrics = memoryMetrics(store.entries, DEFAULT_TIERS)
    assert.equal(metrics.length, 1)
    assert.ok(metrics[0].measuredPromptTokens > 0)
    assert.ok(metrics[0].measuredVisualTokensApprox > 0)
    assert.ok(metrics[0].measuredCompressionRatioApprox > 0)
  } finally {
    t.cleanup()
  }
})

test('T17 update resolves conflict to latest value', async () => {
  const t = tmpStore()
  try {
    const store = await createMemoryStore({ storeDir: t.dir, renderer: createMockRenderer(), ocr: createMockOcr({ transcript: '' }), tiers: DEFAULT_TIERS })
    const old = await store.add({ text: '服务器地址是 A', source: 'server' })
    await store.update(old.id, { text: '服务器地址改为 B' })
    const res = await store.retrieve('当前服务器地址', { topK: 3 })
    assert.ok(res.results.some((r) => r.content.includes('B')))
    assert.ok(!res.results.some((r) => r.content.includes('是 A')))
    assert.equal(store.entries.length, 1)
  } finally {
    t.cleanup()
  }
})

test('T18 selective forgetting at core level', async () => {
  const t = tmpStore()
  try {
    const store = await createMemoryStore({ storeDir: t.dir, renderer: createMockRenderer(), ocr: createMockOcr({ transcript: '' }), tiers: DEFAULT_TIERS })
    const added = await store.add({ text: '临时密码是 Temp-123', source: 'temp' })
    const before = await store.retrieve('临时密码', { topK: 3 })
    assert.ok(before.results.some((r) => r.content.includes('Temp-123')))
    await store.remove(added.id)
    const after = await store.retrieve('临时密码', { topK: 3 })
    assert.ok(!after.results.some((r) => r.content.includes('Temp-123')))
  } finally {
    t.cleanup()
  }
})

test('T19 multi-session persistence at core level', async () => {
  const t = tmpStore()
  try {
    const store1 = await createMemoryStore({ storeDir: t.dir, renderer: createMockRenderer(), ocr: createMockOcr({ transcript: '' }), tiers: DEFAULT_TIERS })
    await store1.add({ text: '用户喜欢喝咖啡', source: 'user' })
    const store2 = await createMemoryStore({ storeDir: t.dir, renderer: createMockRenderer(), ocr: createMockOcr({ transcript: '' }), tiers: DEFAULT_TIERS })
    const res = await store2.retrieve('咖啡', { topK: 3 })
    assert.ok(res.results.some((r) => r.content.includes('咖啡')))
  } finally {
    t.cleanup()
  }
})

test('T20 measured visual tokens use text-only baseline', async () => {
  const entries = [{
    id: 'x',
    source: 's',
    tier: 'vivid',
    resolution: 1280,
    segments: [{ id: 1, content: 'hello world' }],
    ocrUsage: { promptTokens: 405 },
  }]
  const metrics = memoryMetrics(entries, DEFAULT_TIERS)
  assert.equal(metrics[0].measuredPromptTokens, 405)
  assert.equal(metrics[0].measuredVisualTokensApprox, 400)
})

test('T21 text-only prompt token calibration', { skip: !(await ocrServerUp()) }, async () => {
  const r = await measureTextOnlyPromptTokens({ baseUrl: 'http://127.0.0.1:18080/v1', model: 'deepseek-ocr' })
  assert.ok(r.promptTokens > 0)
})

test('T22 same-source store updates existing memory', async () => {
  const t = tmpStore()
  try {
    const store = await createMemoryStore({ storeDir: t.dir, renderer: createMockRenderer(), ocr: createMockOcr({ transcript: '' }), tiers: DEFAULT_TIERS })
    const a = await store.add({ text: '服务器地址是 A', source: 'server' })
    const b = await store.add({ text: '服务器地址改为 B', source: 'server' })
    assert.equal(a.id, b.id)
    assert.equal(b.updated, true)
    assert.equal(store.entries.length, 1)
    const res = await store.retrieve('当前服务器地址', { topK: 3 })
    assert.ok(res.results.some((r) => r.content.includes('B')))
    assert.ok(!res.results.some((r) => r.content.includes('是 A')))
  } finally {
    t.cleanup()
  }
})

test('T23 optical memory stores visual token metadata', { skip: !(await ocrServerUp()) }, async () => {
  const t = tmpStore()
  try {
    const renderer = createRenderer({ python: process.env.PYTHON || 'python', renderCommand: join(process.cwd(), 'scripts', 'render_memory.py') })
    const store = await createMemoryStore({
      storeDir: t.dir,
      renderer,
      ocr: createOcrHttpClient({ baseUrl: 'http://127.0.0.1:18080/v1', model: 'deepseek-ocr', repeatPenalty: 1.2, noRepeatNgramSize: 30, timeoutMs: 120000 }),
      tiers: DEFAULT_TIERS,
      requireOcr: true,
    })
    await store.add({ text: 'Orbit API 需要登录并携带 token。', source: 'vm' })
    await store.ensureOcr(store.entries[0])
    const vm = store.entries[0].visualMemory
    assert.ok(vm, 'expected visualMemory')
    assert.ok(vm.promptTokens > 0, 'expected visualMemory.promptTokens > 0')
    assert.ok(vm.visualTokens > 0, 'expected visualMemory.visualTokens > 0')
    assert.ok(vm.imagePath, 'expected visualMemory.imagePath')
  } finally {
    t.cleanup()
  }
})

test('T24 visual embedding stored from rendered image', { skip: !(await ocrServerUp()) }, async () => {
  const t = tmpStore()
  try {
    const renderer = createRenderer({ python: process.env.PYTHON || 'python', renderCommand: join(process.cwd(), 'scripts', 'render_memory.py') })
    const store = await createMemoryStore({
      storeDir: t.dir,
      renderer,
      ocr: createOcrHttpClient({ baseUrl: 'http://127.0.0.1:18080/v1', model: 'deepseek-ocr', repeatPenalty: 1.2, noRepeatNgramSize: 30, timeoutMs: 120000 }),
      tiers: DEFAULT_TIERS,
      requireOcr: true,
    })
    await store.add({ text: 'Orbit API 需要登录并携带 token。', source: 'embed' })
    const vm = store.entries[0].visualMemory
    assert.ok(vm.embedding, 'expected embedding')
    assert.equal(vm.embedding.length, 64)
  } finally {
    t.cleanup()
  }
})

const serverUp = await ocrServerUp()

test('T6 real OCR stability', { skip: !serverUp }, async () => {
  const t = tmpStore()
  try {
    const renderer = createRenderer({ python: process.env.PYTHON || 'python', renderCommand: join(process.cwd(), 'scripts', 'render_memory.py') })
    const store = await createMemoryStore({
      storeDir: t.dir,
      renderer,
      ocr: createOcrHttpClient({ baseUrl: 'http://127.0.0.1:18080/v1', model: 'deepseek-ocr', repeatPenalty: 1.2, noRepeatNgramSize: 30, timeoutMs: 120000 }),
      tiers: DEFAULT_TIERS,
      requireOcr: true,
    })
    await store.add({ text: 'Orbit API 需要登录并携带 token。', source: 'real' })
    const entry = store.entries[0]
    for (let i = 0; i < 3; i++) {
      const text = await store.ensureOcr(entry)
      assert.ok(text.includes('Orbit API'), `repeat ${i} missing Orbit API`)
      assert.ok(!/(?:\.\d){15,}/.test(text), `repeat ${i} repetitive garbage`)
    }
  } finally {
    t.cleanup()
  }
})
