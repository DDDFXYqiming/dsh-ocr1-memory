// OCR1 memory governance automation: retry distillation, turn maintenance,
// threshold reflection, and persisted turn accounting.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { isArchived, pendingNames, readIndex, sopNames } from './governance.js'

const REFLECTION_COOLDOWN_TURNS = 10

function resultTail(result, max = 240) {
  try {
    let text = ''
    if (typeof result?.text === 'string') text = result.text
    else if (Array.isArray(result?.content)) {
      text = result.content
        .map((item) => typeof item?.text === 'string' ? item.text : '')
        .filter(Boolean)
        .join('\n')
    } else if (result?.error) text = String(result.error)
    else text = JSON.stringify(result ?? {})
    text = text.replace(/\s+/g, ' ').trim()
    return text.length > max ? `${text.slice(0, max)}…` : text
  } catch {
    return ''
  }
}

function bumpTurnCounter(root) {
  const path = join(root, 'turn-state.json')
  let state = {}
  try {
    state = JSON.parse(readFileSync(path, 'utf8')) || {}
  } catch {
    state = {}
  }
  const totalTurns = Math.max(0, Number(state.totalTurns) || 0) + 1
  writeFileSync(path, JSON.stringify({ totalTurns, updatedAt: new Date().toISOString() }, null, 2), 'utf8')
  return totalTurns
}

function getAgents(ctx) {
  try {
    return typeof ctx.get === 'function' ? ctx.get('agents') : null
  } catch {
    return null
  }
}

/**
 * Attach the old layered-memory event policy to the OCR1 governance manager.
 * Formal memory writes still require evidence; automation only creates pending
 * candidates from an observed failure-then-success retry sequence.
 */
export function wireAutomation(ctx, cfg, manager) {
  if (!ctx || typeof ctx.on !== 'function') return () => {}

  const retryTrackers = new Map()
  const capturedSequences = new Map()
  const reflectionState = new Map()
  const disposers = []

  const addDisposer = (value) => {
    if (typeof value === 'function') disposers.push(value)
  }

  addDisposer(ctx.on('tools/result', (exec, result) => {
    try {
      if (!cfg.autoPending || !exec?.agent?.id) return undefined
      const sessionId = String(exec.agent.id)
      const tool = String(exec.name || 'unknown')
      if (result?.isError) {
        const byTool = retryTrackers.get(sessionId) || new Map()
        const previous = byTool.get(tool) || { fails: 0, errorTail: '' }
        byTool.set(tool, {
          fails: previous.fails + 1,
          errorTail: resultTail(result),
        })
        retryTrackers.set(sessionId, byTool)
      } else {
        const byTool = retryTrackers.get(sessionId)
        const retry = byTool?.get(tool)
        if (retry) {
          const sequences = capturedSequences.get(sessionId) || []
          sequences.push({
            tool,
            fails: retry.fails,
            errorTail: retry.errorTail,
            successTail: resultTail(result),
          })
          capturedSequences.set(sessionId, sequences)
          byTool.delete(tool)
        }
      }
    } catch {
      // Event observation must never affect the tool result path.
    }
    return undefined
  }))

  addDisposer(ctx.on('session/event', (session, event) => {
    if (!event || event.type !== 'turn/end') return undefined
    const sessionId = String(session?.id ?? '')
    try {
      const { ns, dir } = manager.root()
      const totalTurns = bumpTurnCounter(dir)

      if (cfg.autoPending && sessionId) {
        const sequences = capturedSequences.get(sessionId)
        if (Array.isArray(sequences) && sequences.length > 0) {
          const details = sequences.map((item) => [
            `- 工具: ${item.tool}`,
            `- 失败次数: ${item.fails}`,
            `- 错误尾部: ${item.errorTail || '（无）'}`,
            `- 成功结果尾部: ${item.successTail || '（无）'}`,
          ].join('\n')).join('\n')
          manager.recordPending({
            namespace: ns,
            sourceSession: sessionId,
            sourceSeqs: typeof event.seq === 'number' ? [event.seq] : [],
            tools: sequences.map((item) => item.tool),
            reason: `本回合出现 ${sequences.length} 个「先失败后成功」的重试序列，请审阅后决定是否沉淀为 SOP。`,
            content: [
              '# Retry sequence candidate',
              '',
              '- kind: retry-sequence',
              `- 本回合有 ${sequences.length} 个先失败后成功的重试序列`,
              details,
              '',
              '请用 memory_accept 确认并补充 topic、entry_type、content、evidence，或忽略此候选。',
            ].join('\n'),
          })
          capturedSequences.delete(sessionId)
        }
      }

      if (cfg.maintainEveryTurns > 0 && totalTurns % cfg.maintainEveryTurns === 0) {
        void Promise.resolve(manager.maintain({ namespace: ns })).catch(() => {})
      }

      if (!sessionId) return undefined
      const pendingCount = pendingNames(dir).length
      const sopCount = sopNames(dir).filter((name) => !isArchived(dir, 'sop', name)).length
      const indexLines = readIndex(dir).split('\n').length
      const overPending = pendingCount >= cfg.reflectPendingThreshold
      const overSops = sopCount >= cfg.reflectSopsThreshold
      const overIndex = indexLines > cfg.maxIndexLines
      const previous = reflectionState.get(sessionId) || { lastReflectionTurn: -Infinity }
      const cooled = totalTurns - previous.lastReflectionTurn >= REFLECTION_COOLDOWN_TURNS
      if (!(overPending || overSops || overIndex) || !cooled) return undefined

      const agents = getAgents(ctx)
      const agent = agents?.get?.(sessionId)
      if (!agent || typeof agent.inject !== 'function') return undefined
      const parts = []
      if (overPending) parts.push(`pending 候选 ${pendingCount} 条（阈值 ${cfg.reflectPendingThreshold}），请用 memory_pending 审阅并用 memory_accept 确认有价值内容`)
      if (overSops) parts.push(`L3 SOP ${sopCount} 条（阈值 ${cfg.reflectSopsThreshold}），请用 memory_maintain 查看去重和合并候选`)
      if (overIndex) parts.push(`L1 索引 ${indexLines} 行（上限 ${cfg.maxIndexLines}），请用 memory_maintain 压缩`)
      agent.inject({
        content: [{ type: 'text', text: `[记忆整理请求] ${parts.join('；')}。（正式写入仍需行动验证证据）` }],
        source: { kind: 'plugin', plugin: 'ocr1-memory' },
      })
      reflectionState.set(sessionId, { lastReflectionTurn: totalTurns })
    } catch {
      // Maintenance and reflection are best-effort side effects.
    }
    return undefined
  }))

  addDisposer(ctx.on('agent/disposed', ({ agent }) => {
    const id = String(agent?.id ?? '')
    retryTrackers.delete(id)
    capturedSequences.delete(id)
    reflectionState.delete(id)
    return undefined
  }))

  return () => {
    for (const dispose of disposers.reverse()) {
      try { dispose() } catch { /* best effort */ }
    }
  }
}

export { bumpTurnCounter }
