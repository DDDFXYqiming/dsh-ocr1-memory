import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  splitSegments,
  scoreSegment,
  tokenize,
  retrieveSegments,
  tierIndexFor,
  createMemoryStore,
  createMockRenderer,
  createMockOcr,
  DEFAULT_TIERS,
} from '../lib/core.js'

function tmpStore() {
  const dir = mkdtempSync(join(tmpdir(), 'ocr1mem-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('splitSegments splits on blank lines and preserves ids', () => {
  const segs = splitSegments('第一段。\n\n第二段内容，比较长。\n\n第三段。')
  assert.equal(segs.length, 3)
  assert.deepEqual(segs.map((s) => s.id), [1, 2, 3])
  assert.match(segs[0].content, /第一段/)
})

test('scoreSegment favours exact token overlap', () => {
  const q = ['orbit', 'api']
  assert.ok(scoreSegment(q, 'The orbit API docs') > scoreSegment(q, 'unrelated text'))
  assert.equal(scoreSegment(q, ''), 0)
})

test('tokenize splits CJK into character tokens so Chinese queries can match', () => {
  const storeTokens = tokenize('用户要求所有回复使用中文')
  assert.ok(storeTokens.includes('中'))
  assert.ok(storeTokens.includes('文'))
  const q = tokenize('用户回复语言要求')
  // 用户 / 回复 / 要求 characters overlap between the rule and the query.
  const overlap = q.filter((t) => storeTokens.includes(t))
  assert.ok(overlap.length >= 3, `expected CJK overlap, got ${JSON.stringify(overlap)}`)
  assert.ok(scoreSegment(q, '用户要求所有回复使用中文') > 0.01)
})

test('tier ages memory from vivid to fuzzy', () => {
  const entry = { createdAt: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString() }
  assert.equal(tierIndexFor(entry, DEFAULT_TIERS), 2) // fuzzy
  const fresh = { createdAt: new Date().toISOString() }
  assert.equal(tierIndexFor(fresh, DEFAULT_TIERS), 0) // vivid
})

test('store + retrieve returns verbatim segments and uses OCR text', async () => {
  const t = tmpStore()
  try {
    let ocrCalls = 0
    const transcripts = ['orbit api login', 'weather sunny today']
    const spyOcr = async () => { ocrCalls++; return transcripts[ocrCalls - 1] || '' }
    const store = await createMemoryStore({
      storeDir: t.dir,
      renderer: createMockRenderer(),
      ocr: spyOcr,
      tiers: DEFAULT_TIERS,
    })
    await store.add({ text: 'Orbit API 需要登录才能调用。\n\n这是一个无关段落。', source: 'test' })
    await store.add({ text: '完全不同的内容，关于天气。', source: 'other' })
    const res = await store.retrieve('orbit 登录', { topK: 3 })
    assert.equal(res.results.length, 1)
    assert.match(res.results[0].content, /Orbit API 需要登录/)
    assert.ok(ocrCalls >= 1)
    const listed = await store.list()
    assert.equal(listed.length, 2)
  } finally {
    t.cleanup()
  }
})

test('active recall promotes a fuzzy memory back to vivid on hit', async () => {
  const t = tmpStore()
  try {
    const ocr = createMockOcr({ transcript: 'astronaut orbit plan' })
    const store = await createMemoryStore({
      storeDir: t.dir,
      renderer: createMockRenderer(),
      ocr,
      tiers: DEFAULT_TIERS,
    })
    await store.add({ text: 'Astronaut orbit plan details.', source: 'a' })
    const entry = store.entries[0]
    // Age it 30 days -> fuzzy tier.
    entry.createdAt = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString()
    const before = await store.list()
    assert.equal(before[0].tier, 'fuzzy')
    const res = await store.retrieve('astronaut', { topK: 1 })
    assert.equal(res.results[0].entryId, entry.id)
    const after = await store.list()
    assert.equal(after[0].tier, 'vivid')
  } finally {
    t.cleanup()
  }
})

test('OCR read-back can drive retrieval when original tokens do not match', async () => {
  const t = tmpStore()
  try {
    const ocr = createMockOcr({ transcript: 'orbit plan flight configuration' })
    const store = await createMemoryStore({
      storeDir: t.dir,
      renderer: createMockRenderer(),
      ocr,
      tiers: DEFAULT_TIERS,
      requireOcr: true,
    })
    // The original text never mentions "orbit", but OCR claims it was read back.
    await store.add({ text: '飞行器的设计参数如下。', source: 'ocr-fallback' })
    const res = await store.retrieve('orbit', { topK: 5 })
    assert.equal(res.results.length, 1)
    assert.match(res.results[0].content, /飞行器/)
  } finally {
    t.cleanup()
  }
})

test('retrieveSegments respects topK and empty query', () => {
  const entries = [
    { id: 'a', source: 's', segments: [{ id: 1, content: 'alpha beta' }, { id: 2, content: 'gamma delta' }], ocrText: 'alpha beta gamma delta', tier: 'vivid' },
  ]
  const empty = retrieveSegments(entries, '   ', { topK: 5 })
  assert.deepEqual(empty, [])
  const r = retrieveSegments(entries, 'beta', { topK: 1 })
  assert.equal(r.length, 1)
  assert.equal(r[0].content, 'alpha beta')
})
