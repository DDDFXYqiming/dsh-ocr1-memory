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
  bumpAccess,
  isArchived,
  isSafeMemName,
  computeNamespaceStats,
  runMaintain,
  slugify,
} from './governance.js'

function entryKey(entryType, topic) {
  return entryType === 'fact' ? String(topic).trim() : slugify(topic)
}

function opticalSource(namespace, entryType, topic) {
  return `governed:${slugify(namespace)}:${entryType}:${slugify(topic)}`
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
  maintenanceBatchSize = 8,
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
  const stores = new Map()
  const storeErrors = new Map()
  const maintenanceRuns = new Map()
  const cfg = { defaultNamespace, autoNamespace }
  // 根目录只 mkdir；只把实际解析出的 namespace 初始化成完整布局，
  // 避免把 memoryDir 根伪装成第二个（幽灵）default namespace。
  ensureMemoryLayout(memoryDir)
  ensureNamespaceLayout(nsRoot(memoryDir, resolveNamespace(cfg)))

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
    signal = null,
  }) {
    signal?.throwIfAborted()
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
        source: opticalSource(ns, type, safeTopic),
        signal,
      })
    } catch (error) {
      if (signal?.aborted) throw error
      opticalError = error?.message || String(error)
    }
    setEntryMeta(dir, type, key, {
      source: source || existing.source || safeTopic,
      opticalId: optical?.id || existing.opticalId || null,
      opticalSource: opticalSource(ns, type, safeTopic),
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
      bumpAccess(dir, 'index')
      return { name: key || 'index', source: 'index.txt', content: readIndex(dir), namespace: ns, meta: {} }
    }
    for (const candidate of [key, slugify(key)]) {
      const p = join(dir, 'sops', `${candidate}.md`)
      if (existsSync(p)) {
        const meta = getEntryMeta(dir, 'sop', candidate) || {}
        if (meta.archived) return { name: key, source: '', content: '', namespace: ns, meta: { ...meta, archived: true }, not_found: true }
        bumpAccess(dir, `sop:${candidate}`)
        return { name: key, source: `sops/${candidate}.md`, content: readSop(dir, candidate) || '', namespace: ns, meta }
      }
    }
    const fact = readFact(dir, key)
    if (fact !== null) {
      const meta = getEntryMeta(dir, 'fact', key) || {}
      if (meta.archived) return { name: key, source: '', content: '', namespace: ns, meta: { ...meta, archived: true }, not_found: true }
      bumpAccess(dir, `fact:${key}`)
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

  /** 全局反查：在全部 namespace 的逻辑条目中找到光学 id 对应的条目（跨 ns 同步用）。 */
  function locateOpticalEntry(id) {
    if (!id) return null
    for (const ns of availableNamespaces()) {
      const { dir } = root(ns)
      const match = logicalEntries(dir, { activeOnly: false }).find((entry) => entry.meta.opticalId === id)
      if (match) return { ns, dir, entry: match }
    }
    return null
  }

  async function archive({ topic, entryType = 'fact', namespace: explicitNamespace }) {
    const { ns, dir } = root(explicitNamespace)
    const type = entryType === 'sop' ? 'sop' : 'fact'
    const key = metaKey(type, topic)
    const exists = contentFor(dir, type, topic) !== null
    if (!exists) return { topic, entry_type: type, namespace: ns, archived: false }
    setEntryMeta(dir, type, key, { archived: true, archivedAt: new Date().toISOString() })
    syncIndex(dir, maxIndexLines)
    // 治理归档同步标光学条目标记：ocr1_mem_retrieve 与 L1 光学目录都会隐藏归档项。
    const meta = getEntryMeta(dir, type, key) || {}
    if (meta.opticalId) {
      try {
        const store = await storeFor(ns)
        await store.setArchived(meta.opticalId, true)
      } catch { /* 光学标记失败不阻断治理归档 */ }
    }
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

  function availableNamespaces() {
    const names = new Set(['default'])
    try {
      const reserved = new Set(['pending', 'archive', 'sops'])
      for (const entry of readdirSync(memoryDir, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith('.') && !reserved.has(entry.name)) names.add(entry.name)
      }
    } catch { /* a missing directory is initialized by root() */ }
    return [...names].sort()
  }

  function search({ query, namespace: explicitNamespace, allNamespaces = false, includeArchived = true, limit = 8 } = {}) {
    const needle = String(query || '').trim()
    if (!needle) throw new Error('memory_search: query 必填')
    const cap = Math.max(1, Math.min(50, Number(limit) || 8))
    const namespaces = allNamespaces ? availableNamespaces() : [namespace(explicitNamespace)]
    const results = []
    for (const ns of namespaces) {
      const { dir } = root(ns)
      const logical = logicalEntries(dir, { activeOnly: !includeArchived })
      for (const result of textRetrieve(logical, needle, cap)) {
        const entry = logical.find((item) => `${item.entryType}:${item.key}` === result.memoryId)
        results.push({
          ...result,
          namespace: ns,
          kind: result.entry_type,
          name: result.topic,
          archived: Boolean(entry?.meta?.archived),
          snippet: String(result.content || '').replace(/\s+/g, ' ').trim().slice(0, 240),
        })
      }
    }
    results.sort((a, b) => b.score - a.score || a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name))
    return {
      query: needle,
      namespaces_searched: namespaces,
      results: results.slice(0, cap),
    }
  }

  async function promote({ topic, entryType = 'fact', fromNamespace = '', toNamespace = 'default', archiveSource = true } = {}) {
    const safeTopic = String(topic || '').trim()
    const type = entryType === 'sop' ? 'sop' : 'fact'
    const fromNs = namespace(fromNamespace)
    const toNs = namespace(toNamespace || 'default')
    if (fromNs === toNs) throw new Error('memory_promote: 来源与目标命名空间相同')
    const fromRoot = root(fromNs).dir
    const key = metaKey(type, safeTopic)
    const content = contentFor(fromRoot, type, safeTopic)
    if (!safeTopic || content === null) {
      return { promoted: false, topic: safeTopic, entry_type: type, from: fromNs, to: toNs, source_archived: false }
    }
    const meta = getEntryMeta(fromRoot, type, key) || {}
    const result = await write({
      topic: safeTopic,
      entryType: type,
      content,
      evidence: meta.evidence || `promoted from namespace:${fromNs}`,
      sourceSession: meta.sourceSession || null,
      sourceSeqs: meta.sourceSeqs || [],
      source: `promoted:${fromNs}:${safeTopic}`,
      namespace: toNs,
    })
    if (archiveSource) {
      setEntryMeta(fromRoot, type, key, {
        archived: true,
        promotedTo: `${toNs}:${safeTopic}`,
        archivedAt: new Date().toISOString(),
      })
      syncIndex(fromRoot, maxIndexLines)
      // 源光学条目同步标 archived：跨 ns promote 后手动检索/目录不再暴露来源。
      const fromMeta = getEntryMeta(fromRoot, type, key) || {}
      if (fromMeta.opticalId) {
        try {
          const store = await storeFor(fromNs)
          await store.setArchived(fromMeta.opticalId, true)
        } catch { /* 尽力而为 */ }
      }
    }
    return {
      promoted: true,
      topic: safeTopic,
      entry_type: type,
      from: fromNs,
      to: toNs,
      source_archived: archiveSource,
      optical: result.optical,
    }
  }

  async function maintain({ namespace: explicitNamespace, signal = null, maxOpticalEntries = maintenanceBatchSize } = {}) {
    signal?.throwIfAborted()
    const { ns, dir } = root(explicitNamespace)
    if (maintenanceRuns.has(ns)) {
      return { namespace: ns, report: { status: 'already-running', complete: false } }
    }
    const run = Promise.resolve().then(async () => {
      signal?.throwIfAborted()
      const report = runMaintain(dir, maxIndexLines)
      signal?.throwIfAborted()
      try {
        const store = await storeFor(ns)
        report.optical = await store.refreshTiers({ limit: maxOpticalEntries, signal })
      } catch (error) {
        if (signal?.aborted) throw error
        report.opticalError = error?.message || String(error)
      }
      report.status = 'completed'
      report.complete = report.optical?.complete ?? true
      return { namespace: ns, report }
    }).finally(() => {
      maintenanceRuns.delete(ns)
    })
    maintenanceRuns.set(ns, run)
    return run
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

  function syncOpticalUpdate(id, { text, source = '', optical = null, namespace: explicitNamespace } = {}) {
    const located = locateOpticalEntry(id)
    if (!located) return { governed: false, namespace: explicitNamespace ? namespace(explicitNamespace) : namespace(), id }
    const { ns, dir, entry: match } = located
    const meta = match.meta || {}
    // 保留历史：光学手动更新同样走 supersede 语义（旧内容写入 .history），
    // 后续 memory_rollback 才能恢复到更新前。
    const oldContent = contentFor(dir, match.entryType, match.topic)
    if (oldContent !== null) {
      const history = join('.history', `${match.entryType}-${slugify(match.topic)}-${Date.now()}.md`)
      try { writeFileSync(join(dir, history), oldContent, 'utf8') } catch { /* best effort */ }
    }
    writeMemory(dir, {
      topic: match.topic,
      entryType: match.entryType,
      content: String(text || '').trim(),
      evidence: meta.evidence || 'ocr1_mem_update（手动光学更新同步）',
      sourceSession: meta.sourceSession || null,
      sourceSeqs: meta.sourceSeqs || [],
      namespace: ns,
    })
    setEntryMeta(dir, match.entryType, match.key, {
      source: source || meta.source || match.topic,
      opticalId: id,
      opticalSource: optical?.source || meta.opticalSource || opticalSource(ns, match.entryType, match.topic),
      opticalTier: optical?.tier || meta.opticalTier || 'vivid',
      opticalImagePath: optical?.imagePath || meta.opticalImagePath || null,
      opticalError: null,
      archived: false,
    })
    syncIndex(dir, maxIndexLines)
    return { governed: true, namespace: ns, topic: match.topic, entry_type: match.entryType, id, history: oldContent !== null }
  }

  async function archiveOptical(id, { hardDelete = false, namespace: explicitNamespace } = {}) {
    const located = locateOpticalEntry(id)
    if (located) {
      const { ns, dir, entry: match } = located
      if (!hardDelete) {
        return { ...(await archive({ topic: match.topic, entryType: match.entryType, namespace: ns })), id }
      }
      setEntryMeta(dir, match.entryType, match.key, { archived: true, hardDeleted: true, archivedAt: new Date().toISOString() })
      syncIndex(dir, maxIndexLines)
      return { topic: match.topic, entry_type: match.entryType, namespace: ns, archived: true, hardDeleted: true, id }
    }
    return { namespace: explicitNamespace ? namespace(explicitNamespace) : namespace(), archived: false, id }
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
    search,
    promote,
    maintain,
    stats,
    expand,
    recordPending,
    archiveOptical,
    syncOpticalUpdate,
    namespaceIndex,
    logicalEntries: (explicitNamespace) => logicalEntries(root(explicitNamespace).dir),
  }
}
