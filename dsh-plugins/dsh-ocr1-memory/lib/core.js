// dsh-ocr1-memory — core memory engine.
//
// Implements the OCR1-inspired agent memory pipeline:
//   1. memory is rendered to an image (SoM numbered segments);
//   2. DeepSeek-OCR (or an OpenAI-compatible optical model) is used to read it back;
//   3. old memories are downsampled to low resolution ("vivid-to-fuzzy");
//   4. a hit triggers active recall back to high resolution;
//   5. retrieval returns the verbatim original segment text (Locate-and-Transcribe style).
//
// This module is intentionally dependency-free and unit-testable.

import { existsSync, promises as fs } from 'node:fs'
import { join, dirname, basename, extname } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'

export const DEFAULT_TIERS = [
  // Aligned to DeepSeek-OCR official resolution modes:
  // Large 1280 -> 400 tokens, Base 1024 -> 256 tokens, Small 640 -> 100 tokens.
  { name: 'vivid', maxAgeMs: 24 * 60 * 60 * 1000, width: 1280, tokens: 400 },
  { name: 'normal', maxAgeMs: 7 * 24 * 60 * 60 * 1000, width: 1024, tokens: 256 },
  { name: 'fuzzy', maxAgeMs: Number.POSITIVE_INFINITY, width: 640, tokens: 100 },
]

export function nowIso() {
  return new Date().toISOString()
}

export function tokenize(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]+/gu, ' ')
    // CJK scripts have no word boundaries: emit each CJK character as its own
    // token (same single-char-per-token convention as estimateTextTokens) so
    // Chinese queries can match Chinese memories by character overlap.
    .replace(/([\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af])/gu, ' $1 ')
    .split(/[\s_-]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/** Rough text-token estimator for compression-ratio reporting.
 * CJK characters count as 1 token each; ASCII words count ~1.3 tokens each. */
export function estimateTextTokens(text) {
  const s = String(text ?? '')
  const cjk = (s.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length
  const words = (s.replace(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, ' ').match(/[A-Za-z0-9_]+/g) || []).length
  return Math.max(1, cjk + Math.ceil(words * 1.3))
}

/** Estimate OCR1-style compression ratio: text tokens / visual tokens per memory. */
export function memoryMetrics(entries, tiers = DEFAULT_TIERS, textOnlyPromptTokens = 5) {
  return entries.map((e) => {
    const text = (e.segments || []).map((s) => s.content).join('\n')
    const textTokens = estimateTextTokens(text)
    const tier = tiers.find((t) => t.name === e.tier) || tiers[0]
    const visualTokens = tier.tokens || 0
    const measuredPromptTokens = e.ocrUsage?.promptTokens ?? null
    // prompt_tokens includes the short text prompt; subtract the calibrated
    // text-only baseline to approximate the visual-token portion.
    const measuredVisualTokensApprox = measuredPromptTokens != null
      ? Math.max(0, measuredPromptTokens - textOnlyPromptTokens)
      : null
    const visualTokensDirect = e.visualMemory?.visualTokensDirect ?? null
    const measuredVisualTokensDirect = visualTokensDirect != null && visualTokensDirect > 0 ? visualTokensDirect : null
    return {
      id: e.id,
      source: e.source || '',
      tier: e.tier,
      resolution: e.resolution,
      textTokens,
      visualTokens,
      compressionRatio: visualTokens > 0 ? textTokens / visualTokens : 0,
      measuredPromptTokens,
      measuredVisualTokensApprox,
      measuredCompressionRatioApprox: measuredVisualTokensApprox != null && measuredVisualTokensApprox > 0
        ? textTokens / measuredVisualTokensApprox
        : null,
      measuredVisualTokensDirect,
      measuredCompressionRatioDirect: measuredVisualTokensDirect != null && measuredVisualTokensDirect > 0
        ? textTokens / measuredVisualTokensDirect
        : null,
      storedVisualTokens: e.visualMemory?.visualTokens ?? null,
      embeddingDim: e.visualMemory?.embeddingDim ?? null,
      embeddingSource: e.visualMemory?.embeddingSource ?? null,
      embeddingPromptTokens: e.visualMemory?.embeddingPromptTokens ?? null,
      embeddingError: e.visualMemory?.embeddingError ?? null,
    }
  })
}

/** Split a long text into segments. Blank lines are treated as boundaries. */
export function splitSegments(text, maxLen = 800) {
  const raw = String(text ?? '')
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  const out = []
  for (const chunk of raw) {
    if (chunk.length <= maxLen) {
      out.push(chunk)
      continue
    }
    // Hard wrap long paragraphs into smaller pieces without losing text.
    let rest = chunk
    while (rest.length > maxLen) {
      let cut = rest.lastIndexOf(' ', maxLen)
      if (cut < maxLen * 0.5) cut = maxLen
      out.push(rest.slice(0, cut).trim())
      rest = rest.slice(cut).trim()
    }
    if (rest) out.push(rest)
  }
  return out.map((content, i) => ({ id: i + 1, content }))
}

export function safeId(input) {
  const s = String(input ?? '').trim().toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return s.slice(0, 64) || randomUUID().slice(0, 8)
}

export function tierIndexFor(entry, tiers = DEFAULT_TIERS, at = Date.now()) {
  const age = at - new Date(entry.createdAt).getTime()
  for (let i = 0; i < tiers.length; i++) {
    if (age <= tiers[i].maxAgeMs) return i
  }
  return tiers.length - 1
}

export function scoreSegment(queryTokens, segmentText) {
  const segTokens = tokenize(segmentText)
  if (!segTokens.length) return 0
  const counts = new Map()
  for (const t of segTokens) counts.set(t, (counts.get(t) || 0) + 1)
  let overlap = 0
  for (const t of queryTokens) {
    const c = counts.get(t) || 0
    if (c > 0) {
      overlap += 1 + Math.log(c) // favour repeated matches slightly
      counts.set(t, c - 1)
    }
  }
  return overlap / Math.sqrt(segTokens.length)
}

export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

export function scoreEntry(queryTokens, entry) {
  const original = (entry.segments || []).map((s) => s.content)
  const ocr = entry.ocrText || ''
  const originalScore = original.reduce((sum, txt) => sum + scoreSegment(queryTokens, txt), 0)
  const ocrScore = ocr ? scoreSegment(queryTokens, ocr) : 0
  // Mix original verbatim and OCR-read evidence. If OCR is unavailable, use original.
  const originalWeight = 0.5
  const ocrWeight = ocr ? 0.5 : 0
  const totalWeight = originalWeight + ocrWeight
  return {
    originalScore,
    ocrScore,
    score: (originalScore * originalWeight + ocrScore * ocrWeight) / totalWeight,
  }
}

export function retrieveSegmentsWithEmbeddings(entries, query, { topK = 5, minScore = 0.01, queryEmbedding = null, embeddingWeight = 1 } = {}) {
  const q = tokenize(query)
  if (!q.length && !queryEmbedding) return []
  const ranked = []
  for (const entry of entries) {
    const entryEmbedding = entry.visualMemory?.embedding
    const embSim = queryEmbedding && Array.isArray(entryEmbedding)
      ? cosineSimilarity(queryEmbedding, entryEmbedding)
      : 0
    const candidates = []
    for (const seg of entry.segments || []) {
      const segScore = q.length ? scoreSegment(q, seg.content) : 0
      if (segScore > minScore || embSim > 0.2) {
        candidates.push({
          seg,
          segScore,
          score: segScore + embSim * embeddingWeight,
        })
      }
    }
    // Embedding-first fallback: even without a literal text match, a highly
    // similar memory can still contribute its top segments.
    if (candidates.length === 0 && embSim > 0.2) {
      for (const seg of (entry.segments || []).slice(0, 3)) {
        candidates.push({ seg, segScore: 0, score: embSim * embeddingWeight })
      }
    }
    for (const { seg, score } of candidates) {
      ranked.push({
        entryId: entry.id,
        segmentId: seg.id,
        content: seg.content,
        source: entry.source || '',
        score,
        tier: entry.tier,
      })
    }
  }
  ranked.sort((a, b) => b.score - a.score)
  return ranked.slice(0, topK)
}

export function retrieveSegments(entries, query, { topK = 5, minScore = 0.01 } = {}) {
  const q = tokenize(query)
  if (!q.length) return []
  const ranked = []
  for (const entry of entries) {
    const est = scoreEntry(q, entry)
    const candidates = []
    for (const seg of entry.segments || []) {
      const segScore = scoreSegment(q, seg.content)
      // Locate-and-Transcribe: segments that literally match the query are the
      // primary candidates; est.score provides an OCR-read evidence boost.
      if (segScore > minScore) {
        candidates.push({ seg, segScore })
      }
    }
    if (candidates.length === 0 && est.ocrScore > minScore && entry.ocrText) {
      // OCR-level fallback: the model could not match the original tokens, but
      // DeepSeek-OCR read the query terms back from the image. Return the whole
      // entry's segments ranked by the OCR evidence so verbatim text is recovered.
      for (const seg of entry.segments || []) {
        candidates.push({ seg, segScore: est.ocrScore * 0.4 })
      }
    }
    for (const { seg, segScore } of candidates) {
      ranked.push({
        entryId: entry.id,
        segmentId: seg.id,
        content: seg.content,
        source: entry.source || '',
        score: segScore,
        tier: entry.tier,
      })
    }
  }
  ranked.sort((a, b) => b.score - a.score)
  return ranked.slice(0, topK)
}

export function createRenderer({ renderCommand, python = process.env.PYTHON || 'python' } = {}) {
  return async function render(segments, outputPath, { width = 1024, som = true } = {}) {
    if (!renderCommand) {
      throw new Error('renderer: no renderCommand configured (set renderer.command or pythonRenderScript)')
    }
    const script = renderCommand
    const payload = JSON.stringify({ segments, outputPath, width, som })
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const execFileP = promisify(execFile)
    await execFileP(python, [script, payload], { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 })
    await fs.access(outputPath)
    return outputPath
  }
}

export function createMockRenderer() {
  return async function render(segments, outputPath, { width = 1024, som = true } = {}) {
    const text = `# rendered(width=${width}, som=${som})\n` + segments.map((s) => `${s.id}: ${s.content}`).join('\n')
    await fs.mkdir(dirname(outputPath), { recursive: true })
    await fs.writeFile(outputPath, text, 'utf8')
    return outputPath
  }
}

export function createOcrHttpClient({ baseUrl = 'http://127.0.0.1:8000/v1', apiKey = '', model = 'deepseek-ai/DeepSeek-OCR', timeoutMs = 60_000, repeatPenalty = 0, noRepeatNgramSize = 0 } = {}) {
  return async function transcribe(imagePath) {
    const { readFileSync } = await import('node:fs')
    const data = readFileSync(imagePath)
    const ext = extname(imagePath).toLowerCase().replace('.', '') || 'png'
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`
    const dataUrl = `data:${mime};base64,${data.toString('base64')}`
    const body = {
      model,
      messages: [{
        role: 'user',
        content: [
          // DeepSeek-OCR is prompt-sensitive: official completion prompt is "\nFree OCR."
          { type: 'text', text: '\nFree OCR.' },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      }],
      temperature: 0,
      max_tokens: 4096,
      ...(repeatPenalty > 0 ? { repeat_penalty: repeatPenalty } : {}),
      ...(noRepeatNgramSize > 0 ? { no_repeat_ngram_size: noRepeatNgramSize } : {}),
    }
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`ocr http ${res.status}: ${text.slice(0, 500)}`)
    }
    const json = await res.json()
    const content = json?.choices?.[0]?.message?.content
    if (typeof content !== 'string') throw new Error(`ocr http: unexpected response ${JSON.stringify(json).slice(0, 500)}`)
    const usage = json?.usage
    return {
      text: content.trim(),
      usage: usage
        ? {
            promptTokens: Number(usage.prompt_tokens ?? 0),
            completionTokens: Number(usage.completion_tokens ?? 0),
            totalTokens: Number(usage.total_tokens ?? 0),
          }
        : null,
    }
  }
}

function rootUrl(baseUrl) {
  return String(baseUrl || 'http://127.0.0.1:18080/v1').replace(/\/+$/, '').replace(/\/v1$/, '')
}

async function fetchEmbeddingProps({ baseUrl = 'http://127.0.0.1:18080/v1', apiKey = '', timeoutMs = 30_000 } = {}) {
  const res = await fetch(`${rootUrl(baseUrl)}/props`, {
    method: 'GET',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`embedding props ${res.status}: ${text.slice(0, 500)}`)
  }
  return res.json()
}

export async function measureEmptyPromptTokens({ baseUrl = 'http://127.0.0.1:18080/v1', apiKey = '', model = 'deepseek-ocr', timeoutMs = 30_000 } = {}) {
  const body = { model, input: '' }
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/embeddings`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`embedding empty ${res.status}: ${text.slice(0, 500)}`)
  }
  const json = await res.json()
  const promptTokens = Number(json?.usage?.prompt_tokens ?? 0)
  if (!promptTokens) throw new Error('embedding empty: no prompt_tokens in response')
  return { promptTokens, totalTokens: Number(json?.usage?.total_tokens ?? 0) }
}

/** Measure a true multimodal embedding from a DeepSeek-OCR llama.cpp embeddings
 *  endpoint. The request uses only the server's media marker (no visible text),
 *  so prompt_tokens - emptyPromptTokens is a direct visual-token count.
 */
export async function measureImageEmbedding({
  baseUrl = 'http://127.0.0.1:18080/v1',
  apiKey = '',
  model = 'deepseek-ocr',
  imagePath,
  timeoutMs = 120_000,
  emptyPromptTokens = null,
} = {}) {
  if (!imagePath) throw new Error('embedding: imagePath is required')
  const { readFileSync } = await import('node:fs')
  const props = await fetchEmbeddingProps({ baseUrl, apiKey, timeoutMs: Math.min(timeoutMs, 30_000) })
  const marker = props?.media_marker
  if (!marker) throw new Error(`embedding: no media_marker in /props (${baseUrl})`)
  const data = readFileSync(imagePath)
  // llama.cpp multimodal embeddings expects the raw base64 payload in
  // multimodal_data (not a data: URL).
  const rawBase64 = data.toString('base64')
  const body = {
    model,
    input: [{ prompt_string: marker, multimodal_data: [rawBase64] }],
  }
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/embeddings`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`embedding image ${res.status}: ${text.slice(0, 500)}`)
  }
  const json = await res.json()
  const embedding = json?.data?.[0]?.embedding
  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new Error(`embedding image: unexpected response ${JSON.stringify(json).slice(0, 500)}`)
  }
  const promptTokens = Number(json?.usage?.prompt_tokens ?? 0)
  let emptyTokens = emptyPromptTokens
  if (emptyTokens == null) {
    emptyTokens = (await measureEmptyPromptTokens({ baseUrl, apiKey, model, timeoutMs })).promptTokens
  }
  return {
    embedding,
    dim: embedding.length,
    promptTokens,
    emptyPromptTokens: emptyTokens,
    visualTokens: promptTokens > 0 ? Math.max(0, promptTokens - emptyTokens) : null,
    mediaMarker: marker,
  }
}

/** Measure a text embedding from the same DeepSeek-OCR embeddings endpoint.
 *  Used to embed retrieval queries so visual memory embeddings can be compared
 *  in the same vector space.
 */
export async function measureTextEmbedding({
  baseUrl = 'http://127.0.0.1:18080/v1',
  apiKey = '',
  model = 'deepseek-ocr',
  text,
  timeoutMs = 60_000,
} = {}) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('embedding: text is required')
  const body = { model, input: text }
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/embeddings`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`embedding text ${res.status}: ${text.slice(0, 500)}`)
  }
  const json = await res.json()
  const embedding = json?.data?.[0]?.embedding
  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new Error(`embedding text: unexpected response ${JSON.stringify(json).slice(0, 500)}`)
  }
  return {
    embedding,
    dim: embedding.length,
    promptTokens: Number(json?.usage?.prompt_tokens ?? 0),
  }
}

export function createEmbeddingHttpClient({
  baseUrl = 'http://127.0.0.1:18080/v1',
  apiKey = '',
  model = 'deepseek-ocr',
  timeoutMs = 120_000,
  emptyPromptTokens = null,
} = {}) {
  let cachedEmptyTokens = emptyPromptTokens
  const measure = async function measureImage(imagePath) {
    const result = await measureImageEmbedding({
      baseUrl,
      apiKey,
      model,
      imagePath,
      timeoutMs,
      emptyPromptTokens: cachedEmptyTokens,
    })
    if (cachedEmptyTokens == null && result.emptyPromptTokens != null) {
      cachedEmptyTokens = result.emptyPromptTokens
    }
    return result
  }
  measure.embedText = async function embedText(text) {
    return measureTextEmbedding({ baseUrl, apiKey, model, text, timeoutMs })
  }
  return measure
}

export async function measureTextOnlyPromptTokens({ baseUrl = 'http://127.0.0.1:18080/v1', apiKey = '', model = 'deepseek-ocr', timeoutMs = 30_000 } = {}) {
  const body = {
    model,
    messages: [{ role: 'user', content: '\nFree OCR.' }],
    max_tokens: 8,
    temperature: 0,
  }
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`ocr text-only ${res.status}: ${text.slice(0, 500)}`)
  }
  const json = await res.json()
  const promptTokens = Number(json?.usage?.prompt_tokens ?? 0)
  if (!promptTokens) throw new Error('ocr text-only: no prompt_tokens in response')
  return { promptTokens, totalTokens: Number(json?.usage?.total_tokens ?? 0) }
}

export function createMockOcr({ transcript = 'mock transcript' } = {}) {
  return async function transcribe() {
    return transcript
  }
}

function renderCacheKey(segments, width, som) {
  return createHash('sha256')
    .update(JSON.stringify({ segments: segments.map((s) => [s.id, s.content]), width, som }))
    .digest('hex')
    .slice(0, 16)
}

export async function createMemoryStore({
  storeDir,
  renderer,
  ocr,
  embedding = null,
  tiers = DEFAULT_TIERS,
  now = Date.now,
  requireOcr = false,
  useRenderCache = true,
  textOnlyPromptTokens = 5,
  shared = false,
  embeddingRetrieval = false,
}) {
  await fs.mkdir(storeDir, { recursive: true })
  const cacheDir = join(storeDir, '.render-cache')
  const manifestPath = join(storeDir, 'memories.json')
  const renderLocks = new Map()
  let saveChain = Promise.resolve()
  let entries = []
  try {
    entries = JSON.parse(await fs.readFile(manifestPath, 'utf8')).entries || []
  } catch {
    entries = []
  }

  async function save() {
    // Serialize saves within this store instance so concurrent add/update/
    // retrieve calls cannot race on the same manifest rename.
    const run = saveChain.then(async () => {
      // Atomic write: write to a unique temp file then rename, so readers never
      // observe a partially-written memories.json.
      const tmpPath = `${manifestPath}.${process.pid}.${randomUUID()}.tmp`
      await fs.writeFile(tmpPath, JSON.stringify({ entries }, null, 2), 'utf8')
      try {
        await fs.rename(tmpPath, manifestPath)
      } catch (err) {
        // Windows rename cannot always replace an existing destination under
        // concurrent writers. Retry once by removing the destination first.
        if (err.code === 'EPERM' || err.code === 'EEXIST' || err.code === 'ENOTEMPTY') {
          await fs.rm(manifestPath, { force: true }).catch(() => {})
          await fs.rename(tmpPath, manifestPath)
        } else {
          throw err
        }
      }
    })
    saveChain = run.catch(() => {})
    await run
  }

  async function reload() {
    try {
      const data = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
      entries = Array.isArray(data.entries) ? data.entries : []
    } catch {
      // Missing or corrupted manifest is treated as an empty store (recovery path).
      entries = []
    }
  }

  async function maybeReload() {
    if (shared) await reload()
  }

  async function renderEntry(entry, { force = false, tier = null } = {}) {
    const idx = tier ?? tierIndexFor(entry, tiers)
    const tierInfo = tiers[idx]
    // If the image file is missing/corrupt, do not trust the metadata; re-render.
    if (!force && entry.imagePath && entry.tier === tierInfo.name && existsSync(entry.imagePath)) return entry.imagePath
    const outputPath = join(storeDir, `${entry.id}__${tierInfo.name}.${entry.imageExt || 'png'}`)
    // Serialize concurrent renders of the same output path (e.g. parallel active recall).
    const existing = renderLocks.get(outputPath)
    if (existing) {
      await existing
      return outputPath
    }
    const run = (async () => {
      const segments = entry.segments.map(({ id, content }) => ({ id, content }))
      const width = tierInfo.width
      // AgentOCR-style segment optical caching: identical segment set + resolution
      // reuses the previously rendered image instead of re-rendering.
      let cacheUsed = false
      if (useRenderCache) {
        const key = renderCacheKey(entry.segments, width, true)
        const cachePath = join(cacheDir, `${key}.png`)
        if (existsSync(cachePath)) {
          try {
            await fs.copyFile(cachePath, outputPath)
            cacheUsed = true
          } catch {
            // Cache file may be corrupt/locked; fall back to a fresh render.
            cacheUsed = false
          }
        }
      }
      if (!cacheUsed) {
        await renderer(segments, outputPath, { width, som: true })
        if (useRenderCache) {
          const key = renderCacheKey(entry.segments, width, true)
          await fs.mkdir(cacheDir, { recursive: true })
          try {
            await fs.copyFile(outputPath, join(cacheDir, `${key}.png`))
          } catch {
            // Cache write is best-effort; a concurrent writer may already have created it.
          }
        }
      }
      entry.imagePath = outputPath
      if (entry.visualMemory || embedding) {
        if (!entry.visualMemory) entry.visualMemory = { imagePath: null, promptTokens: null, visualTokens: null, embedding: null }
        const vm = entry.visualMemory
        vm.imagePath = outputPath
        const embeddingPath = outputPath + '.embedding.json'
        if (existsSync(embeddingPath)) {
          try {
            const data = JSON.parse(await fs.readFile(embeddingPath, 'utf8'))
            if (!vm.embeddingPath || vm.embeddingPath !== outputPath) {
              vm.embedding = Array.isArray(data.embedding) ? data.embedding : null
              if (Array.isArray(vm.embedding)) {
                vm.embeddingDim = vm.embedding.length
                vm.embeddingSource = 'pixel-64d'
                vm.embeddingPath = outputPath
              }
            }
          } catch {
            if (!vm.embeddingPath || vm.embeddingPath !== outputPath) vm.embedding = null
          }
        }
        // Replace the pixel fallback with a true DeepSeek-OCR multimodal embedding
        // when an embeddings server is configured.
        if (embedding && (!vm.embeddingPath || vm.embeddingPath !== outputPath || vm.embeddingSource !== 'deepseek-ocr-embeddings' || !Array.isArray(vm.embedding) || vm.embedding.length === 0)) {
          try {
            const result = await embedding(outputPath)
            vm.embedding = result.embedding
            vm.embeddingDim = result.dim
            vm.embeddingPath = outputPath
            vm.embeddingPromptTokens = result.promptTokens
            vm.visualTokensDirect = result.visualTokens
            vm.embeddingSource = 'deepseek-ocr-embeddings'
            delete vm.embeddingError
          } catch (err) {
            vm.embeddingError = err?.message || String(err)
          }
        }
      }
      entry.tier = tierInfo.name
      entry.tierIndex = idx
      entry.resolution = tierInfo.width
      entry.renderCache = { used: cacheUsed, width }
      await save()
      return outputPath
    })()
    renderLocks.set(outputPath, run)
    try {
      return await run
    } finally {
      renderLocks.delete(outputPath)
    }
  }

  async function add({ text, segments = null, source = '', imageExt = 'png' }) {
    await maybeReload()
    const segs = Array.isArray(segments)
      ? segments.map((s, i) => ({ id: i + 1, content: String(s) }))
      : splitSegments(text)
    if (!segs.length) throw new Error('memory: no content to store')
    if (source) {
      const existing = entries.find((e) => e.source === source)
      if (existing) {
        existing.segments = segs
        existing.createdAt = nowIso()
        existing.lastAccessAt = null
        existing.hits = 0
        existing.ocrText = null
        existing.ocrUsage = null
        existing.recalledAt = null
        existing.visualMemory = { imagePath: null, promptTokens: null, visualTokens: null, embedding: null }
        await renderEntry(existing, { force: true, tier: 0 })
        await save()
        return { id: existing.id, segments: segs.length, tier: existing.tier, imagePath: existing.imagePath, updated: true }
      }
    }
    const id = safeId(source) + '-' + randomUUID().slice(0, 6)
    const entry = {
      id,
      source,
      segments: segs,
      imageExt,
      createdAt: nowIso(),
      lastAccessAt: null,
      hits: 0,
      tier: '',
      tierIndex: 0,
      imagePath: null,
      ocrText: null,
      recalledAt: null,
      visualMemory: { imagePath: null, promptTokens: null, visualTokens: null, embedding: null },
    }
    entries.push(entry)
    await renderEntry(entry, { force: true })
    await save()
    return { id, segments: segs.length, tier: entry.tier, imagePath: entry.imagePath, updated: false }
  }

  async function ensureOcr(entry) {
    if (entry.ocrText && typeof entry.ocrText === 'string') return entry.ocrText
    if (!entry.imagePath) throw new Error(`memory: entry ${entry.id} has no image`)
    if (!ocr) {
      if (requireOcr) throw new Error('memory: no OCR client configured')
      entry.ocrText = ''
      return ''
    }
    const result = await ocr(entry.imagePath)
    const text = typeof result === 'string' ? result : result?.text
    if (typeof text !== 'string') throw new Error(`memory: OCR client returned invalid result`)
    entry.ocrText = text
    if (result && typeof result === 'object' && result.usage) {
      entry.ocrUsage = result.usage
      if (!entry.visualMemory) entry.visualMemory = { imagePath: null, promptTokens: null, visualTokens: null }
      entry.visualMemory.promptTokens = result.usage.promptTokens ?? null
      entry.visualMemory.visualTokens = result.usage.promptTokens != null
        ? Math.max(0, result.usage.promptTokens - textOnlyPromptTokens)
        : null
      entry.visualMemory.imagePath = entry.imagePath
    }
    await save()
    return text
  }

  async function refreshTiers() {
    const nowMs = now ? now() : Date.now()
    for (const entry of entries) {
      let idx = tierIndexFor(entry, tiers, nowMs)
      // Active-recall exemption: a recently recalled memory stays vivid for the
      // same window as the vivid tier, instead of being immediately re-decayed.
      if (entry.recalledAt) {
        const recalledMs = new Date(entry.recalledAt).getTime()
        if (nowMs - recalledMs < tiers[0].maxAgeMs && idx > 0) idx = 0
      }
      const target = tiers[idx]
      if (entry.tier !== target.name || !entry.imagePath?.includes(`__${target.name}.`) || (entry.imagePath && !existsSync(entry.imagePath))) {
        await renderEntry(entry, { force: true, tier: idx })
      } else {
        entry.tierIndex = idx
      }
    }
    await save()
  }

  async function retrieve(query, opts = {}) {
    await maybeReload()
    await refreshTiers()
    const topK = opts.topK ?? 5
    // OCR-read each image lazily. If OCR is down, fall back unless requireOcr.
    for (const entry of entries) {
      try {
        await ensureOcr(entry)
      } catch (err) {
        if (requireOcr) throw err
        entry.ocrText = ''
      }
    }
    await save()
    const minScore = opts.minScore ?? 0.01
    let results
    const canUseEmbeddingRetrieval = embeddingRetrieval && embedding && typeof embedding.embedText === 'function' &&
      entries.some((e) => Array.isArray(e.visualMemory?.embedding) && e.visualMemory.embedding.length > 0)
    if (canUseEmbeddingRetrieval) {
      try {
        const qEmb = await embedding.embedText(query)
        results = retrieveSegmentsWithEmbeddings(entries, query, {
          topK,
          minScore,
          queryEmbedding: qEmb.embedding,
          embeddingWeight: opts.embeddingWeight ?? 1,
        })
      } catch {
        results = retrieveSegments(entries, query, { topK, minScore })
      }
    } else {
      results = retrieveSegments(entries, query, { topK, minScore })
    }
    // Active recall: any memory that contributed a result is promoted back to vivid.
    const hitIds = new Set(results.map((r) => r.entryId))
    for (const entry of entries) {
      if (hitIds.has(entry.id)) {
        entry.hits = (entry.hits || 0) + 1
        entry.lastAccessAt = nowIso()
        if (entry.tier !== tiers[0].name) {
          entry.recalledAt = nowIso()
          await renderEntry(entry, { force: true, tier: 0 })
        }
      }
    }
    await save()
    return {
      query,
      topK,
      results,
      total_entries: entries.length,
      active_recalled: results.filter((r) => r.tier !== tiers[0].name).length,
      ran_at: nowIso(),
    }
  }

  async function list() {
    await maybeReload()
    await refreshTiers()
    await save()
    return entries.map((e) => ({
      id: e.id,
      source: e.source,
      segments: e.segments.length,
      createdAt: e.createdAt,
      tier: e.tier,
      resolution: e.resolution,
      hits: e.hits || 0,
      imagePath: e.imagePath,
      ocrText: e.ocrText || null,
      visualMemory: e.visualMemory || null,
    }))
  }

  async function remove(id) {
    await maybeReload()
    const idx = entries.findIndex((e) => e.id === id)
    if (idx < 0) return false
    const [removed] = entries.splice(idx, 1)
    await save()
    return { removed: true, id: removed.id, imagePath: removed.imagePath }
  }

  async function update(id, { text, source = null } = {}) {
    await maybeReload()
    const entry = entries.find((e) => e.id === id)
    if (!entry) throw new Error(`memory: entry not found: ${id}`)
    const segs = splitSegments(text)
    if (!segs.length) throw new Error('memory: update content is empty')
    entry.segments = segs
    if (source) entry.source = source
    entry.createdAt = nowIso()
    entry.lastAccessAt = null
    entry.hits = 0
    entry.ocrText = null
    entry.ocrUsage = null
    entry.recalledAt = null
    entry.visualMemory = { imagePath: null, promptTokens: null, visualTokens: null, embedding: null }
    await renderEntry(entry, { force: true, tier: 0 })
    await save()
    return { id: entry.id, segments: segs.length, tier: entry.tier, imagePath: entry.imagePath }
  }

  return {
    add,
    update,
    retrieve,
    list,
    remove,
    ensureOcr,
    refreshTiers,
    reload,
    get entries() { return entries },
    manifestPath,
  }
}