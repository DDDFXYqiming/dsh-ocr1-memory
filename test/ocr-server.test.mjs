import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { isOcrServerUp, ensureOcrServer, serverPort } from '../lib/ocr-server.js'

test('OCR server health check returns false for dead endpoint', async () => {
  const up = await isOcrServerUp({ baseUrl: 'http://127.0.0.1:1/v1', timeoutMs: 1000 })
  assert.equal(up, false)
})

test('OCR server ensure returns already-up when server is healthy', { skip: !(await isOcrServerUp({ timeoutMs: 3000 })) }, async () => {
  const result = await ensureOcrServer({ baseUrl: 'http://127.0.0.1:18080/v1' })
  assert.deepEqual(result, { started: false, reason: 'already-up', port: 18080 })
})

test('OCR server derives the launch port from its health endpoint', () => {
  assert.equal(serverPort('http://127.0.0.1:19432/v1', 18084), 19432)
  assert.equal(serverPort('not-a-url', 18084), 18084)
})

test('concurrent OCR startup uses one spawned server and matching port', async () => {
  let healthy = false
  const server = createServer((_req, res) => {
    res.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ status: healthy ? 'ok' : 'starting' }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  let spawnCalls = 0
  let launchedArgs = []
  const spawnImpl = (_command, args) => {
    spawnCalls += 1
    launchedArgs = args
    const child = new EventEmitter()
    child.pid = 424242
    child.unref = () => {}
    setImmediate(() => { healthy = true })
    return child
  }
  try {
    const options = {
      baseUrl: `http://127.0.0.1:${port}/v1`,
      port: 18084,
      modelDir: 'X:/model',
      serverPath: 'llama-server',
      embeddings: true,
      spawnImpl,
      pollIntervalMs: 5,
      timeoutMs: 2000,
    }
    const [first, second] = await Promise.all([ensureOcrServer(options), ensureOcrServer(options)])
    assert.equal(spawnCalls, 1)
    assert.equal(launchedArgs[launchedArgs.indexOf('--port') + 1], String(port))
    assert.ok(launchedArgs.includes('--embeddings'))
    assert.equal(first.pid, 424242)
    assert.equal(second.pid, 424242)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
