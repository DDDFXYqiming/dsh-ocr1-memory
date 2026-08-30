import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createGovernedMemorySystem } from '../lib/memory-system.js'
import { createEmbeddingHttpClient, createMockRenderer } from '../lib/core.js'

async function makeManager() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ocr1-governance-'))
  const manager = createGovernedMemorySystem({
    memoryDir: dir,
    autoNamespace: false,
    defaultNamespace: 'test',
    renderer: createMockRenderer(),
    ocr: null,
    embedding: null,
  })
  return { dir, manager }
}

test('governed write/read/retrieve keeps optical backend optional', async () => {
  const { dir, manager } = await makeManager()
  try {
    const written = await manager.write({
      topic: 'orbit-api',
      entryType: 'fact',
      content: 'Orbit API token expires in 10 minutes.',
      evidence: 'unit test action',
      namespace: 'test',
    })
    assert.equal(written.entry_type, 'fact')
    const read = manager.read({ name: 'orbit-api', namespace: 'test' })
    assert.match(read.content, /Orbit API/)
    const retrieved = await manager.retrieve({ query: 'Orbit API', namespace: 'test' })
    assert.equal(retrieved.results.length, 1)
    assert.equal(retrieved.results[0].content.includes('Orbit API'), true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('evidence is mandatory for formal writes', async () => {
  const { dir, manager } = await makeManager()
  try {
    await assert.rejects(
      manager.write({ topic: 'missing-evidence', entryType: 'fact', content: 'x', namespace: 'test' }),
      /evidence 必填/,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('pending candidate requires acceptance and preserves provenance', async () => {
  const { dir, manager } = await makeManager()
  try {
    const pending = manager.recordPending({
      namespace: 'test',
      sourceSession: 'session-a',
      sourceSeqs: [4, 5],
      tools: ['shell'],
      topic: 'verified-path',
      entryType: 'fact',
      evidence: 'shell command succeeded',
      content: 'The verified path is X.',
    })
    assert.equal(manager.pending({ namespace: 'test' }).pending.length, 1)
    const accepted = await manager.accept({ name: pending.name, namespace: 'test' })
    assert.equal(accepted.accepted, true)
    const read = manager.read({ name: 'verified-path', namespace: 'test' })
    assert.deepEqual(read.meta.sourceSeqs, [4, 5])
    assert.equal(manager.pending({ namespace: 'test' }).pending.length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('archive hides memory and rollback restores it', async () => {
  const { dir, manager } = await makeManager()
  try {
    await manager.write({ topic: 'mutable', entryType: 'fact', content: 'A', evidence: 'initial', namespace: 'test' })
    await manager.update({ topic: 'mutable', entryType: 'fact', content: 'B', evidence: 'updated', namespace: 'test' })
    assert.equal((await manager.archive({ topic: 'mutable', entryType: 'fact', namespace: 'test' })).archived, true)
    assert.equal(manager.read({ name: 'mutable', namespace: 'test' }).not_found, true)
    const restored = await manager.rollback({ topic: 'mutable', entryType: 'fact', namespace: 'test' })
    assert.equal(restored.restored, true)
    assert.match(manager.read({ name: 'mutable', namespace: 'test' }).content, /A/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('namespaces do not leak records', async () => {
  const { dir, manager } = await makeManager()
  try {
    await manager.write({ topic: 'only-a', entryType: 'fact', content: 'A', evidence: 'test', namespace: 'test' })
    await manager.write({ topic: 'only-b', entryType: 'fact', content: 'B', evidence: 'test', namespace: 'other' })
    assert.equal(manager.read({ name: 'only-a', namespace: 'other' }).not_found, true)
    assert.equal(manager.read({ name: 'only-b', namespace: 'test' }).not_found, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('embedding retrieval observes the caller cancellation signal', async () => {
  const server = createServer((_req, _res) => {})
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  const client = createEmbeddingHttpClient({ baseUrl: `http://127.0.0.1:${port}/v1`, timeoutMs: 10_000 })
  const controller = new AbortController()
  const request = client.embedText('cancel me', { signal: controller.signal })
  await once(server, 'request')
  controller.abort()
  await assert.rejects(request, (error) => error?.name === 'AbortError' || error?.code === 'ABORT_ERR')
  server.close()
  await once(server, 'close')
})

test('maintenance keeps index and optical artifacts coherent', async () => {
  const { dir, manager } = await makeManager()
  try {
    await manager.write({ topic: 'maintain-me', entryType: 'sop', content: '# Stable\n\nstep one', evidence: 'test', namespace: 'test' })
    const report = await manager.maintain({ namespace: 'test' })
    assert.equal(report.namespace, 'test')
    assert.equal(typeof report.report.stats, 'object')
    assert.equal(report.report.status, 'completed')
    assert.match(manager.index({ namespace: 'test' }).index, /maintain-me/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('maintenance is single-flight per namespace', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ocr1-maintain-single-'))
  let release
  let refreshCalls = 0
  const gate = new Promise((resolve) => { release = resolve })
  const manager = createGovernedMemorySystem({
    memoryDir: dir,
    autoNamespace: false,
    defaultNamespace: 'test',
    storeFactory: () => ({
      async refreshTiers() {
        refreshCalls += 1
        await gate
        return { refreshed: 0, remaining: 0, complete: true }
      },
    }),
  })
  try {
    const first = manager.maintain({ namespace: 'test' })
    const second = await manager.maintain({ namespace: 'test' })
    assert.equal(second.report.status, 'already-running')
    release()
    await first
    assert.equal(refreshCalls, 1)
  } finally {
    release?.()
    await rm(dir, { recursive: true, force: true })
  }
})

test('maintenance cancellation reaches optical tier refresh', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ocr1-maintain-cancel-'))
  let entered
  const started = new Promise((resolve) => { entered = resolve })
  const manager = createGovernedMemorySystem({
    memoryDir: dir,
    autoNamespace: false,
    defaultNamespace: 'test',
    storeFactory: () => ({
      async refreshTiers({ signal }) {
        entered()
        await new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason || new Error('cancelled')), { once: true })
        })
      },
    }),
  })
  try {
    const controller = new AbortController()
    const pending = manager.maintain({ namespace: 'test', signal: controller.signal })
    await started
    controller.abort(new Error('maintenance cancelled'))
    await assert.rejects(pending, /maintenance cancelled/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('non-default namespace leaves the memoryDir root pristine', async () => {
  const { dir, manager } = await makeManager()
  try {
    // makeManager uses defaultNamespace=test, autoNamespace=false: only the
    // resolved namespace must be seeded; the root must not become a ghost default.
    assert.equal(existsSync(join(dir, 'index.txt')), false)
    assert.equal(existsSync(join(dir, 'facts.md')), false)
    assert.equal(existsSync(join(dir, 'test', 'index.txt')), true)
    assert.equal(existsSync(join(dir, 'test', 'facts.md')), true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('archive marks the optical entry archived in the shared store', async () => {
  const { dir, manager } = await makeManager()
  try {
    const written = await manager.write({
      topic: 'archivable',
      entryType: 'fact',
      content: 'memorable fact body',
      evidence: 'unit test',
      namespace: 'test',
    })
    assert.ok(written.optical?.id, 'expected an optical id')
    const store = await manager.storeFor('test')
    const before = store.entries.find((e) => e.id === written.optical.id)
    assert.equal(before.archived, false)
    await manager.archive({ topic: 'archivable', entryType: 'fact', namespace: 'test' })
    const after = store.entries.find((e) => e.id === written.optical.id)
    assert.equal(after.archived, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('syncOpticalUpdate locates entries across namespaces and preserves history', async () => {
  const { dir, manager } = await makeManager()
  try {
    const written = await manager.write({
      topic: 'far-ns-entry',
      entryType: 'fact',
      content: 'original value',
      evidence: 'unit test',
      namespace: 'other',
    })
    assert.ok(written.optical?.id)
    // No explicit namespace: the global reverse lookup must find ns=other.
    const synced = manager.syncOpticalUpdate(written.optical.id, { text: 'updated value' })
    assert.equal(synced.governed, true)
    assert.equal(synced.namespace, 'other')
    assert.equal(synced.history, true)
    assert.match(manager.read({ name: 'far-ns-entry', namespace: 'other' }).content, /updated value/)
    // A .history snapshot was written, so rollback is possible.
    assert.ok(existsSync(join(dir, 'other', '.history')))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('rejects control characters in topic to keep L1/prompt injection surface clean', async () => {
  const { dir, manager } = await makeManager()
  try {
    await assert.rejects(
      manager.write({ topic: 'bad\ntopic', entryType: 'fact', content: 'x', evidence: 'test', namespace: 'test' }),
      /topic 含换行或控制字符/,
    )
    await assert.rejects(
      manager.write({ topic: 'bad\u0000topic', entryType: 'fact', content: 'x', evidence: 'test', namespace: 'test' }),
      /topic 含换行或控制字符/,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
