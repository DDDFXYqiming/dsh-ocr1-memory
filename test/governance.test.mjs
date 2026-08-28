import test from 'node:test'
import assert from 'node:assert/strict'
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
    assert.equal(manager.archive({ topic: 'mutable', entryType: 'fact', namespace: 'test' }).archived, true)
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
    assert.match(manager.index({ namespace: 'test' }).index, /maintain-me/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
