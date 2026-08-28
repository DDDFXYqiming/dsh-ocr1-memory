import { defineTool } from '@deepseek-ai/dsh-tools'

const objectOutput = {
  type: 'object',
  additionalProperties: true,
}

function text(value) {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

export function createGovernanceTools(manager) {
  return [
    defineTool({
      name: 'memory_read',
      description: '读取 L1 索引、L2 fact 或 L3 SOP；默认只读文本，不调用 OCR。',
      parameters: {
        name: { type: 'string', required: true },
        namespace: { type: 'string' },
      },
      output: {
        schema: { ...objectOutput, properties: {
          name: { type: 'string', required: true },
          source: { type: 'string', required: true },
          content: { type: 'string', required: true },
          namespace: { type: 'string', required: true },
          not_found: { type: 'boolean' },
        } },
        render: (_args, value) => [{ type: 'text', text: value.not_found ? `记忆「${value.name}」未找到` : `记忆「${value.name}」：\n${value.content}` }],
      },
      async execute(args) {
        return manager.read(args)
      },
    }),

    defineTool({
      name: 'memory_list',
      description: '列出当前 namespace 的正式记忆、L1 行数和 pending 候选。',
      parameters: { namespace: { type: 'string' } },
      output: {
        schema: { ...objectOutput, properties: {
          namespace: { type: 'string', required: true },
          index_lines: { type: 'integer', required: true },
          entries: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
          facts: { type: 'array', required: true, items: { type: 'string' } },
          sops: { type: 'array', required: true, items: { type: 'string' } },
          pending: { type: 'array', required: true, items: { type: 'string' } },
        } },
        render: (_args, value) => [{ type: 'text', text: `记忆库[${value.namespace}]：${value.entries.length} 条，L1 ${value.index_lines} 行，pending ${value.pending.length} 条` }],
      },
      execute(args) {
        return manager.list(args)
      },
    }),

    defineTool({
      name: 'memory_write',
      description: '带 evidence 写入正式 L2 fact 或 L3 SOP；同时尽力建立光学表示，光学后端失败不影响文本记忆。',
      parameters: {
        topic: { type: 'string', required: true },
        entry_type: { type: 'string', enum: ['fact', 'sop'], required: true },
        content: { type: 'string', required: true },
        evidence: { type: 'string', required: true },
        namespace: { type: 'string' },
        source: { type: 'string' },
        sourceSession: { type: 'string' },
        sourceSeqs: { type: 'array', items: { type: 'integer' } },
      },
      output: {
        schema: { ...objectOutput, properties: {
          topic: { type: 'string', required: true },
          entry_type: { type: 'string', required: true },
          namespace: { type: 'string', required: true },
          action: { type: 'string', required: true },
          path: { type: 'string', required: true },
        } },
        render: (_args, value) => [{ type: 'text', text: `✅ 已写入记忆「${value.topic}」[${value.namespace}]（${value.entry_type}）` }],
      },
      async execute(args) {
        return manager.write({ ...args, entryType: args.entry_type })
      },
    }),

    defineTool({
      name: 'memory_retrieve',
      description: '先做逻辑文本检索，必要时才调用 OCR/embedding；返回原始内容、来源和溯源信息。',
      parameters: {
        query: { type: 'string', required: true },
        topK: { type: 'integer' },
        namespace: { type: 'string' },
      },
      output: {
        schema: { ...objectOutput, properties: {
          query: { type: 'string', required: true },
          namespace: { type: 'string', required: true },
          topK: { type: 'integer', required: true },
          results: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
          total_entries: { type: 'integer', required: true },
          optical_backend: { type: 'boolean', required: true },
          optical_error: { type: 'string' },
        } },
        render: (_args, value) => [{ type: 'text', text: `检索「${value.query}」→ ${value.results.length} 条（${value.optical_backend ? '含光学后端' : '文本降级'}）\n${value.results.map((r) => `[${r.topic || r.memoryId}] ${String(r.content || '').slice(0, 240)}`).join('\n')}` }],
      },
      async execute(args, exec) {
        return manager.retrieve({ ...args, signal: exec?.signal || null })
      },
    }),

    defineTool({
      name: 'memory_index',
      description: '重建 L1 索引，保留 RULES 并过滤归档条目。',
      parameters: { namespace: { type: 'string' } },
      output: {
        schema: { ...objectOutput, properties: {
          namespace: { type: 'string', required: true },
          index_lines: { type: 'integer', required: true },
          over_limit: { type: 'boolean', required: true },
          index: { type: 'string', required: true },
        } },
        render: (_args, value) => [{ type: 'text', text: `索引已重建[${value.namespace}]，${value.index_lines} 行` }],
      },
      execute(args) {
        return manager.index(args)
      },
    }),

    defineTool({
      name: 'memory_pending',
      description: '列出自动蒸馏的 pending 候选；候选未确认前不是正式记忆。',
      parameters: { namespace: { type: 'string' } },
      output: {
        schema: { ...objectOutput, properties: {
          namespace: { type: 'string', required: true },
          pending: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
        } },
        render: (_args, value) => [{ type: 'text', text: `Pending[${value.namespace}]：${value.pending.length} 条` }],
      },
      execute(args) {
        return manager.pending(args)
      },
    }),

    defineTool({
      name: 'memory_accept',
      description: '确认一条 pending 候选进入正式记忆；必要时补充 topic、类型、内容和 evidence。',
      parameters: {
        name: { type: 'string', required: true },
        topic: { type: 'string' },
        entry_type: { type: 'string', enum: ['fact', 'sop'] },
        content: { type: 'string' },
        evidence: { type: 'string' },
        namespace: { type: 'string' },
      },
      output: {
        schema: { ...objectOutput, properties: {
          accepted: { type: 'boolean', required: true },
          topic: { type: 'string', required: true },
          entry_type: { type: 'string', required: true },
          namespace: { type: 'string', required: true },
        } },
        render: (_args, value) => [{ type: 'text', text: value.accepted ? `✅ 已接受候选「${value.topic}」` : '未接受候选' }],
      },
      async execute(args) {
        return manager.accept({ ...args, entryType: args.entry_type })
      },
    }),

    defineTool({
      name: 'memory_update',
      description: '更新正式记忆，默认保留旧版本到 .history。',
      parameters: {
        topic: { type: 'string', required: true },
        entry_type: { type: 'string', enum: ['fact', 'sop'], required: true },
        content: { type: 'string', required: true },
        evidence: { type: 'string' },
        supersede: { type: 'boolean' },
        namespace: { type: 'string' },
      },
      output: {
        schema: { ...objectOutput, properties: {
          topic: { type: 'string', required: true },
          entry_type: { type: 'string', required: true },
          action: { type: 'string', required: true },
          namespace: { type: 'string', required: true },
        } },
        render: (_args, value) => [{ type: 'text', text: `✅ 已更新「${value.topic}」[${value.namespace}]` }],
      },
      async execute(args) {
        return manager.update({ ...args, entryType: args.entry_type })
      },
    }),

    defineTool({
      name: 'memory_archive',
      description: '归档记忆：隐藏于索引和检索，但保留文件、视觉表示和历史。',
      parameters: {
        topic: { type: 'string', required: true },
        entry_type: { type: 'string', enum: ['fact', 'sop'], required: true },
        namespace: { type: 'string' },
      },
      output: {
        schema: { ...objectOutput, properties: {
          topic: { type: 'string', required: true },
          entry_type: { type: 'string', required: true },
          namespace: { type: 'string', required: true },
          archived: { type: 'boolean', required: true },
        } },
        render: (_args, value) => [{ type: 'text', text: value.archived ? `📦 已归档「${value.topic}」` : `未找到「${value.topic}」` }],
      },
      execute(args) {
        return manager.archive({ ...args, entryType: args.entry_type })
      },
    }),

    defineTool({
      name: 'memory_rollback',
      description: '恢复 .history 中最近的记忆版本。',
      parameters: {
        topic: { type: 'string', required: true },
        entry_type: { type: 'string', enum: ['fact', 'sop'], required: true },
        namespace: { type: 'string' },
      },
      output: {
        schema: { ...objectOutput, properties: {
          topic: { type: 'string', required: true },
          entry_type: { type: 'string', required: true },
          namespace: { type: 'string', required: true },
          restored: { type: 'boolean', required: true },
        } },
        render: (_args, value) => [{ type: 'text', text: value.restored ? `♻️ 已回滚「${value.topic}」` : `没有可回滚版本「${value.topic}」` }],
      },
      async execute(args) {
        return manager.rollback({ ...args, entryType: args.entry_type })
      },
    }),

    defineTool({
      name: 'memory_stats',
      description: '统计正式记忆、pending、归档与光学后端状态。',
      parameters: { namespace: { type: 'string' } },
      output: {
        schema: { ...objectOutput, properties: {
          namespace: { type: 'string', required: true },
          stats: { type: 'object', additionalProperties: true, required: true },
        } },
        render: (_args, value) => [{ type: 'text', text: `统计[${value.namespace}]：${text(value.stats)}` }],
      },
      execute(args) {
        return manager.stats(args)
      },
    }),

    defineTool({
      name: 'memory_maintain',
      description: '执行去重、L1 压缩、统计和合并候选；失败不应阻断主任务。',
      parameters: { namespace: { type: 'string' } },
      output: {
        schema: { ...objectOutput, properties: {
          namespace: { type: 'string', required: true },
          report: { type: 'object', additionalProperties: true, required: true },
        } },
        render: (_args, value) => [{ type: 'text', text: `维护完成[${value.namespace}]：${text(value.report)}` }],
      },
      async execute(args) {
        return manager.maintain(args)
      },
    }),

    defineTool({
      name: 'memory_expand',
      description: '通过 sourceSession/sourceSeqs 展开一条记忆的原始 DSH session 事件。',
      parameters: {
        topic: { type: 'string', required: true },
        entry_type: { type: 'string', enum: ['fact', 'sop'], required: true },
        namespace: { type: 'string' },
      },
      output: {
        schema: { ...objectOutput, properties: {
          topic: { type: 'string', required: true },
          entry_type: { type: 'string', required: true },
          available: { type: 'boolean', required: true },
        } },
        render: (_args, value) => [{ type: 'text', text: value.available ? `📎 已展开「${value.topic}」` : `溯源不可用：${value.message || ''}` }],
      },
      async execute(args) {
        return manager.expand({ ...args, entryType: args.entry_type })
      },
    }),

    defineTool({
      name: 'memory_activate',
      description: '兼容 layered-memory 的渐进式激活入口；当前插件已注册完整记忆工具。',
      parameters: {},
      output: {
        schema: { ...objectOutput, properties: {
          activated: { type: 'boolean', required: true },
          tools: { type: 'array', required: true, items: { type: 'string' } },
        } },
        render: (_args, value) => [{ type: 'text', text: value.activated ? `记忆工具已激活：${value.tools.join(', ')}` : '记忆工具已存在' }],
      },
      execute() {
        return {
          activated: true,
          tools: [
            'memory_read', 'memory_list', 'memory_write', 'memory_retrieve', 'memory_index',
            'memory_pending', 'memory_accept', 'memory_update', 'memory_archive',
            'memory_rollback', 'memory_stats', 'memory_maintain', 'memory_expand',
          ],
        }
      },
    }),
  ]
}
