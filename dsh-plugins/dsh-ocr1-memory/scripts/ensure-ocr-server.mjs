// Ensure the DeepSeek-OCR llama-server is running.
// Usage: node scripts/ensure-ocr-server.mjs [port] [modelDir] [serverPath]
import { ensureOcrServer } from '../lib/ocr-server.js'

const PORT = Number(process.argv[2] || process.env.OCR_PORT || 18080)
const MODEL_DIR = process.argv[3] || process.env.OCR_MODEL_DIR || ''
const SERVER_PATH = process.argv[4] || process.env.OCR_SERVER_PATH || ''
const BASE = `http://127.0.0.1:${PORT}/v1`

try {
  const result = await ensureOcrServer({ baseUrl: BASE, modelDir: MODEL_DIR, port: PORT, serverPath: SERVER_PATH })
  if (result.started) {
    console.log(`OCR server started: ${BASE}`)
  } else {
    console.log(`OCR server already up: ${BASE}`)
  }
  process.exit(0)
} catch (err) {
  console.error(err?.message || err)
  process.exit(1)
}
