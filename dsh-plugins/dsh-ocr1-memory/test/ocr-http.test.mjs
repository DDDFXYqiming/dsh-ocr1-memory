import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createMemoryStore, createMockRenderer, createOcrHttpClient, DEFAULT_TIERS } from '../lib/core.js'

function tmpStore() {
  const dir = mkdtempSync(join(tmpdir(), 'ocr1http-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('OCR HTTP client transcribes via OpenAI-compatible /v1/chat/completions', async () => {
  const transcript = 'orbit api login token'
  let requests = 0
  const server = createServer((req, res) => {
    requests += 1
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const parsed = JSON.parse(body)
      assert.ok(parsed.messages[0].content.some((c) => c.type === 'image_url'), 'expected image_url content')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: transcript } }] }))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const t = tmpStore()
  try {
    const ocr = createOcrHttpClient({ baseUrl: `http://127.0.0.1:${port}/v1` })
    const store = await createMemoryStore({
      storeDir: t.dir,
      renderer: createMockRenderer(),
      ocr,
      tiers: DEFAULT_TIERS,
      requireOcr: true,
    })
    await store.add({ text: 'Orbit API 需要登录并携带 token。', source: 'http' })
    const res = await store.retrieve('orbit token', { topK: 3 })
    assert.equal(res.results.length, 1)
    assert.ok(requests >= 1, 'expected OCR HTTP call during retrieve')
    assert.equal(store.entries[0].ocrText, transcript)
  } finally {
    server.close()
    t.cleanup()
  }
})

test('render cache reuses images for identical segment sets', async () => {
  const t = tmpStore()
  let renderCalls = 0
  try {
    const spyRenderer = async (segments, outputPath, opts) => {
      renderCalls += 1
      return createMockRenderer()(segments, outputPath, opts)
    }
    const store = await createMemoryStore({
      storeDir: t.dir,
      renderer: spyRenderer,
      tiers: DEFAULT_TIERS,
      useRenderCache: true,
    })
    await store.add({ text: '同一段记忆内容', source: 'a' })
    const second = await store.add({ text: '同一段记忆内容', source: 'b' })
    assert.equal(renderCalls, 1, 'second identical store should hit render cache')
    const secondEntry = store.entries.find((e) => e.id === second.id)
    assert.equal(secondEntry.renderCache.used, true)
  } finally {
    t.cleanup()
  }
})
