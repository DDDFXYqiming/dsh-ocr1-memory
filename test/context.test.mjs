import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readMemoryContextSnapshot, readMemoryIndexContext } from '../lib/context.js'
import { apply, inject } from '../lib/index.js'

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'ocr1-context-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('context snapshot ranks hot memories and stays within the character budget', () => {
  const t = tempDir()
  try {
    writeFileSync(join(t.dir, 'memories.json'), JSON.stringify({ entries: [
      {
        id: 'cold',
        source: 'old-note',
        tier: 'fuzzy',
        hits: 1,
        createdAt: '2025-01-01T00:00:00.000Z',
        segments: [{ id: 1, content: 'cold content' }],
      },
      {
        id: 'hot',
        source: 'active-note',
        tier: 'vivid',
        hits: 4,
        lastAccessAt: '2026-01-01T00:00:00.000Z',
        segments: [{ id: 1, content: 'hot content with enough text to exercise truncation' }],
      },
    ] }, null, 2), 'utf8')

    const snapshot = readMemoryContextSnapshot({ storeDir: t.dir, maxEntries: 2, maxChars: 400 })
    assert.match(snapshot, /^\[OCR1 memory context\]/)
    assert.ok(snapshot.indexOf('active-note') < snapshot.indexOf('old-note'))
    const truncated = readMemoryContextSnapshot({ storeDir: t.dir, maxEntries: 2, maxChars: 90 })
    assert.ok(truncated.length <= 90)
    assert.match(truncated, /…$/)
  } finally {
    t.cleanup()
  }
})

test('context snapshot is empty for missing or malformed manifests', () => {
  const missing = tempDir()
  try {
    assert.equal(readMemoryContextSnapshot({ storeDir: missing.dir }), '')
  } finally {
    missing.cleanup()
  }

  const malformed = tempDir()
  try {
    writeFileSync(join(malformed.dir, 'memories.json'), '{not-json', 'utf8')
    assert.equal(readMemoryContextSnapshot({ storeDir: malformed.dir }), '')
  } finally {
    malformed.cleanup()
  }
})

test('context snapshot skips empty segments and limits entry count', () => {
  const t = tempDir()
  try {
    writeFileSync(join(t.dir, 'memories.json'), JSON.stringify({ entries: [
      { id: 'empty', hits: 99, segments: [{ id: 1, content: '' }] },
      { id: 'one', hits: 2, segments: [{ id: 1, content: 'one content' }] },
      { id: 'two', hits: 1, segments: [{ id: 1, content: 'two content' }] },
    ] }), 'utf8')
    const snapshot = readMemoryContextSnapshot({ storeDir: t.dir, maxEntries: 1, maxChars: 400 })
    assert.match(snapshot, /one content/)
    assert.doesNotMatch(snapshot, /two content/)
    assert.doesNotMatch(snapshot, /empty/)
  } finally {
    t.cleanup()
  }
})

test('index context injects pointers and optical metadata without memory bodies', () => {
  const t = tempDir()
  try {
    const namespaceDir = join(t.dir, 'project')
    mkdirSync(namespaceDir, { recursive: true })
    writeFileSync(join(namespaceDir, 'index.txt'), '# L1\\n- [L2] runtime-fact -> memory_read', 'utf8')
    writeFileSync(join(t.dir, 'memories.json'), JSON.stringify({ entries: [
      { id: 'opt-1', source: 'legacy-note', tier: 'normal', hits: 3, segments: [{ id: 1, content: 'secret body must be fetched explicitly' }] },
    ] }), 'utf8')
    const context = readMemoryIndexContext({
      memoryDir: t.dir,
      defaultNamespace: 'project',
      autoNamespace: false,
      opticalStoreDir: t.dir,
      maxEntries: 3,
      maxChars: 2000,
    })
    assert.match(context, /runtime-fact/)
    assert.match(context, /legacy-note/)
    assert.doesNotMatch(context, /secret body must be fetched explicitly/)
  } finally {
    t.cleanup()
  }
})

test('plugin registers an opt-in synchronous system-prompt context', async () => {
  const t = tempDir()
  try {
    writeFileSync(join(t.dir, 'memories.json'), JSON.stringify({ entries: [
      { id: 'registered', source: 'test', tier: 'vivid', hits: 1, segments: [{ id: 1, content: 'registered context' }] },
    ] }), 'utf8')
    const registeredTools = []
    const effects = []
    let contribution = null
    const ctx = {
      tools: {
        register(tool) {
          registeredTools.push(tool)
          return () => {}
        },
      },
      systemPrompt: {
        context(value) {
          contribution = value
          return () => { contribution = null }
        },
      },
      effect(factory) {
        const disposer = factory()
        if (typeof disposer === 'function') effects.push(disposer)
      },
    }

    assert.deepEqual(inject, ['tools', 'systemPrompt', 'skills', 'agents', 'sessionQuery'])
    apply(ctx, {
      storeDir: t.dir,
      memoryDir: t.dir,
      useMockRenderer: true,
      autoInjectContext: true,
      contextMode: 'snapshot',
      contextMaxEntries: 1,
      contextMaxChars: 200,
      opticalLocatorEnabled: true,
      opticalLocatorBaseUrl: 'http://127.0.0.1:18081/v1',
      opticalLocatorAutoStart: false,
    })
    assert.equal(registeredTools.length, 26)
    const status = await registeredTools.find((tool) => tool.name === 'ocr1_mem_status').execute({})
    assert.equal(status.opticalLocatorEnabled, true)
    assert.equal(status.opticalLocatorBaseUrl, 'http://127.0.0.1:18081/v1')
    assert.equal(status.opticalLocatorAutoStart, false)
    assert.equal(contribution?.name, 'ocr1-memory:context')
    assert.equal(typeof contribution?.text, 'function')
    assert.match(contribution.text({}), /registered context/)
    for (const f of effects) await f()
    assert.equal(contribution, null)
  } finally {
    t.cleanup()
  }
})

test('index context keeps closing sentinel when the index body is truncated', () => {
  const t = tempDir()
  try {
    const ns = join(t.dir, 'ns')
    mkdirSync(ns, { recursive: true })
    // A long untrusted index body that would exceed any small char budget.
    const longIndex = `# index\n${Array.from({ length: 60 }, (_, i) => `[L2] entry-${i}`).join('\n')}`
    writeFileSync(join(ns, 'index.txt'), longIndex, 'utf8')
    const context = readMemoryIndexContext({
      memoryDir: t.dir,
      defaultNamespace: 'ns',
      autoNamespace: false,
      maxChars: 120,
    })
    assert.match(context, /\[L2…/)
    // The closing sentinel must remain intact even though the body is truncated.
    assert.match(context, /<\/memory_index>\s*$/)
  } finally {
    t.cleanup()
  }
})

test('optical catalog hides archived entries', () => {
  const t = tempDir()
  try {
    writeFileSync(join(t.dir, 'memories.json'), JSON.stringify({ entries: [
      { id: 'live', source: 'active', tier: 'vivid', hits: 3, archived: false, segments: [{ id: 1, content: 'active body' }] },
      { id: 'gone', source: 'archived-note', tier: 'fuzzy', hits: 9, archived: true, segments: [{ id: 1, content: 'archived body' }] },
    ] }), 'utf8')
    const context = readMemoryIndexContext({
      opticalStoreDir: t.dir,
      maxEntries: 5,
      maxChars: 4000,
    })
    assert.match(context, /active/)
    assert.doesNotMatch(context, /archived-note/)
  } finally {
    t.cleanup()
  }
})
