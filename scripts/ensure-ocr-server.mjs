// Ensure the DeepSeek-OCR llama-server is running.
// Usage: node scripts/ensure-ocr-server.mjs [port] [modelDir] [serverPath]
import { ensureOcrServer } from '../lib/ocr-server.js'

const PORT = Number(process.argv[2] || process.env.OCR_PORT || 18080)
const MODEL_DIR = process.argv[3] || process.env.OCR_MODEL_DIR || ''
const SERVER_PATH = process.argv[4] || process.env.OCR_SERVER_PATH || ''
const BASE = `http://127.0.0.1:${PORT}/v1`

try {
  const options = { baseUrl: BASE, port: PORT }
  // Do not pass empty strings: ensureOcrServer resolves the executable from
  // OCR_SERVER_PATH/PATH and the model directory from OCR_MODEL_DIR.
  if (MODEL_DIR) options.modelDir = MODEL_DIR
  if (SERVER_PATH) options.serverPath = SERVER_PATH
  const result = await ensureOcrServer(options)
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
