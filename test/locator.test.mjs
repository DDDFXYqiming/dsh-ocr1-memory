import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createMemoryStore,
  createMockRenderer,
  createOcrLocatorHttpClient,
  parseBinaryRelevance,
  selectRelevanceIndices,
} from '../lib/core.js'

function tmpStore() {
  const dir = mkdtempSync(join(tmpdir(), 'ocr1-locator-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function row(token, z0, z1) {
  return {
    token,
    top_logprobs: [
      { token: '0', logprob: z0 },
      { token: '1', logprob: z1 },
    ],
  }
}

test('L1 parses calibrated 0/1 token probabilities', () => {
  const parsed = parseBinaryRelevance({
    content: '0 1 0',
    segmentCount: 3,
    logprobs: { content: [row('0', -0.1, -2), { token: ' ' }, row('1', -2, -0.1), { token: ' ' }, row('0', -0.2, -1.5)] },
  })
  assert.deepEqual(parsed.labels, [0, 1, 0])
  assert.ok(parsed.probabilities[0] < 0.4)
  assert.ok(parsed.probabilities[1] > 0.6)
  assert.ok(parsed.calibrated)
})

test('L2 Appendix fallback and Eq.12 union are both explicit', () => {
  const located = { labels: [0, 1, 0], probabilities: [0.2, 0.8, 0.3] }
  assert.deepEqual(selectRelevanceIndices(located, { threshold: 0.4, fallbackTopK: 2 }).map((x) => x.index), [1])
  assert.deepEqual(selectRelevanceIndices(located, { threshold: 0.4, fallbackTopK: 2, alwaysUnionTopK: true }).map((x) => x.index), [1, 2])
  assert.deepEqual(selectRelevanceIndices({ labels: [0, 0, 0], probabilities: [0.1, 0.3, 0.2] }, { threshold: 0.4, fallbackTopK: 2 }).map((x) => x.index), [1, 2])
})

test('L3 locator HTTP client requests strict listwise output and reads logprobs', async () => {
  let requestBody = null
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      requestBody = JSON.parse(body)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        choices: [{ message: { content: '0 1' }, logprobs: { content: [row('0', -0.1, -2), { token: ' ' }, row('1', -2, -0.1)] } }],
        usage: { prompt_tokens: 258, completion_tokens: 3, total_tokens: 261 },
      }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const t = tmpStore()
  try {
    const image = join(t.dir, 'x.png')
    writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const locate = createOcrLocatorHttpClient({ baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'trained-lora', timeoutMs: 5000 })
    const result = await locate(image, 'which evidence?', 2)
    assert.deepEqual(result.labels, [0, 1])
    assert.ok(result.probabilities[1] > 0.6)
    assert.equal(requestBody.model, 'trained-lora')
    assert.equal(requestBody.logprobs, true)
    assert.equal(requestBody.top_logprobs, 5)
    // image precedes the text prompt (training sequence is `<image>\nQuery: ...`)
    const content = requestBody.messages[0].content
    assert.equal(content[0].type, 'image_url')
    assert.match(content[1].text, /exactly 2 binary labels/)
    assert.ok(content[1].text.startsWith('\nQuery: '), 'prompt keeps the training leading newline')
    // GBNF grammar pins the decoder to exactly K space-separated 0/1 digits
    assert.equal(requestBody.grammar, 'd ::= "0" | "1"\nroot ::= d " " d')
  } finally {
    server.close()
    t.cleanup()
  }
})

test('L4 optical locator selects before deterministic raw-text fetch', async () => {
  const t = tmpStore()
  let locatorCalls = 0
  let ocrCalls = 0
  try {
    const store = await createMemoryStore({
      storeDir: t.dir,
      renderer: createMockRenderer(),
      ocr: async () => { ocrCalls++; return 'should not be called' },
      locator: async (_image, _query, count) => {
        locatorCalls++
        assert.equal(count, 2)
        return { labels: [0, 1], probabilities: [0.05, 0.95], calibrated: true }
      },
      locatorStrict: true,
      locatorTopK: 0,
    })
    await store.add({
      source: 'optical',
      segments: ['The raw query words appear here but locator rejects it.', 'Verbatim evidence selected only by the optical pointer.'],
    })
    const result = await store.retrieve('raw query words', { topK: 5 })
    assert.equal(locatorCalls, 1)
    assert.equal(ocrCalls, 0)
    assert.equal(result.results.length, 1)
    assert.equal(result.results[0].segmentId, 2)
    assert.equal(result.results[0].content, 'Verbatim evidence selected only by the optical pointer.')
  } finally {
    t.cleanup()
  }
})

test('L5 optical scan has no first-five-entry blind spot', async () => {
  const t = tmpStore()
  try {
    const visited = []
    const store = await createMemoryStore({
      storeDir: t.dir,
      renderer: createMockRenderer(),
      locator: async (imagePath) => {
        visited.push(imagePath)
        const target = imagePath.includes('target-sixth')
        return { labels: [target ? 1 : 0], probabilities: [target ? 0.99 : 0.01], calibrated: true }
      },
      locatorStrict: true,
      locatorTopK: 0,
    })
    for (let i = 1; i <= 5; i++) await store.add({ text: `distractor ${i}`, source: `distractor-${i}` })
    await store.add({ text: 'opaque payload without query terms', source: 'target-sixth' })
    const result = await store.retrieve('needle visible only to locator', { topK: 5 })
    assert.equal(visited.length, 6)
    assert.equal(result.results.length, 1)
    assert.equal(result.results[0].source, 'target-sixth')
  } finally {
    t.cleanup()
  }
})

test('L6 strict locator rejects malformed free-form output instead of lexical fallback', async () => {
  const t = tmpStore()
  try {
    const store = await createMemoryStore({
      storeDir: t.dir,
      renderer: createMockRenderer(),
      locator: async () => { throw new Error('expected 2 binary labels, received prose') },
      locatorStrict: true,
    })
    await store.add({ text: 'lexical needle that legacy retrieval would match', source: 'strict' })
    await assert.rejects(store.retrieve('lexical needle', { topK: 5 }), /binary labels/)
  } finally {
    t.cleanup()
  }
})

test('L7 tier change invalidates OCR evidence and deletes superseded image', async () => {
  const t = tmpStore()
  let at = Date.now()
  let ocrCalls = 0
  const tiers = [
    { name: 'high', maxAgeMs: 10, width: 1024, tokens: 256 },
    { name: 'low', maxAgeMs: Number.POSITIVE_INFINITY, width: 512, tokens: 64 },
  ]
  try {
    const store = await createMemoryStore({
      storeDir: t.dir,
      renderer: createMockRenderer(),
      ocr: async () => ({ text: `transcript-${++ocrCalls}` }),
      tiers,
      now: () => at,
    })
    await store.add({ text: 'tiered optical evidence', source: 'tiered' })
    const oldPath = store.entries[0].imagePath
    await store.ensureOcr(store.entries[0])
    assert.equal(store.entries[0].ocrText, 'transcript-1')
    at += 1000
    await store.list()
    assert.equal(store.entries[0].tier, 'low')
    assert.equal(store.entries[0].ocrText, null)
    assert.equal(existsSync(oldPath), false)
    assert.equal(existsSync(store.entries[0].imagePath), true)
    await store.ensureOcr(store.entries[0])
    assert.equal(store.entries[0].ocrText, 'transcript-2')
  } finally {
    t.cleanup()
  }
})

test('L8 forget removes current image, sidecar, and render-cache artifacts', async () => {
  const t = tmpStore()
  try {
    const renderer = async (_segments, outputPath) => {
      writeFileSync(outputPath, 'image')
      writeFileSync(outputPath + '.embedding.json', JSON.stringify({ embedding: [0, 1] }))
      return outputPath
    }
    const store = await createMemoryStore({ storeDir: t.dir, renderer })
    const added = await store.add({ text: 'sensitive optical payload', source: 'sensitive' })
    const imagePath = store.entries[0].imagePath
    assert.equal(existsSync(imagePath), true)
    assert.equal(existsSync(imagePath + '.embedding.json'), true)
    const cacheDir = join(t.dir, '.render-cache')
    assert.ok(readdirSync(cacheDir).length >= 1)
    await store.remove(added.id)
    assert.equal(existsSync(imagePath), false)
    assert.equal(existsSync(imagePath + '.embedding.json'), false)
    assert.deepEqual(readdirSync(cacheDir), [])
  } finally {
    t.cleanup()
  }
})
