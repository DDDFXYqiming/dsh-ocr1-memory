import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createEmbeddingHttpClient,
  createMemoryStore,
  createMockRenderer,
  createMockOcr,
  DEFAULT_TIERS,
  measureImageEmbedding,
  memoryMetrics,
} from '../lib/core.js'

function tmpStore() {
  const dir = mkdtempSync(join(tmpdir(), 'ocr1embed-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

async function embeddingServerUp() {
  try {
    const res = await fetch('http://127.0.0.1:18080/health', { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return false
    const json = await res.json()
    return json.status === 'ok'
  } catch {
    return false
  }
}

test('E1 measureImageEmbedding uses media marker and reports direct visual tokens', async () => {
  let propsCalls = 0
  let embedCalls = 0
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      if (req.url === '/props' && req.method === 'GET') {
        propsCalls += 1
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ media_marker: '<__media_test__>' }))
        return
      }
      if (req.url === '/v1/embeddings' && req.method === 'POST') {
        embedCalls += 1
        const parsed = JSON.parse(body)
        if (parsed.input === '') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ usage: { prompt_tokens: 1 } }))
          return
        }
        assert.equal(parsed.input[0].prompt_string, '<__media_test__>')
        assert.ok(Array.isArray(parsed.input[0].multimodal_data))
        assert.match(parsed.input[0].multimodal_data[0], /^[A-Za-z0-9+/=]+$/)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          usage: { prompt_tokens: 785 },
          data: [{ embedding: [0.1, 0.2, 0.3], index: 0, object: 'embedding' }],
        }))
        return
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'not found' }))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const t = tmpStore()
  try {
    const imagePath = join(t.dir, 'x.png')
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const result = await measureImageEmbedding({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: 'deepseek-ocr',
      imagePath,
      emptyPromptTokens: null,
      timeoutMs: 5000,
    })
    assert.equal(propsCalls, 1)
    assert.equal(embedCalls, 2) // empty calibration + image
    assert.deepEqual(result.embedding, [0.1, 0.2, 0.3])
    assert.equal(result.dim, 3)
    assert.equal(result.promptTokens, 785)
    assert.equal(result.emptyPromptTokens, 1)
    assert.equal(result.visualTokens, 784)
  } finally {
    server.close()
    t.cleanup()
  }
})

test('E2 memory store stores true multimodal embedding and direct visual tokens', async () => {
  const t = tmpStore()
  try {
    const embedding = async () => ({
      embedding: [1, 2, 3, 4],
      dim: 4,
      promptTokens: 6,
      emptyPromptTokens: 1,
      visualTokens: 5,
    })
    const store = await createMemoryStore({
      storeDir: t.dir,
      renderer: createMockRenderer(),
      ocr: createMockOcr({ transcript: 'orbit api login' }),
      embedding,
      tiers: DEFAULT_TIERS,
    })
    await store.add({ text: 'Orbit API 需要登录并携带 token。', source: 'e2' })
    const vm = store.entries[0].visualMemory
    assert.ok(vm, 'expected visualMemory')
    assert.deepEqual(vm.embedding, [1, 2, 3, 4])
    assert.equal(vm.embeddingDim, 4)
    assert.equal(vm.embeddingSource, 'deepseek-ocr-embeddings')
    assert.equal(vm.visualTokensDirect, 5)
    assert.equal(vm.embeddingPromptTokens, 6)
    const metrics = memoryMetrics(store.entries, DEFAULT_TIERS)
    assert.equal(metrics[0].measuredVisualTokensDirect, 5)
    assert.equal(metrics[0].measuredCompressionRatioDirect, metrics[0].textTokens / 5)
    assert.equal(metrics[0].embeddingDim, 4)
  } finally {
    t.cleanup()
  }
})

test('E3 embedding failure falls back to pixel embedding and records error', async () => {
  const t = tmpStore()
  try {
    const embedding = async () => { throw new Error('embedding server down') }
    const store = await createMemoryStore({
      storeDir: t.dir,
      renderer: createMockRenderer(),
      ocr: createMockOcr({ transcript: '' }),
      embedding,
      tiers: DEFAULT_TIERS,
    })
    await store.add({ text: 'fallback test', source: 'e3' })
    const vm = store.entries[0].visualMemory
    assert.ok(vm.embeddingError.includes('embedding server down'))
    // createMockRenderer does not write a pixel embedding sidecar, so embedding stays null.
    assert.equal(vm.embedding, null)
  } finally {
    t.cleanup()
  }
})

test('E5 embedding similarity is the primary retrieval signal', async () => {
  const t = tmpStore()
  try {
    const embedding = async () => ({ embedding: [0, 0, 0], dim: 3, promptTokens: 1, emptyPromptTokens: 1, visualTokens: 0 })
    embedding.embedText = async (text) => ({ embedding: text.includes('alpha') ? [1, 0, 0] : [0, 1, 0], dim: 3, promptTokens: 1 })
    const store = await createMemoryStore({
      storeDir: t.dir,
      renderer: createMockRenderer(),
      ocr: createMockOcr({ transcript: '' }),
      embedding,
      tiers: DEFAULT_TIERS,
      embeddingRetrieval: true,
    })
    await store.add({ text: '完全无关的中文内容甲', source: 'a' })
    await store.add({ text: '完全无关的英文内容乙', source: 'b' })
    store.entries[0].visualMemory.embedding = [1, 0, 0]
    store.entries[1].visualMemory.embedding = [0, 1, 0]

    const res = await store.retrieve('alpha', { topK: 3 })
    assert.ok(res.results.length > 0)
    assert.equal(res.results[0].source, 'a', 'embedding-similar memory should rank first')
  } finally {
    t.cleanup()
  }
})

test('E4 real DeepSeek-OCR embeddings server stores 1280d visual embedding', { skip: !(await embeddingServerUp()) }, async () => {
  const t = tmpStore()
  try {
    const { createRenderer } = await import('../lib/core.js')
    const renderer = createRenderer({
      python: process.env.PYTHON || 'python',
      renderCommand: join(process.cwd(), 'scripts', 'render_memory.py'),
    })
    const embedding = createEmbeddingHttpClient({
      baseUrl: 'http://127.0.0.1:18080/v1',
      model: 'deepseek-ocr',
      timeoutMs: 120000,
      emptyPromptTokens: 1,
    })
    const store = await createMemoryStore({
      storeDir: t.dir,
      renderer,
      ocr: createMockOcr({ transcript: 'Orbit API 需要登录并携带 token。' }),
      embedding,
      tiers: DEFAULT_TIERS,
      requireOcr: false,
    })
    await store.add({ text: 'Orbit API 需要登录并携带 token。', source: 'e4' })
    const vm = store.entries[0].visualMemory
    assert.ok(Array.isArray(vm.embedding), 'expected real embedding')
    assert.equal(vm.embedding.length, 1280)
    assert.equal(vm.embeddingSource, 'deepseek-ocr-embeddings')
    assert.ok(vm.visualTokensDirect > 0, 'expected direct visual tokens')
    assert.ok(vm.embeddingPromptTokens > 0, 'expected embedding prompt tokens')
  } finally {
    t.cleanup()
  }
})
