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

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Bounded hit-frequency decay policy. A hit does not reset createdAt; it only
 * reduces the effective age while recent access frequency remains high. This
 * keeps frequently used memories readable without making them immortal.
 */
export const DEFAULT_DECAY_POLICY = Object.freeze({
  enabled: false,
  frequencyWindowMs: 7 * DAY_MS,
  recencyHalfLifeMs: 14 * DAY_MS,
  hitWeight: 1,
  maxMultiplier: 4,
})

const MAX_ACCESS_HISTORY = 32

function finiteNumber(value, fallback) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback
}

/** Return a bounded age multiplier derived from recent hit frequency. */
export function decayMultiplier(entry, at = Date.now(), policy = DEFAULT_DECAY_POLICY) {
  if (!policy || policy.enabled === false) return 1
  const hits = Math.max(0, finiteNumber(entry?.hits, 0))
  if (hits <= 0) return 1

  const nowMs = finiteNumber(at, Date.now())
  const windowMs = Math.max(DAY_MS, finiteNumber(policy.frequencyWindowMs, DEFAULT_DECAY_POLICY.frequencyWindowMs))
  const halfLifeMs = Math.max(DAY_MS, finiteNumber(policy.recencyHalfLifeMs, DEFAULT_DECAY_POLICY.recencyHalfLifeMs))
  const history = Array.isArray(entry?.accessHistory) ? entry.accessHistory : []
  const timestamps = history
    .map((value) => new Date(value).getTime())
    .filter((value) => Number.isFinite(value) && value <= nowMs)
  // Old manifests have no accessHistory. lastAccessAt preserves a small amount
  // of compatibility without pretending that all historical hits were recent.
  if (!timestamps.length && entry?.lastAccessAt) {
    const last = new Date(entry.lastAccessAt).getTime()
    if (Number.isFinite(last) && last <= nowMs) timestamps.push(last)
  }
  if (!timestamps.length) return 1

  // Exponential weighting avoids a hard cutoff at the frequency-window edge.
  const weightedHits = timestamps.reduce((sum, value) => {
    const age = Math.max(0, nowMs - value)
    return sum + Math.exp(-Math.LN2 * age / windowMs)
  }, 0)
  const frequencyPerDay = weightedHits / Math.max(1, windowMs / DAY_MS)
  const sinceLast = Math.max(0, nowMs - Math.max(...timestamps))
  const recency = Math.exp(-sinceLast / halfLifeMs)
  const weight = Math.max(0, finiteNumber(policy.hitWeight, DEFAULT_DECAY_POLICY.hitWeight))
  const cap = Math.max(1, finiteNumber(policy.maxMultiplier, DEFAULT_DECAY_POLICY.maxMultiplier))
  const boost = Math.min(cap - 1, weight * frequencyPerDay * (0.5 + 0.5 * recency))
  return 1 + boost
}

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

export function tierIndexFor(entry, tiers = DEFAULT_TIERS, at = Date.now(), decayPolicy = DEFAULT_DECAY_POLICY) {
  const createdAt = new Date(entry?.createdAt).getTime()
  const rawAge = Number.isFinite(createdAt) ? Math.max(0, at - createdAt) : Number.POSITIVE_INFINITY
  const age = rawAge / decayMultiplier(entry, at, decayPolicy)
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
  return async function render(segments, outputPath, { width = 1024, som = true, square = false } = {}) {
    if (!renderCommand) {
      throw new Error('renderer: no renderCommand configured (set renderer.command or pythonRenderScript)')
    }
    const script = renderCommand
    const payload = JSON.stringify({ segments, outputPath, width, som, square })
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const execFileP = promisify(execFile)
    await execFileP(python, [script, payload], { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 })
    await fs.access(outputPath)
    return outputPath
  }
}

export function createMockRenderer() {
  return async function render(segments, outputPath, { width = 1024, som = true, square = false } = {}) {
    const text = `# rendered(width=${width}, som=${som}, square=${square})\n` + segments.map((s) => `${s.id}: ${s.content}`).join('\n')
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

/** Parse the OCR-Memory listwise label stream. Each generated label position
 * must be an individual 0/1 token. When top-logprobs contain both labels, the
 * paper's calibrated p(1) = exp(z1)/(exp(z1)+exp(z0)) is computed directly.
 */
export function parseBinaryRelevance({ content = '', logprobs = null, segmentCount } = {}) {
  const count = Number(segmentCount)
  if (!Number.isInteger(count) || count < 1) throw new Error('locator: segmentCount must be a positive integer')
  const tokenRows = Array.isArray(logprobs?.content) ? logprobs.content : []
  const labels = []
  const probabilities = []
  for (const row of tokenRows) {
    const token = String(row?.token ?? '').trim()
    if (token !== '0' && token !== '1') continue
    labels.push(Number(token))
    const top = Array.isArray(row?.top_logprobs) ? row.top_logprobs : []
    const z0 = top.find((x) => String(x?.token ?? '').trim() === '0')?.logprob
    const z1 = top.find((x) => String(x?.token ?? '').trim() === '1')?.logprob
    if (Number.isFinite(z0) && Number.isFinite(z1)) {
      const max = Math.max(z0, z1)
      const e0 = Math.exp(z0 - max)
      const e1 = Math.exp(z1 - max)
      probabilities.push(e1 / (e0 + e1))
    } else {
      probabilities.push(token === '1' ? 1 : 0)
    }
    if (labels.length === count) break
  }
  // Some compatible servers omit logprobs. Accept only an unambiguous stream
  // containing exactly K standalone labels; never guess from prose or IDs.
  if (labels.length === 0 && typeof content === 'string') {
    const trimmed = content.trim()
    if (/^[01](?:[\s,]+[01])*$/.test(trimmed)) {
      const parsed = trimmed.split(/[\s,]+/).map(Number)
      if (parsed.length === count) {
        return { labels: parsed, probabilities: parsed.map(Number), calibrated: false }
      }
    }
  }
  if (labels.length !== count) {
    throw new Error(`locator: expected ${count} binary labels, received ${labels.length}`)
  }
  return { labels, probabilities, calibrated: probabilities.some((p, i) => p !== labels[i]) }
}

/** OCR-Memory Appendix-A selection rule: threshold first, Top-K only when no
 * segment crosses the threshold. Set alwaysUnionTopK=true to reproduce Eq. 12
 * literally; the paper is internally inconsistent on this detail.
 */
export function selectRelevanceIndices({ labels = [], probabilities = [] } = {}, {
  threshold = 0.4,
  fallbackTopK = 5,
  alwaysUnionTopK = false,
} = {}) {
  const scores = labels.map((label, i) => Number.isFinite(probabilities[i]) ? probabilities[i] : Number(label))
  const selected = new Set(scores.map((p, i) => p >= threshold ? i : -1).filter((i) => i >= 0))
  if (alwaysUnionTopK || selected.size === 0) {
    const k = Math.min(Math.max(0, Number(fallbackTopK) || 0), scores.length)
    scores.map((score, i) => ({ i, score })).sort((a, b) => b.score - a.score || a.i - b.i).slice(0, k).forEach(({ i }) => selected.add(i))
  }
  return [...selected].sort((a, b) => scores[b] - scores[a] || a - b).map((i) => ({ index: i, score: scores[i] }))
}

/** Build a GBNF grammar that accepts exactly `k` space-separated 0/1 digits.
 * GBNF has no repetition operator, so the alternation is expanded explicitly.
 */
export function binaryLabelsGrammar(k) {
  const count = Math.max(1, Math.trunc(Number(k) || 1))
  const parts = ['d']
  for (let i = 1; i < count; i++) parts.push('" " d')
  return `d ::= "0" | "1"\nroot ::= ${parts.join(' ')}`
}

/** Create the learned optical retriever client required by OCR-Memory. The
 * endpoint is expected to serve a decoder LoRA trained for K-token 0/1 output.
 * Base DeepSeek-OCR is deliberately not assumed to follow this instruction.
 */
export function createOcrLocatorHttpClient({
  baseUrl = 'http://127.0.0.1:18080/v1',
  apiKey = '',
  model = 'deepseek-ocr-memory',
  timeoutMs = 120_000,
  repeatPenalty = 1.2,
  noRepeatNgramSize = 30,
  promptTemplate = null,
} = {}) {
  return async function locate(imagePath, query, segmentCount, { signal = null } = {}) {
    const { readFileSync } = await import('node:fs')
    const data = readFileSync(imagePath)
    const ext = extname(imagePath).toLowerCase().replace('.', '') || 'png'
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`
    const dataUrl = `data:${mime};base64,${data.toString('base64')}`
    const prompt = typeof promptTemplate === 'function'
      ? promptTemplate({ query, segmentCount })
      : `Query: ${query}\nThe image contains ${segmentCount} red numbered text boxes. Output exactly ${segmentCount} binary labels separated by spaces, in box-number order. 1 means relevant evidence and 0 means irrelevant. Output labels only.`
    const body = {
      model,
      // Paper-faithful request shape:
      // - image precedes the text prompt, matching the training sequence
      //   `<image>\nQuery: ...`; DeepSeek-OCR's chat template is a plain
      //   concatenation, so element order is part of the input contract.
      // - a GBNF grammar pins the decoder to exactly K space-separated 0/1
      //   digits. Soft penalties alone let the model drift into prose (measured
      //   F1 = 0 on the training-side eval); the grammar is the llama.cpp
      //   equivalent of the strict decoding used there.
      messages: [{ role: 'user', content: [
        { type: 'image_url', image_url: { url: dataUrl } },
        { type: 'text', text: '\n' + prompt },
      ] }],
      grammar: binaryLabelsGrammar(segmentCount),
      temperature: 0,
      max_tokens: Math.max(8, segmentCount * 2 + 4),
      logprobs: true,
      top_logprobs: 5,
      ...(repeatPenalty > 0 ? { repeat_penalty: repeatPenalty } : {}),
      ...(noRepeatNgramSize > 0 ? { no_repeat_ngram_size: noRepeatNgramSize } : {}),
    }
    const requestSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs)
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: requestSignal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`locator http ${res.status}: ${text.slice(0, 500)}`)
    }
    const json = await res.json()
    const choice = json?.choices?.[0]
    const content = choice?.message?.content
    if (typeof content !== 'string') throw new Error(`locator http: unexpected response ${JSON.stringify(json).slice(0, 500)}`)
    const parsed = parseBinaryRelevance({ content, logprobs: choice?.logprobs, segmentCount })
    return {
      ...parsed,
      raw: content,
      usage: json?.usage ? {
        promptTokens: Number(json.usage.prompt_tokens ?? 0),
        completionTokens: Number(json.usage.completion_tokens ?? 0),
        totalTokens: Number(json.usage.total_tokens ?? 0),
      } : null,
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
  signal = null,
} = {}) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('embedding: text is required')
  const body = { model, input: text }
  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs)
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/embeddings`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(body),
    signal: requestSignal,
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
  measure.embedText = async function embedText(text, { signal = null } = {}) {
    return measureTextEmbedding({ baseUrl, apiKey, model, text, timeoutMs, signal })
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
    .update(JSON.stringify({ rendererVersion: 2, segments: segments.map((s) => [s.id, s.content]), width, som }))
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
  ocrMaxEntriesPerRetrieve = 5,
  locator = null,
  locatorThreshold = 0.4,
  locatorTopK = 5,
  locatorMaxSegments = 20,
  locatorAlwaysUnionTopK = false,
  locatorStrict = false,
  dynamicDecayEnabled = DEFAULT_DECAY_POLICY.enabled,
  decayFrequencyWindowMs = DEFAULT_DECAY_POLICY.frequencyWindowMs,
  decayRecencyHalfLifeMs = DEFAULT_DECAY_POLICY.recencyHalfLifeMs,
  decayHitWeight = DEFAULT_DECAY_POLICY.hitWeight,
  decayMaxMultiplier = DEFAULT_DECAY_POLICY.maxMultiplier,
}) {
  const decayPolicy = {
    enabled: Boolean(dynamicDecayEnabled),
    frequencyWindowMs: decayFrequencyWindowMs,
    recencyHalfLifeMs: decayRecencyHalfLifeMs,
    hitWeight: decayHitWeight,
    maxMultiplier: decayMaxMultiplier,
  }
  const currentTime = () => typeof now === 'function' ? now() : now
  const currentIso = () => new Date(currentTime()).toISOString()
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
    const idx = tier ?? tierIndexFor(entry, tiers, currentTime(), decayPolicy)
    const tierInfo = tiers[idx]
    const previousImagePath = entry.imagePath || null
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
            const cachedSidecar = cachePath + '.embedding.json'
            if (existsSync(cachedSidecar)) await fs.copyFile(cachedSidecar, outputPath + '.embedding.json')
            cacheUsed = true
          } catch {
            // Cache file may be corrupt/locked; fall back to a fresh render.
            cacheUsed = false
          }
        }
      }
      if (!cacheUsed) {
        await renderer(segments, outputPath, { width, som: true, square: true })
        if (useRenderCache) {
          const key = renderCacheKey(entry.segments, width, true)
          await fs.mkdir(cacheDir, { recursive: true })
          try {
            const cachePath = join(cacheDir, `${key}.png`)
            await fs.copyFile(outputPath, cachePath)
            const outputSidecar = outputPath + '.embedding.json'
            if (existsSync(outputSidecar)) await fs.copyFile(outputSidecar, cachePath + '.embedding.json')
          } catch {
            // Cache write is best-effort; a concurrent writer may already have created it.
          }
        }
      }
      // OCR and locator evidence are valid only for the exact rendered image.
      // A tier/content re-render must not reuse a vivid transcript for a fuzzy
      // image (that would bypass the paper's optical forgetting mechanism).
      entry.ocrText = null
      entry.ocrUsage = null
      entry.locator = null
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
      // OCR-Memory stores one current image per item. Remove the superseded
      // tier artifact and its sidecar after the replacement is complete.
      if (previousImagePath && previousImagePath !== outputPath && dirname(previousImagePath) === storeDir && basename(previousImagePath).startsWith(`${entry.id}__`)) {
        await fs.rm(previousImagePath, { force: true }).catch(() => {})
        await fs.rm(previousImagePath + '.embedding.json', { force: true }).catch(() => {})
      }
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
        existing.createdAt = currentIso()
        existing.lastAccessAt = null
        existing.hits = 0
        existing.accessHistory = []
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
      archived: false,
      segments: segs,
      imageExt,
      createdAt: currentIso(),
      lastAccessAt: null,
      hits: 0,
      accessHistory: [],
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

  async function refreshTiers(allowedEntryIds = null) {
    const nowMs = currentTime()
    for (const entry of entries) {
      if (allowedEntryIds && !allowedEntryIds.has(entry.id)) continue
      let idx = tierIndexFor(entry, tiers, nowMs, decayPolicy)
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
    const allowedEntryIds = Array.isArray(opts.allowedEntryIds)
      ? new Set(opts.allowedEntryIds.map((id) => String(id)))
      : null
    const candidateEntries = (allowedEntryIds
      ? entries.filter((entry) => allowedEntryIds.has(String(entry.id)))
      : entries)
      // 治理层归档（memory_archive/promote）会同步标记光学条目的 archived；
      // 手动检索（ocr1_mem_retrieve）默认不再暴露已归档条目，保证"归档即隐藏"。
      .filter((entry) => !entry.archived)
    await refreshTiers(allowedEntryIds)
    const topK = opts.topK ?? 5
    const minScore = opts.minScore ?? 0.01
    let results = null

    // Faithful OCR-Memory path: the optical locator scans every current SoM
    // image and selects segment pointers before raw text is accessed. Raw logs
    // are used only by the deterministic Fetch step below.
    if (locator) {
      const optical = []
      let successfulImages = 0
      for (const entry of candidateEntries) {
        try {
          const located = await locator(entry.imagePath, query, entry.segments.length, { signal: opts.signal || null })
          successfulImages++
          entry.locator = {
            imagePath: entry.imagePath,
            tier: entry.tier,
            labels: located.labels,
            probabilities: located.probabilities,
            calibrated: Boolean(located.calibrated),
            usage: located.usage || null,
            queriedAt: currentIso(),
          }
          const selected = selectRelevanceIndices(located, {
            threshold: Number(opts.locatorThreshold ?? locatorThreshold),
            fallbackTopK: Number(opts.locatorTopK ?? locatorTopK),
            alwaysUnionTopK: Boolean(opts.locatorAlwaysUnionTopK ?? locatorAlwaysUnionTopK),
          })
          for (const { index, score } of selected) {
            const seg = entry.segments[index]
            if (!seg) continue
            optical.push({
              entryId: entry.id,
              segmentId: seg.id,
              content: seg.content,
              source: entry.source || '',
              score,
              tier: entry.tier,
            })
          }
        } catch (err) {
          entry.locator = {
            imagePath: entry.imagePath,
            tier: entry.tier,
            error: err?.message || String(err),
            queriedAt: currentIso(),
          }
          if (locatorStrict) throw err
        }
      }
      if (successfulImages > 0) {
        const globalCap = Math.min(Math.max(1, Number(locatorMaxSegments) || 20), Math.max(1, Number(topK) || 5))
        optical.sort((a, b) => b.score - a.score || a.entryId.localeCompare(b.entryId) || a.segmentId - b.segmentId)
        results = optical.slice(0, globalCap)
      }
      await save()
    }

    // Legacy training-free fallback. This remains available for installations
    // without the paper's fine-tuned locator, but it is not called an optical
    // reproduction and is never mixed into a successful locator pass.
    if (results === null) {
      // Avoid OCRing every entry on large stores: first try text-based retrieval.
      // Only OCR a bounded set of candidates when text alone cannot fill topK.
      const prelim = retrieveSegments(candidateEntries, query, { topK, minScore })
      if (prelim.length < topK || requireOcr) {
        const q = tokenize(query)
        const ranked = candidateEntries
          .map((e) => ({ e, score: scoreEntry(q, e).originalScore }))
          .sort((a, b) => b.score - a.score)
        const ocrLimit = Math.max(1, Number(opts.ocrMaxEntries ?? ocrMaxEntriesPerRetrieve))
        let ocrCount = 0
        for (const { e } of ranked) {
          if (e.ocrText) continue
          try {
            await ensureOcr(e)
          } catch (err) {
            if (requireOcr) throw err
            e.ocrText = ''
          }
          ocrCount++
          if (ocrCount >= ocrLimit) break
        }
        await save()
      }
      const canUseEmbeddingRetrieval = embeddingRetrieval && embedding && typeof embedding.embedText === 'function' &&
        candidateEntries.some((e) => Array.isArray(e.visualMemory?.embedding) && e.visualMemory.embedding.length > 0)
      if (canUseEmbeddingRetrieval) {
        try {
          const qEmb = await embedding.embedText(query, { signal: opts.signal || null })
          results = retrieveSegmentsWithEmbeddings(candidateEntries, query, {
            topK,
            minScore,
            queryEmbedding: qEmb.embedding,
            embeddingWeight: opts.embeddingWeight ?? 1,
          })
        } catch {
          results = retrieveSegments(candidateEntries, query, { topK, minScore })
        }
      } else {
        results = retrieveSegments(candidateEntries, query, { topK, minScore })
      }
    }

    // Active recall: any memory that contributed a result is promoted back to vivid.
    const hitIds = new Set(results.map((r) => r.entryId))
    const recalledIds = new Set()
    for (const entry of candidateEntries) {
      if (hitIds.has(entry.id)) {
        const accessedAt = currentIso()
        entry.hits = (entry.hits || 0) + 1
        entry.lastAccessAt = accessedAt
        const history = Array.isArray(entry.accessHistory) ? entry.accessHistory : []
        history.push(accessedAt)
        entry.accessHistory = history.slice(-MAX_ACCESS_HISTORY)
        if (entry.tier !== tiers[0].name) {
          recalledIds.add(entry.id)
          entry.recalledAt = currentIso()
          await renderEntry(entry, { force: true, tier: 0 })
        }
      }
    }
    await save()
    return {
      query,
      topK,
      results,
      total_entries: candidateEntries.length,
      active_recalled: recalledIds.size,
      ran_at: currentIso(),
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

  async function setArchived(id, archived) {
    await maybeReload()
    const entry = entries.find((e) => e.id === id)
    if (!entry) return false
    entry.archived = Boolean(archived)
    await save()
    return true
  }

  async function remove(id) {
    await maybeReload()
    const idx = entries.findIndex((e) => e.id === id)
    if (idx < 0) return false
    const [removed] = entries.splice(idx, 1)
    // Forget means delete the optical artifacts too, not merely the manifest
    // pointer. Remove every tier path and matching render-cache object/sidecar.
    const artifactPaths = new Set()
    if (removed.imagePath) artifactPaths.add(removed.imagePath)
    for (const tier of tiers) {
      artifactPaths.add(join(storeDir, `${removed.id}__${tier.name}.${removed.imageExt || 'png'}`))
      const key = renderCacheKey(removed.segments || [], tier.width, true)
      artifactPaths.add(join(cacheDir, `${key}.png`))
    }
    for (const path of artifactPaths) {
      await fs.rm(path, { force: true, recursive: false }).catch(() => {})
      await fs.rm(path + '.embedding.json', { force: true, recursive: false }).catch(() => {})
    }
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
    entry.createdAt = currentIso()
    entry.lastAccessAt = null
    entry.hits = 0
    entry.accessHistory = []
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
    setArchived,
    ensureOcr,
    refreshTiers,
    reload,
    get entries() { return entries },
    manifestPath,
  }
}