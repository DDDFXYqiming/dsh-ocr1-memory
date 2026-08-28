import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readMemoryContextSnapshot } from '../lib/context.js'
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

test('plugin registers an opt-in synchronous system-prompt context', async () => {
  const t = tempDir()
  try {
    writeFileSync(join(t.dir, 'memories.json'), JSON.stringify({ entries: [
      { id: 'registered', source: 'test', tier: 'vivid', hits: 1, segments: [{ id: 1, content: 'registered context' }] },
    ] }), 'utf8')
    const registeredTools = []
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
        return factory()
      },
    }

    assert.deepEqual(inject, ['tools', 'systemPrompt'])
    const dispose = apply(ctx, {
      storeDir: t.dir,
      useMockRenderer: true,
      autoInjectContext: true,
      contextMaxEntries: 1,
      contextMaxChars: 200,
    })
    assert.equal(registeredTools.length, 10)
    await registeredTools[0].execute({})
    assert.equal(contribution?.name, 'ocr1-memory:context')
    assert.equal(typeof contribution?.text, 'function')
    assert.match(contribution.text({}), /registered context/)
    dispose()
    assert.equal(contribution, null)
  } finally {
    t.cleanup()
  }
})
