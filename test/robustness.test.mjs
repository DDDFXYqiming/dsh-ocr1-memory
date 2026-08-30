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

    await store.refreshTiers()
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

    await store.refreshTiers()
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

test('M7 list is a pure query and never repairs or rerenders entries', async () => {
  const t = tmpStore()
  try {
    let renderCalls = 0
    const renderer = async (...args) => {
      renderCalls += 1
      return createMockRenderer()(...args)
    }
    const store = await createMemoryStore({ storeDir: t.dir, renderer, tiers: DEFAULT_TIERS })
    const added = await store.add({ text: 'pure list query', source: 'pure-list' })
    unlinkSync(added.imagePath)
    store.entries[0].createdAt = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString()

    const listed = await store.list()
    assert.equal(listed[0].tier, 'vivid')
    assert.equal(existsSync(added.imagePath), false)
    assert.equal(renderCalls, 1)
  } finally {
    t.cleanup()
  }
})

test('M8 tier refresh is bounded and reports remaining work', async () => {
  const t = tmpStore()
  try {
    let at = Date.now()
    const store = await createMemoryStore({ storeDir: t.dir, renderer: createMockRenderer(), tiers: DEFAULT_TIERS, now: () => at })
    for (let i = 0; i < 5; i++) await store.add({ text: `bounded refresh ${i}`, source: `bounded-${i}` })
    at += 30 * 24 * 3600 * 1000

    const first = await store.refreshTiers({ limit: 2 })
    assert.deepEqual(first, { refreshed: 2, remaining: 3, complete: false })
    assert.equal((await store.list()).filter((entry) => entry.tier === 'fuzzy').length, 2)

    const second = await store.refreshTiers({ limit: 8 })
    assert.deepEqual(second, { refreshed: 3, remaining: 0, complete: true })
    assert.equal((await store.list()).filter((entry) => entry.tier === 'fuzzy').length, 5)
  } finally {
    t.cleanup()
  }
})

test('M9 tier refresh observes cancellation inside a renderer', async () => {
  const t = tmpStore()
  try {
    let at = Date.now()
    let block = false
    const mock = createMockRenderer()
    const renderer = async (segments, outputPath, options) => {
      if (block) {
        await new Promise((resolve, reject) => {
          const aborted = () => reject(options.signal.reason || new Error('cancelled'))
          options.signal.addEventListener('abort', aborted, { once: true })
        })
      }
      return mock(segments, outputPath, options)
    }
    const store = await createMemoryStore({ storeDir: t.dir, renderer, tiers: DEFAULT_TIERS, now: () => at })
    await store.add({ text: 'cancel refresh', source: 'cancel-refresh' })
    at += 30 * 24 * 3600 * 1000
    block = true
    const controller = new AbortController()
    const pending = store.refreshTiers({ limit: 1, signal: controller.signal })
    setImmediate(() => controller.abort(new Error('cancel refresh requested')))
    await assert.rejects(pending, /cancel refresh requested/)
  } finally {
    t.cleanup()
  }
})
