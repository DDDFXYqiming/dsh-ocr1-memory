// OCR server lifecycle helpers for dsh-ocr1-memory.
import { spawn } from 'node:child_process'
import { join } from 'node:path'

function resolveDefaultServer() {
  return process.env.OCR_SERVER_PATH || 'llama-server'
}

const DEFAULT_SERVER = resolveDefaultServer()
const ensureRuns = new Map()

function healthUrl(baseUrl) {
  const base = String(baseUrl || 'http://127.0.0.1:18080/v1').replace(/\/+$/, '')
  return base.replace(/\/v1$/, '') + '/health'
}

export function serverPort(baseUrl, fallbackPort) {
  try {
    const parsed = new URL(baseUrl)
    if (parsed.port) return Number(parsed.port)
  } catch {
    // The health request will report an invalid URL with its normal error path.
  }
  return Number(fallbackPort)
}

function requestSignal(signal, timeoutMs) {
  return signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs)
}

function wait(ms, signal) {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms)
    function done() {
      signal?.removeEventListener('abort', aborted)
      resolve()
    }
    function aborted() {
      clearTimeout(timer)
      signal.removeEventListener('abort', aborted)
      reject(signal.reason || new Error('OCR server startup aborted'))
    }
    signal?.addEventListener('abort', aborted, { once: true })
  })
}

async function awaitWithSignal(promise, signal) {
  if (!signal) return promise
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort)
      reject(signal.reason || new Error('OCR server startup aborted'))
    }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(
      (value) => { signal.removeEventListener('abort', abort); resolve(value) },
      (error) => { signal.removeEventListener('abort', abort); reject(error) },
    )
  })
}

export async function isOcrServerUp({ baseUrl = 'http://127.0.0.1:18080/v1', timeoutMs = 3000, signal = null } = {}) {
  try {
    const res = await fetch(healthUrl(baseUrl), { signal: requestSignal(signal, timeoutMs) })
    if (!res.ok) return false
    const json = await res.json()
    return json.status === 'ok'
  } catch (error) {
    if (signal?.aborted) throw error
    return false
  }
}

export async function stopOcrServer(pid) {
  const numericPid = Number(pid)
  if (!Number.isInteger(numericPid) || numericPid <= 0) return false
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(numericPid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      killer.once('error', resolve)
      killer.once('exit', resolve)
    })
    return true
  }
  try {
    process.kill(-numericPid, 'SIGTERM')
  } catch {
    try { process.kill(numericPid, 'SIGTERM') } catch { return false }
  }
  return true
}

async function ensureOnce({
  baseUrl,
  modelDir,
  port,
  serverPath,
  modelFile,
  mmprojFile,
  timeoutMs,
  embeddings,
  pooling,
  batchSize,
  ubatchSize,
  contextSize,
  parallelSlots,
  signal,
  spawnImpl,
  pollIntervalMs,
}) {
  signal?.throwIfAborted()
  if (await isOcrServerUp({ baseUrl, signal })) {
    return { started: false, reason: 'already-up', port: serverPort(baseUrl, port) }
  }
  if (!serverPath || !modelDir) {
    throw new Error('OCR server auto-start requires serverPath and modelDir (set via Config, OCR_SERVER_PATH, OCR_MODEL_DIR, or ensure-ocr-server args)')
  }
  const listenPort = serverPort(baseUrl, port)
  const args = [
    '--host', '127.0.0.1',
    '--port', String(listenPort),
    '-m', join(modelDir, modelFile),
    '--mmproj', join(modelDir, mmprojFile),
    '--alias', 'deepseek-ocr',
    '-c', String(contextSize),
    '-np', String(parallelSlots),
    '-n', '1024',
  ]
  if (embeddings) args.push('--embeddings', '--pooling', pooling)
  if (batchSize > 0) args.push('-b', String(batchSize))
  if (ubatchSize > 0) args.push('-ub', String(ubatchSize))

  const child = spawnImpl(serverPath, args, { detached: true, stdio: 'ignore', windowsHide: true })
  let spawnError = null
  child.once('error', (error) => { spawnError = error })
  child.unref?.()
  const deadline = Date.now() + timeoutMs
  try {
    while (Date.now() < deadline) {
      signal?.throwIfAborted()
      if (spawnError) throw new Error(`OCR server failed to spawn (${serverPath}): ${spawnError.message}`)
      if (await isOcrServerUp({ baseUrl, timeoutMs: Math.min(3000, Math.max(1, deadline - Date.now())), signal })) {
        return { started: true, pid: child.pid, port: listenPort }
      }
      await wait(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())), signal)
    }
    if (spawnError) throw new Error(`OCR server failed to spawn (${serverPath}): ${spawnError.message}`)
    throw new Error(`OCR server did not become healthy within ${timeoutMs}ms (${baseUrl})`)
  } catch (error) {
    if (child.pid) await stopOcrServer(child.pid)
    throw error
  }
}

export async function ensureOcrServer({
  baseUrl = 'http://127.0.0.1:18080/v1',
  modelDir = process.env.OCR_MODEL_DIR || '',
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
  signal = null,
  spawnImpl = spawn,
  pollIntervalMs = 1000,
} = {}) {
  const key = healthUrl(baseUrl)
  const existing = ensureRuns.get(key)
  if (existing) return awaitWithSignal(existing, signal)
  const run = ensureOnce({
    baseUrl,
    modelDir,
    port,
    serverPath,
    modelFile,
    mmprojFile,
    timeoutMs,
    embeddings,
    pooling,
    batchSize,
    ubatchSize,
    contextSize,
    parallelSlots,
    signal,
    spawnImpl,
    pollIntervalMs,
  }).finally(() => {
    ensureRuns.delete(key)
  })
  ensureRuns.set(key, run)
  return run
}
