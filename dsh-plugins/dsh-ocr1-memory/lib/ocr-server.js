// OCR server lifecycle helpers for dsh-ocr1-memory.
import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
const DEFAULT_START_SCRIPT = join(PLUGIN_DIR, '..', 'scripts', 'start-ocr-server.ps1')
const DEFAULT_SERVER = process.env.OCR_SERVER_PATH || 'D:\\AI_Projects\\models\\llama.cpp\\llama-server.exe'

function healthUrl(baseUrl) {
  const base = String(baseUrl || 'http://127.0.0.1:18080/v1').replace(/\/+$/, '')
  return base.replace(/\/v1$/, '') + '/health'
}

export async function isOcrServerUp({ baseUrl = 'http://127.0.0.1:18080/v1', timeoutMs = 3000 } = {}) {
  try {
    const res = await fetch(healthUrl(baseUrl), { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return false
    const json = await res.json()
    return json.status === 'ok'
  } catch {
    return false
  }
}

export async function ensureOcrServer({
  baseUrl = 'http://127.0.0.1:18080/v1',
  modelDir = process.env.OCR_MODEL_DIR || 'D:\\AI_Projects\\models\\deepseek-ocr-gguf',
  port = 18080,
  serverPath = DEFAULT_SERVER,
  modelFile = 'deepseek-ocr-Q4_K_M.gguf',
  mmprojFile = 'mmproj-deepseek-ocr-q8_0.gguf',
  timeoutMs = 120000,
  embeddings = false,
  pooling = 'mean',
  batchSize = 2048,
  ubatchSize = 2048,
  contextSize = 8192,
  parallelSlots = 1,
} = {}) {
  if (await isOcrServerUp({ baseUrl })) {
    return { started: false, reason: 'already-up' }
  }
  if (!serverPath || !modelDir) {
    throw new Error('OCR server auto-start requires serverPath and modelDir (set via Config, OCR_SERVER_PATH, OCR_MODEL_DIR, or ensure-ocr-server args)')
  }
  const args = [
    '--host', '127.0.0.1',
    '--port', String(port),
    '-m', join(modelDir, modelFile),
    '--mmproj', join(modelDir, mmprojFile),
    '--alias', 'deepseek-ocr',
    '-c', String(contextSize),
    '-np', String(parallelSlots),
    '-n', '1024',
  ]
  // DeepSeek-OCR with --embeddings --pooling mean serves both /v1/chat/completions
  // and /v1/embeddings from a single instance, so always start in combined mode.
  args.push('--embeddings', '--pooling', pooling)
  if (batchSize > 0) args.push('-b', String(batchSize))
  if (ubatchSize > 0) args.push('-ub', String(ubatchSize))
  const child = spawn(serverPath, args, { detached: true, stdio: 'pipe', windowsHide: true })
  // Discard output but keep pipes open so the spawned server is not tied to a
  // closed console (Windows quirk observed during auto-restart testing).
  child.stdout.on('data', () => {})
  child.stderr.on('data', () => {})
  child.unref()
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isOcrServerUp({ baseUrl })) {
      return { started: true, pid: child.pid }
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`OCR server did not become healthy within ${timeoutMs}ms (${baseUrl})`)
}
