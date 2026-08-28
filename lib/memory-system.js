import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  copyFileSync,
  rmSync,
} from 'node:fs'
import { join } from 'node:path'

import {
  createMemoryStore,
  DEFAULT_DECAY_POLICY,
  scoreSegment,
  tokenize,
} from './core.js'
import {
  ensureMemoryLayout,
  ensureNamespaceLayout,
  resolveNamespace,
  nsRoot,
  readIndex,
  syncIndex,
  factSections,
  sopNames,
  pendingNames,
  readFact,
  readSop,
  writeMemory,
  writePending,
  readPending,
  parsePending,
  getEntryMeta,
  setEntryMeta,
  isArchived,
  isSafeMemName,
  computeNamespaceStats,
  runMaintain,
  slugify,
} from './governance.js'

function entryKey(entryType, topic) {
  return entryType === 'fact' ? String(topic).trim() : slugify(topic)
}

function opticalSource(entryType, topic) {
  return `governed:${entryType}:${slugify(topic)}`
}

function metaKey(entryType, topic) {
  return entryKey(entryType, topic)
}

function contentFor(root, entryType, topic) {
  return entryType === 'fact'
    ? readFact(root, topic)
    : readSop(root, slugify(topic))
}

function logicalEntries(root, { activeOnly = true } = {}) {
  const out = []
  for (const topic of factSections(root)) {
    const meta = getEntryMeta(root, 'fact', topic) || {}
    if (activeOnly && meta.archived) continue
    out.push({
      topic,
      entryType: 'fact',
      key: topic,
      content: readFact(root, topic) || '',
      meta,
    })
  }
  for (const slug of sopNames(root)) {
    const meta = getEntryMeta(root, 'sop', slug) || {}
    if (activeOnly && meta.archived) continue
    out.push({
      topic: slug,
      entryType: 'sop',
      key: slug,
      content: readSop(root, slug) || '',
      meta,
    })
  }
  return out
}

function textRetrieve(entries, query, topK = 5) {
  const q = tokenize(query)
  if (!q.length) return []
  return entries
    .map((entry) => ({
      entry,
      score: scoreSegment(q, entry.content),
    }))
    .filter((x) => x.score > 0.01)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, topK))
    .map(({ entry, score }, index) => ({
      memoryId: `${entry.entryType}:${entry.key}`,
      entryId: entry.meta.opticalId || '',
      segmentId: 1,
      topic: entry.topic,
      entry_type: entry.entryType,
      content: entry.content,
      source: entry.meta.source || entry.topic,
      score,
      tier: entry.meta.tier || 'logical',
      retrieval: 'text',
      rank: index + 1,
    }))
}

function parseHistoryName(entryType, topic, file) {
  const prefix = entryType === 'fact' ? `fact-${slugify(topic)}-` : `sop-${slugify(topic)}-`
  return file.startsWith(prefix) && file.endsWith('.md')
}

export function createGovernedMemorySystem({
  memoryDir,
  maxIndexLines = 30,
  defaultNamespace = '',
  autoNamespace = true,
  renderer,
  ocr = null,
  embedding = null,
  tiers,
  requireOcr = false,
  textOnlyPromptTokens = 5,
  shared = true,
  embeddingRetrieval = true,
  ocrMaxEntriesPerRetrieve = 5,
  useRenderCache = true,
  now = Date.now,
  sessionQuery = null,
  storeFactory = null,
  dynamicDecayEnabled = DEFAULT_DECAY_POLICY.enabled,
  decayFrequencyWindowMs = DEFAULT_DECAY_POLICY.frequencyWindowMs,
  decayRecencyHalfLifeMs = DEFAULT_DECAY_POLICY.recencyHalfLifeMs,
  decayHitWeight = DEFAULT_DECAY_POLICY.hitWeight,
  decayMaxMultiplier = DEFAULT_DECAY_POLICY.maxMultiplier,
} = {}) {
  if (!memoryDir) throw new Error('memory system: memoryDir is required')
  ensureMemoryLayout(memoryDir)
  const stores = new Map()
  const storeErrors = new Map()
  const cfg = { defaultNamespace, autoNamespace }

  function namespace(explicit) {
    return resolveNamespace(cfg, explicit)
  }

  function root(explicit) {
    const ns = namespace(explicit)
    const dir = nsRoot(memoryDir, ns)
    ensureNamespaceLayout(dir)
    return { ns, dir }
  }

  async function storeFor(explicit) {
    const { ns, dir } = root(explicit)
    if (!stores.has(ns)) {
      const promise = (storeFactory
        ? Promise.resolve(storeFactory({ ns, dir }))
        : createMemoryStore({
            // Keep the optical manifest at the namespace root for legacy compatibility.
            storeDir: dir,
            renderer,
            ocr,
            embedding,
            tiers,
            requireOcr,
            textOnlyPromptTokens,
            shared,
            embeddingRetrieval,
            ocrMaxEntriesPerRetrieve,
            useRenderCache,
            now,
            dynamicDecayEnabled,
            decayFrequencyWindowMs,
            decayRecencyHalfLifeMs,
            decayHitWeight,
            decayMaxMultiplier,
          }))
        .catch((error) => {
        storeErrors.set(ns, error?.message || String(error))
        throw error
      })
      stores.set(ns, promise)
    }
    return stores.get(ns)
  }

  async function write({
    topic,
    entryType = 'fact',
    content,
    evidence,
    sourceSession = null,
    sourceSeqs = [],
    source = '',
    namespace: explicitNamespace,
  }) {
    const safeTopic = String(topic || '').trim()
    const type = entryType === 'sop' ? 'sop' : 'fact'
    const body = String(content || '').trim()
    const proof = String(evidence || '').trim()
    if (!safeTopic || !body) throw new Error('memory_write: topic 与 content 必填')
    if (!proof) throw new Error('memory_write: evidence 必填（行动验证公理：无行动，不记忆）')
    const { ns, dir } = root(explicitNamespace)
    const key = metaKey(type, safeTopic)
    const existing = getEntryMeta(dir, type, key) || {}
    const result = writeMemory(dir, {
      topic: safeTopic,
      entryType: type,
      content: body,
      evidence: proof,
      sourceSession,
      sourceSeqs,
      namespace: ns,
    })
    syncIndex(dir, maxIndexLines)

    let optical = null
    let opticalError = ''
    try {
      const store = await storeFor(ns)
      optical = await store.add({
        text: body,
        source: opticalSource(type, safeTopic),
      })
    } catch (error) {
      opticalError = error?.message || String(error)
    }
    setEntryMeta(dir, type, key, {
      source: source || existing.source || safeTopic,
      opticalId: optical?.id || existing.opticalId || null,
      opticalSource: opticalSource(type, safeTopic),
      opticalTier: optical?.tier || existing.opticalTier || null,
      opticalImagePath: optical?.imagePath || existing.opticalImagePath || null,
      opticalError: opticalError || null,
      schemaVersion: 1,
    })
    return {
      ...result,
      namespace: ns,
      entry_type: type,
      optical: optical
        ? { id: optical.id, tier: optical.tier, imagePath: optical.imagePath }
        : { id: existing.opticalId || '', error: opticalError },
    }
  }

  function read({ name, namespace: explicitNamespace }) {
    const key = String(name || '').trim()
    const { ns, dir } = root(explicitNamespace)
    if (!isSafeMemName(key)) throw new Error(`memory_read: 非法名称: ${key}`)
    if (!key || ['index', 'l1', '索引'].includes(key.toLowerCase())) {
      return { name: key || 'index', source: 'index.txt', content: readIndex(dir), namespace: ns, meta: {} }
    }
    for (const candidate of [key, slugify(key)]) {
      const p = join(dir, 'sops', `${candidate}.md`)
      if (existsSync(p)) {
        const meta = getEntryMeta(dir, 'sop', candidate) || {}
        if (meta.archived) return { name: key, source: '', content: '', namespace: ns, meta: { ...meta, archived: true }, not_found: true }
        return { name: key, source: `sops/${candidate}.md`, content: readSop(dir, candidate) || '', namespace: ns, meta }
      }
    }
    const fact = readFact(dir, key)
    if (fact !== null) {
      const meta = getEntryMeta(dir, 'fact', key) || {}
      if (meta.archived) return { name: key, source: '', content: '', namespace: ns, meta: { ...meta, archived: true }, not_found: true }
      return { name: key, source: 'facts.md', content: fact, namespace: ns, meta }
    }
    return { name: key, source: '', content: '', namespace: ns, meta: {}, not_found: true }
  }

  function list({ namespace: explicitNamespace } = {}) {
    const { ns, dir } = root(explicitNamespace)
    return {
      namespace: ns,
      index_lines: readIndex(dir).split('\n').length,
      entries: logicalEntries(dir).map((entry) => ({
        topic: entry.topic,
        entry_type: entry.entryType,
        content: entry.content,
        optical: {
          id: entry.meta.opticalId || '',
          tier: entry.meta.opticalTier || '',
          imagePath: entry.meta.opticalImagePath || '',
          error: entry.meta.opticalError || '',
        },
        provenance: {
          sourceSession: entry.meta.sourceSession || '',
          sourceSeqs: entry.meta.sourceSeqs || [],
          evidence: entry.meta.evidence || '',
        },
      })),
      facts: factSections(dir).filter((x) => !isArchived(dir, 'fact', x)),
      sops: sopNames(dir).filter((x) => !isArchived(dir, 'sop', x)),
      pending: pendingNames(dir),
    }
  }

  function index({ namespace: explicitNamespace } = {}) {
    const { ns, dir } = root(explicitNamespace)
    const r = syncIndex(dir, maxIndexLines)
    return { namespace: ns, ...r, index: readIndex(dir) }
  }

  function pending({ namespace: explicitNamespace } = {}) {
    const { ns, dir } = root(explicitNamespace)
    return {
      namespace: ns,
      pending: pendingNames(dir).map((name) => ({ name, content: readPending(dir, name) || '' })),
    }
  }

  async function accept({ name, topic, entryType, content, evidence, namespace: explicitNamespace }) {
    const { ns, dir } = root(explicitNamespace)
    const safeName = String(name || '').trim()
    if (!isSafeMemName(safeName)) throw new Error('memory_accept: 非法 pending 文件名')
    const text = readPending(dir, safeName)
    if (!text) throw new Error(`memory_accept: pending 不存在: ${safeName}`)
    const parsed = parsePending(text)
    const finalTopic = String(topic || parsed.topic || '').trim()
    const finalType = entryType === 'sop' || parsed.entryType === 'sop' ? 'sop' : entryType === 'fact' || parsed.entryType === 'fact' ? 'fact' : ''
    const finalEvidence = String(evidence || parsed.evidence || '').trim()
    const finalContent = String(content || parsed.content || '').trim()
    if (!finalTopic) throw new Error('memory_accept: 需要 topic')
    if (!finalType) throw new Error('memory_accept: 需要 entryType=fact|sop')
    if (!finalEvidence) throw new Error('memory_accept: 需要 evidence')
    if (!finalContent) throw new Error('memory_accept: pending 内容为空')
    const result = await write({
      topic: finalTopic,
      entryType: finalType,
      content: finalContent,
      evidence: finalEvidence,
      sourceSession: parsed.sourceSession || null,
      sourceSeqs: parsed.sourceSeqs || [],
      namespace: ns,
    })
    const archived = join(dir, 'archive', safeName)
    try {
      copyFileSync(join(dir, 'pending', safeName), archived)
      rmSync(join(dir, 'pending', safeName), { force: true })
    } catch { /* accepted memory remains valid even if candidate archival fails */ }
    return { accepted: true, topic: finalTopic, entry_type: finalType, namespace: ns, path: result.path }
  }

  async function update({ topic, entryType = 'fact', content, evidence, supersede = true, namespace: explicitNamespace }) {
    const { ns, dir } = root(explicitNamespace)
    const type = entryType === 'sop' ? 'sop' : 'fact'
    const key = metaKey(type, topic)
    const old = contentFor(dir, type, topic)
    let history = ''
    if (supersede && old !== null) {
      history = join('.history', `${type}-${slugify(topic)}-${Date.now()}.md`)
      writeFileSync(join(dir, history), old, 'utf8')
    }
    const meta = getEntryMeta(dir, type, key) || {}
    const result = await write({
      topic,
      entryType: type,
      content,
      evidence: evidence || meta.evidence || 'memory_update（历史更新）',
      sourceSession: meta.sourceSession || null,
      sourceSeqs: meta.sourceSeqs || [],
      namespace: ns,
    })
    setEntryMeta(dir, type, key, { archived: false, restoredFrom: null })
    return { topic, entry_type: type, action: supersede ? 'superseded' : 'updated', namespace: ns, history, optical: result.optical }
  }

  function archive({ topic, entryType = 'fact', namespace: explicitNamespace }) {
    const { ns, dir } = root(explicitNamespace)
    const type = entryType === 'sop' ? 'sop' : 'fact'
    const key = metaKey(type, topic)
    const exists = contentFor(dir, type, topic) !== null
    if (!exists) return { topic, entry_type: type, namespace: ns, archived: false }
    setEntryMeta(dir, type, key, { archived: true, archivedAt: new Date().toISOString() })
    syncIndex(dir, maxIndexLines)
    return { topic, entry_type: type, namespace: ns, archived: true }
  }

  async function rollback({ topic, entryType = 'fact', namespace: explicitNamespace }) {
    const { ns, dir } = root(explicitNamespace)
    const type = entryType === 'sop' ? 'sop' : 'fact'
    const prefix = `${type}-${slugify(topic)}-`
    let files = []
    try {
      files = readdirSync(join(dir, '.history')).filter((file) => parseHistoryName(type, topic, file)).sort()
    } catch { files = [] }
    if (!files.length) return { topic, entry_type: type, namespace: ns, restored: false, source: '' }
    const source = files[files.length - 1]
    const raw = readFileSync(join(dir, '.history', source), 'utf8')
    const content = type === 'fact' ? raw.replace(/^# .+\r?\n\r?\n/, '').trim() : raw.replace(/^# .+\r?\n\r?\n/, '').trim()
    const meta = getEntryMeta(dir, type, metaKey(type, topic)) || {}
    await write({
      topic,
      entryType: type,
      content,
      evidence: meta.evidence || 'memory_rollback（历史恢复）',
      sourceSession: meta.sourceSession || null,
      sourceSeqs: meta.sourceSeqs || [],
      namespace: ns,
    })
    setEntryMeta(dir, type, metaKey(type, topic), { archived: false, restoredFrom: source })
    syncIndex(dir, maxIndexLines)
    return { topic, entry_type: type, namespace: ns, restored: true, source }
  }

  async function retrieve({ query, topK = 5, namespace: explicitNamespace, signal = null } = {}) {
    if (signal?.aborted) throw signal.reason || new Error('memory_retrieve: aborted')
    const { ns, dir } = root(explicitNamespace)
    const logical = logicalEntries(dir)
    const allowed = logical.map((entry) => entry.meta.opticalId).filter(Boolean)
    const textResults = textRetrieve(logical, query, topK)
    let opticalResults = []
    let opticalError = ''
    if (allowed.length) {
      try {
        const store = await storeFor(ns)
        opticalResults = (await store.retrieve(query, {
          topK,
          allowedEntryIds: allowed,
          signal,
        })).results || []
      } catch (error) {
        if (signal?.aborted) throw error
        opticalError = error?.message || String(error)
      }
    }
    const byOptical = new Map(logical.map((entry) => [entry.meta.opticalId, entry]))
    const merged = []
    const seen = new Set()
    for (const result of opticalResults) {
      const entry = byOptical.get(result.entryId)
      if (!entry) continue
      const id = `${entry.entryType}:${entry.key}`
      if (seen.has(id)) continue
      seen.add(id)
      merged.push({
        ...result,
        memoryId: id,
        topic: entry.topic,
        entry_type: entry.entryType,
        content: entry.content,
        provenance: {
          evidence: entry.meta.evidence || '',
          sourceSession: entry.meta.sourceSession || '',
          sourceSeqs: entry.meta.sourceSeqs || [],
        },
        retrieval: 'optical',
      })
    }
    for (const result of textResults) {
      const id = result.memoryId
      if (seen.has(id)) continue
      seen.add(id)
      merged.push(result)
    }
    return {
      query: String(query || ''),
      namespace: ns,
      topK,
      results: merged.slice(0, Math.max(1, topK)),
      total_entries: logical.length,
      optical_backend: Boolean(allowed.length && !opticalError),
      optical_error: opticalError,
      ran_at: new Date().toISOString(),
    }
  }

  async function maintain({ namespace: explicitNamespace } = {}) {
    const { ns, dir } = root(explicitNamespace)
    const report = runMaintain(dir, maxIndexLines)
    try {
      const store = await storeFor(ns)
      await store.list()
    } catch (error) {
      report.opticalError = error?.message || String(error)
    }
    return { namespace: ns, report }
  }

  function stats({ namespace: explicitNamespace } = {}) {
    const { ns, dir } = root(explicitNamespace)
    return { namespace: ns, stats: computeNamespaceStats(dir), storeError: storeErrors.get(ns) || '' }
  }

  async function expand({ topic, entryType = 'fact', namespace: explicitNamespace } = {}) {
    const { ns, dir } = root(explicitNamespace)
    const type = entryType === 'sop' ? 'sop' : 'fact'
    const meta = getEntryMeta(dir, type, metaKey(type, topic)) || {}
    if (!meta.sourceSession || !meta.sourceSeqs?.length) {
      return { topic, entry_type: type, available: false, message: '该记忆没有 sourceSession/sourceSeqs 溯源信息', sourceSession: meta.sourceSession || '', sourceSeqs: meta.sourceSeqs || [] }
    }
    const sq = sessionQuery
    if (!sq || typeof sq.readSession !== 'function') {
      return { topic, entry_type: type, available: false, message: 'sessionQuery 服务不可用', sourceSession: meta.sourceSession, sourceSeqs: meta.sourceSeqs }
    }
    try {
      const snap = await sq.readSession(meta.sourceSession)
      const seqSet = new Set(meta.sourceSeqs.map(Number))
      const events = (snap.events || []).filter((event) => seqSet.has(Number(event.seq))).map((event) => ({
        seq: Number(event.seq),
        type: String(event.type || ''),
        time: Number(event.time || 0),
        text: typeof event.text === 'string' ? event.text : JSON.stringify(event).slice(0, 2000),
      }))
      return { topic, entry_type: type, available: true, sourceSession: meta.sourceSession, sourceSeqs: meta.sourceSeqs, events }
    } catch (error) {
      return { topic, entry_type: type, available: false, message: `展开失败: ${error?.message || error}`, sourceSession: meta.sourceSession, sourceSeqs: meta.sourceSeqs }
    }
  }

  function recordPending({ namespace: explicitNamespace, sourceSession, sourceSeqs, tools, reason, topic = '', entryType = '', evidence = '', content = '' } = {}) {
    const { ns, dir } = root(explicitNamespace)
    const name = writePending(dir, { sourceSession, sourceSeqs, tools, reason, topic, entryType, evidence, content })
    return { namespace: ns, name }
  }

  function archiveOptical(id, { hardDelete = false, namespace: explicitNamespace } = {}) {
    const { ns, dir } = root(explicitNamespace)
    const match = logicalEntries(dir, { activeOnly: false }).find((entry) => entry.meta.opticalId === id)
    if (match) {
      if (!hardDelete) return archive({ topic: match.topic, entryType: match.entryType, namespace: ns })
      setEntryMeta(dir, match.entryType, match.key, { archived: true, hardDeleted: true, archivedAt: new Date().toISOString() })
      syncIndex(dir, maxIndexLines)
      return { topic: match.topic, entry_type: match.entryType, namespace: ns, archived: true, hardDeleted: true }
    }
    return { namespace: ns, archived: false, id }
  }

  function namespaceIndex(explicitNamespace) {
    const { ns, dir } = root(explicitNamespace)
    return { namespace: ns, content: readIndex(dir) }
  }

  return {
    namespace,
    root,
    storeFor,
    write,
    read,
    list,
    index,
    pending,
    accept,
    update,
    archive,
    rollback,
    retrieve,
    maintain,
    stats,
    expand,
    recordPending,
    archiveOptical,
    namespaceIndex,
    logicalEntries: (explicitNamespace) => logicalEntries(root(explicitNamespace).dir),
  }
}
