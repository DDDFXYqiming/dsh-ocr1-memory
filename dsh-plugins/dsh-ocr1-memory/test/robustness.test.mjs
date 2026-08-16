import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, mkdirSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createMemoryStore, createMockRenderer, createMockOcr, DEFAULT_TIERS } from '../lib/core.js'

function tmpStore() {
  const dir = mkdtempSync(join(tmpdir(), 'ocr1robust-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('M1 multi-agent shared store sees remote additions via reload', async () => {
  const t = tmpStore()
  try {
    const store1 = await createMemoryStore({ storeDir: t.dir, renderer: createMockRenderer(), ocr: createMockOcr({ transcript: '' }), tiers: DEFAULT_TIERS, shared: true })
    const store2 = await createMemoryStore({ storeDir: t.dir, renderer: createMockRenderer(), ocr: createMockOcr({ transcript: '' }), tiers: DEFAULT_TIERS, shared: true })
    assert.equal(store2.entries.length, 0)

    await store1.add({ text: 'alpha shared memory', source: 'a' })
    const seenBy2 = await store2.list()
    assert.ok(seenBy2.some((e) => e.source === 'a'), 'store2 should see store1 addition after reload')

    await store2.add({ text: 'beta from second agent', source: 'b' })
    const seenBy1 = await store1.list()
    assert.ok(seenBy1.some((e) => e.source === 'b'), 'store1 should see store2 addition after reload')
    assert.equal(seenBy1.length, 2)
  } finally {
    t.cleanup()
  }
})

test('M2 atomic save leaves no temporary manifest residue', async () => {
  const t = tmpStore()
  try {
    const store = await createMemoryStore({ storeDir: t.dir, renderer: createMockRenderer(), ocr: createMockOcr({ transcript: '' }), tiers: DEFAULT_TIERS })
    for (let i = 0; i < 10; i++) {
      await store.add({ text: `item ${i}`, source: `s${i}` })
    }
    const leftovers = readdirSync(t.dir).filter((f) => f.endsWith('.tmp'))
    assert.deepEqual(leftovers, [])
  } finally {
    t.cleanup()
  }
})

test('M3 missing image file is re-rendered on list/refresh', async () => {
  const t = tmpStore()
  try {
    let renderCalls = 0
    const spyRenderer = async (segments, outputPath, opts) => {
      renderCalls += 1
      return createMockRenderer()(segments, outputPath, opts)
    }
    const store = await createMemoryStore({ storeDir: t.dir, renderer: spyRenderer, ocr: createMockOcr({ transcript: '' }), tiers: DEFAULT_TIERS, useRenderCache: false })
    const added = await store.add({ text: 'recover me please', source: 'recover' })
    const imagePath = added.imagePath
    assert.ok(existsSync(imagePath))
    unlinkSync(imagePath)
    assert.equal(existsSync(imagePath), false)

    await store.list()
    assert.equal(existsSync(imagePath), true, 'missing image should be re-rendered')
    assert.ok(renderCalls >= 2)
  } finally {
    t.cleanup()
  }
})

test('M4 corrupted render cache falls back to fresh render', async () => {
  const t = tmpStore()
  try {
    let renderCalls = 0
    const spyRenderer = async (segments, outputPath, opts) => {
      renderCalls += 1
      return createMockRenderer()(segments, outputPath, opts)
    }
    const store = await createMemoryStore({ storeDir: t.dir, renderer: spyRenderer, ocr: createMockOcr({ transcript: '' }), tiers: DEFAULT_TIERS, useRenderCache: true })
    await store.add({ text: 'cache corruption test', source: 'cache' })
    const imagePath = store.entries[0].imagePath
    const cacheDir = join(t.dir, '.render-cache')
    const cacheFiles = readdirSync(cacheDir).filter((f) => f.endsWith('.png'))
    assert.ok(cacheFiles.length >= 1)
    const cachePath = join(cacheDir, cacheFiles[0])

    // Corrupt the cache entry by replacing the file with a directory.
    unlinkSync(cachePath)
    mkdirSync(cachePath)
    unlinkSync(imagePath)

    await store.list()
    assert.equal(existsSync(imagePath), true, 'output image should be restored via fresh render')
    assert.ok(renderCalls >= 2)
  } finally {
    t.cleanup()
  }
})

test('M5 long input boundary: large multi-paragraph text stores and retrieves', async () => {
  const t = tmpStore()
  try {
    const paragraphs = []
    for (let i = 1; i <= 3500; i++) {
      paragraphs.push(`这是第 ${i} 段，包含足够长的说明文字用来模拟真实记忆内容。unique-needle-${i} 是这一段的关键词。`)
    }
    const text = paragraphs.join('\n\n')
    assert.ok(text.length > 200_000, `expected large text, got ${text.length}`)

    const store = await createMemoryStore({ storeDir: t.dir, renderer: createMockRenderer(), ocr: createMockOcr({ transcript: '' }), tiers: DEFAULT_TIERS })
    const added = await store.add({ text, source: 'large' })
    assert.ok(added.segments >= 3500)

    const res = await store.retrieve('unique-needle-399', { topK: 3 })
    assert.ok(res.results.some((r) => r.content.includes('unique-needle-399')))
  } finally {
    t.cleanup()
  }
})

test('M6 single very long paragraph is split without data loss', async () => {
  const t = tmpStore()
  try {
    const longLine = 'word '.repeat(50_000)
    const store = await createMemoryStore({ storeDir: t.dir, renderer: createMockRenderer(), ocr: createMockOcr({ transcript: '' }), tiers: DEFAULT_TIERS })
    await store.add({ text: longLine, source: 'longline' })
    const joined = store.entries[0].segments.map((s) => s.content).join('')
    assert.ok(joined.includes('word word'))
    assert.ok(joined.length >= 200_000)
  } finally {
    t.cleanup()
  }
})
