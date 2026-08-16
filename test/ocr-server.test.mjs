import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isOcrServerUp, ensureOcrServer } from '../lib/ocr-server.js'

test('OCR server health check returns false for dead endpoint', async () => {
  const up = await isOcrServerUp({ baseUrl: 'http://127.0.0.1:1/v1', timeoutMs: 1000 })
  assert.equal(up, false)
})

test('OCR server ensure returns already-up when server is healthy', { skip: !(await isOcrServerUp({ timeoutMs: 3000 })) }, async () => {
  const result = await ensureOcrServer({ baseUrl: 'http://127.0.0.1:18080/v1' })
  assert.deepEqual(result, { started: false, reason: 'already-up' })
})
