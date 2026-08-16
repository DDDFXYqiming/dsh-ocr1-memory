// dsh-ocr1-memory — DSH plugin entry.
// 基于 DeepSeek-OCR1 的光学压缩记忆系统（Agent 版）：
//   - 记忆渲染为图像（SoM 编号分段）；
//   - 用 DeepSeek-OCR（vLLM/OpenAI 兼容接口）读回；
//   - 旧记忆按年龄降分辨率（vivid → fuzzy）；
//   - 检索命中触发 active recall 恢复高清；
//   - 返回原始 verbatim 片段（Locate-and-Transcribe）。

import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'

import {
  createEmbeddingHttpClient,
  createMemoryStore,
  createMockRenderer,
  createOcrHttpClient,
  createRenderer,
  DEFAULT_TIERS,
  memoryMetrics,
  measureTextOnlyPromptTokens,
} from './core.js'
import { ensureOcrServer } from './ocr-server.js'

export const name = '@dsh-external/dsh-ocr1-memory'
export const inject = ['tools']

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
const DEFAULT_RENDER_SCRIPT = join(PLUGIN_DIR, '..', 'scripts', 'render_memory.py')
const DEFAULT_STORE_DIR = join(homedir(), '.dsh', 'ocr1-memory')

export const Config = Schema.object({
  storeDir: Schema.string().default(DEFAULT_STORE_DIR),
  ocrBaseUrl: Schema.string().default(''),
  ocrApiKey: Schema.string().default(''),
  ocrModel: Schema.string().default('deepseek-ai/DeepSeek-OCR'),
  pythonPath: Schema.string().default('python'),
  renderScript: Schema.string().default(DEFAULT_RENDER_SCRIPT),
  requireOcr: Schema.boolean().default(false),
  useMockRenderer: Schema.boolean().default(false),
  ocrRepeatPenalty: Schema.number().default(1.2),
  ocrNoRepeatNgramSize: Schema.number().default(30),
  ocrTextOnlyPromptTokens: Schema.number().default(5),
  autoStartOcrServer: Schema.boolean().default(false),
  ocrServerPath: Schema.string().default(''),
  ocrModelDir: Schema.string().default(''),
  ocrServerPort: Schema.number().default(18080),
  ocrEmbeddingBaseUrl: Schema.string().default(''),
  ocrEmbeddingApiKey: Schema.string().default(''),
  ocrEmbeddingModel: Schema.string().default(''),
  ocrEmbeddingTimeoutMs: Schema.number().default(120000),
  ocrEmbeddingEmptyPromptTokens: Schema.number().default(1),
  ocrEmbeddingAutoStart: Schema.boolean().default(false),
  ocrEmbeddingPort: Schema.number().default(18084),
  ocrEmbeddingUbatchSize: Schema.number().default(2048),
  ocrEmbeddingServerPath: Schema.string().default(''),
  ocrEmbeddingModelDir: Schema.string().default(''),
  ocrEmbeddingOnDemand: Schema.boolean().default(true),
  ocrEmbeddingIdleTimeoutMs: Schema.number().default(300000),
  ocrEmbeddingContextSize: Schema.number().default(2048),
  sharedStore: Schema.boolean().default(false),
  embeddingRetrieval: Schema.boolean().default(true),
})

export function apply(ctx, config = {}) {
  const cfg = {
    storeDir: config.storeDir || DEFAULT_STORE_DIR,
    ocrBaseUrl: config.ocrBaseUrl || '',
    ocrApiKey: config.ocrApiKey || '',
    ocrModel: config.ocrModel || 'deepseek-ai/DeepSeek-OCR',
    pythonPath: config.pythonPath || 'python',
    renderScript: config.renderScript || DEFAULT_RENDER_SCRIPT,
    requireOcr: config.requireOcr !== undefined ? Boolean(config.requireOcr) : false,
    useMockRenderer: Boolean(config.useMockRenderer),
    autoStartOcrServer: Boolean(config.autoStartOcrServer),
    ocrServerPath: config.ocrServerPath || process.env.OCR_SERVER_PATH || 'D:\\AI_Projects\\models\\llama.cpp\\llama-server.exe',
    ocrModelDir: config.ocrModelDir || process.env.OCR_MODEL_DIR || 'D:\\AI_Projects\\models\\deepseek-ocr-gguf',
    ocrServerPort: Number(config.ocrServerPort ?? 18080),
    ocrTextOnlyPromptTokens: Number(config.ocrTextOnlyPromptTokens ?? 5),
    ocrEmbeddingBaseUrl: config.ocrEmbeddingBaseUrl || config.ocrBaseUrl || '',
    ocrEmbeddingApiKey: config.ocrEmbeddingApiKey || '',
    ocrEmbeddingModel: config.ocrEmbeddingModel || '',
    ocrEmbeddingTimeoutMs: Number(config.ocrEmbeddingTimeoutMs ?? 120000),
    ocrEmbeddingEmptyPromptTokens: Number(config.ocrEmbeddingEmptyPromptTokens ?? 1),
    ocrEmbeddingAutoStart: Boolean(config.ocrEmbeddingAutoStart),
    ocrEmbeddingPort: Number(config.ocrEmbeddingPort ?? 18084),
    ocrEmbeddingUbatchSize: Number(config.ocrEmbeddingUbatchSize ?? 2048),
    ocrEmbeddingServerPath: config.ocrEmbeddingServerPath || process.env.OCR_EMBEDDING_SERVER_PATH || 'D:\\AI_Projects\\models\\llama.cpp\\llama-server.exe',
    ocrEmbeddingModelDir: config.ocrEmbeddingModelDir || process.env.OCR_EMBEDDING_MODEL_DIR || 'D:\\AI_Projects\\models\\deepseek-ocr-gguf',
    ocrEmbeddingOnDemand: config.ocrEmbeddingOnDemand !== undefined ? Boolean(config.ocrEmbeddingOnDemand) : true,
    ocrEmbeddingIdleTimeoutMs: Number(config.ocrEmbeddingIdleTimeoutMs ?? 300000),
    ocrEmbeddingContextSize: Number(config.ocrEmbeddingContextSize ?? 2048),
    sharedStore: Boolean(config.sharedStore),
    embeddingRetrieval: config.embeddingRetrieval !== undefined ? Boolean(config.embeddingRetrieval) : true,
  }

  mkdirSync(cfg.storeDir, { recursive: true })

  const renderer = cfg.useMockRenderer
    ? createMockRenderer()
    : createRenderer({ python: cfg.pythonPath, renderCommand: cfg.renderScript })
  const ocr = cfg.ocrBaseUrl
    ? createOcrHttpClient({
        baseUrl: cfg.ocrBaseUrl,
        apiKey: cfg.ocrApiKey,
        model: cfg.ocrModel,
        repeatPenalty: cfg.ocrRepeatPenalty || 0,
        noRepeatNgramSize: cfg.ocrNoRepeatNgramSize || 0,
      })
    : null
  const rawEmbedding = cfg.ocrEmbeddingBaseUrl
    ? createEmbeddingHttpClient({
        baseUrl: cfg.ocrEmbeddingBaseUrl,
        apiKey: cfg.ocrEmbeddingApiKey,
        model: cfg.ocrEmbeddingModel || cfg.ocrModel,
        timeoutMs: cfg.ocrEmbeddingTimeoutMs,
        emptyPromptTokens: cfg.ocrEmbeddingEmptyPromptTokens,
      })
    : null
  let embedding = rawEmbedding
  let embeddingManagedPid = null
  let embeddingEnsurePromise = null
  let embeddingIdleTimer = null

  async function ensureEmbeddingServer() {
    if (!rawEmbedding) return
    if (embeddingEnsurePromise) return embeddingEnsurePromise
    embeddingEnsurePromise = ensureOcrServer({
      baseUrl: cfg.ocrEmbeddingBaseUrl,
      port: cfg.ocrEmbeddingPort,
      serverPath: cfg.ocrEmbeddingServerPath,
      modelDir: cfg.ocrEmbeddingModelDir,
      embeddings: true,
      ubatchSize: cfg.ocrEmbeddingUbatchSize,
      contextSize: cfg.ocrEmbeddingContextSize,
    }).then((res) => {
      if (res.started && res.pid) embeddingManagedPid = res.pid
      return res
    }).finally(() => {
      embeddingEnsurePromise = null
    })
    return embeddingEnsurePromise
  }

  function scheduleEmbeddingIdleStop() {
    if (!cfg.ocrEmbeddingOnDemand || cfg.ocrEmbeddingAutoStart) return
    if (embeddingIdleTimer) clearTimeout(embeddingIdleTimer)
    embeddingIdleTimer = setTimeout(async () => {
      embeddingIdleTimer = null
      if (embeddingManagedPid) {
        try { process.kill(embeddingManagedPid) } catch { /* already stopped */ }
        embeddingManagedPid = null
      }
    }, cfg.ocrEmbeddingIdleTimeoutMs)
  }

  if (rawEmbedding && cfg.ocrEmbeddingOnDemand && !cfg.ocrEmbeddingAutoStart) {
    const base = rawEmbedding
    embedding = async (imagePath) => {
      await ensureEmbeddingServer()
      try {
        return await base(imagePath)
      } finally {
        scheduleEmbeddingIdleStop()
      }
    }
    embedding.embedText = async (text) => {
      await ensureEmbeddingServer()
      try {
        return await base.embedText(text)
      } finally {
        scheduleEmbeddingIdleStop()
      }
    }
  }

  const storePromise = createMemoryStore({
    storeDir: cfg.storeDir,
    renderer,
    ocr,
    embedding,
    tiers: DEFAULT_TIERS,
    requireOcr: cfg.requireOcr,
    textOnlyPromptTokens: cfg.ocrTextOnlyPromptTokens,
    shared: cfg.sharedStore,
    embeddingRetrieval: cfg.embeddingRetrieval,
  })

  if (cfg.autoStartOcrServer && cfg.ocrBaseUrl) {
    setTimeout(() => {
      ensureOcrServer({
        baseUrl: cfg.ocrBaseUrl,
        port: cfg.ocrServerPort,
        serverPath: cfg.ocrServerPath,
        modelDir: cfg.ocrModelDir,
      }).catch((err) => {
        console.error(`[ocr1-memory] auto-start OCR server failed: ${err?.message || err}`)
      })
    }, 0)
  }
  if (cfg.autoStartOcrServer && cfg.ocrEmbeddingBaseUrl && cfg.ocrEmbeddingBaseUrl !== cfg.ocrBaseUrl && cfg.ocrEmbeddingAutoStart) {
    setTimeout(() => {
      ensureOcrServer({
        baseUrl: cfg.ocrEmbeddingBaseUrl,
        port: cfg.ocrEmbeddingPort,
        serverPath: cfg.ocrEmbeddingServerPath,
        modelDir: cfg.ocrEmbeddingModelDir,
        embeddings: true,
        ubatchSize: cfg.ocrEmbeddingUbatchSize,
        contextSize: cfg.ocrEmbeddingContextSize,
      }).catch((err) => {
        console.error(`[ocr1-memory] auto-start embedding server failed: ${err?.message || err}`)
      })
    }, 0)
  }

  const disposers = []

  disposers.push(ctx.effect(() => ctx.tools.register(defineTool({
    name: 'ocr1_mem_status',
    description: '查看 OCR1 光学记忆插件状态：存储目录/OCR 后端/记忆条目数/渲染依赖是否可用',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          storeDir: { type: 'string', required: true },
          ocrBaseUrl: { type: 'string', required: true },
          ocrEmbeddingBaseUrl: { type: 'string', required: true },
          requireOcr: { type: 'boolean', required: true },
          entries: { type: 'integer', required: true },
          renderer: { type: 'string', required: true },
          tiers: { type: 'array', items: { type: 'string' }, required: true },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `OCR1 记忆状态：${value.ok ? 'OK' : 'WARN'} 条目=${value.entries} 目录=${value.storeDir}\nOCR 后端=${value.ocrBaseUrl || '未配置'}（requireOcr=${value.requireOcr}）\nEmbedding 后端=${value.ocrEmbeddingBaseUrl || '未配置'}\n渲染=${value.renderer}\n层级=${value.tiers.join(' → ')}` }],
    },
    async execute() {
      const store = await storePromise
      const entries = await store.list()
      const rendererReady = cfg.useMockRenderer || existsSync(cfg.renderScript)
      return {
        ok: rendererReady,
        storeDir: cfg.storeDir,
        ocrBaseUrl: cfg.ocrBaseUrl,
        ocrEmbeddingBaseUrl: cfg.ocrEmbeddingBaseUrl,
        requireOcr: cfg.requireOcr,
        entries: entries.length,
        renderer: cfg.useMockRenderer ? 'mock' : (rendererReady ? 'python' : 'missing'),
        tiers: DEFAULT_TIERS.map((t) => t.name),
        message: rendererReady ? '' : `renderScript 不存在: ${cfg.renderScript}`,
      }
    },
  })), 'ocr1-memory: status tool'))

  disposers.push(ctx.effect(() => ctx.tools.register(defineTool({
    name: 'ocr1_mem_store',
    description: '把一段文本存入光学记忆：自动分段并渲染为图像（含 SoM 编号），作为可检索记忆',
    parameters: {
      text: { type: 'string', required: true, description: '要记忆的文本' },
      source: { type: 'string', description: '来源标识（文件名/id），用于去重命名' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          segments: { type: 'integer', required: true },
          tier: { type: 'string', required: true },
          imagePath: { type: 'string', required: true },
          updated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `✅ 已记忆 ${value.segments} 段（id=${value.id}, 层级=${value.tier}${value.updated ? ', 已更新' : ''}）\n图像: ${value.imagePath}` }],
    },
    async execute(args) {
      const store = await storePromise
      return store.add({ text: args.text, source: args.source || '' })
    },
  })), 'ocr1-memory: store tool'))

  disposers.push(ctx.effect(() => ctx.tools.register(defineTool({
    name: 'ocr1_mem_update',
    description: '更新一条光学记忆：用新文本替换旧内容并重置为 vivid（用于冲突消解/最新值覆盖）',
    parameters: {
      id: { type: 'string', required: true, description: '要更新的记忆 id（ocr1_mem_list 可查）' },
      text: { type: 'string', required: true, description: '新的记忆内容' },
      source: { type: 'string', description: '可选：更新来源标识' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          segments: { type: 'integer', required: true },
          tier: { type: 'string', required: true },
          imagePath: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `✅ 已更新记忆 ${value.id}（${value.segments} 段, 层级=${value.tier}）\n图像: ${value.imagePath}` }],
    },
    async execute(args) {
      const store = await storePromise
      return store.update(args.id, { text: args.text, source: args.source || null })
    },
  })), 'ocr1-memory: update tool'))

  disposers.push(ctx.effect(() => ctx.tools.register(defineTool({
    name: 'ocr1_mem_retrieve',
    description: '按查询检索光学记忆：OCR 读回图像并做分段召回，命中低清记忆自动 active recall 恢复高清',
    parameters: {
      query: { type: 'string', required: true, description: '检索查询' },
      topK: { type: 'integer', description: '返回条数（默认 5）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', required: true },
          topK: { type: 'integer', required: true },
          results: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                entryId: { type: 'string', required: true },
                segmentId: { type: 'integer', required: true },
                content: { type: 'string', required: true },
                source: { type: 'string', required: true },
                score: { type: 'number', required: true },
                tier: { type: 'string', required: true },
              },
            },
            required: true,
          },
          total_entries: { type: 'integer', required: true },
          active_recalled: { type: 'integer', required: true },
          ran_at: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `检索「${value.query}」→ ${value.results.length} 条（记忆 ${value.total_entries} 条, active recall ${value.active_recalled}）:\n` +
          value.results.map((r) => `[${r.entryId}#${r.segmentId} (${r.score.toFixed(2)}, ${r.tier})] ${r.content.slice(0, 200)}`).join('\n'),
      }],
    },
    async execute(args) {
      const store = await storePromise
      return store.retrieve(args.query, { topK: args.topK || 5 })
    },
  })), 'ocr1-memory: retrieve tool'))

  disposers.push(ctx.effect(() => ctx.tools.register(defineTool({
    name: 'ocr1_mem_list',
    description: '列出光学记忆条目（id/来源/段数/层级/命中数/图像路径）',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          entries: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                source: { type: 'string', required: true },
                segments: { type: 'integer', required: true },
                createdAt: { type: 'string', required: true },
                tier: { type: 'string', required: true },
                resolution: { type: 'integer', required: true },
                hits: { type: 'integer', required: true },
                imagePath: { type: 'string', required: true },
              },
            },
            required: true,
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `光学记忆共 ${value.entries.length} 条:\n` + value.entries.map((e) => `- ${e.id} [${e.source}] segs=${e.segments} tier=${e.tier}@${e.resolution} hits=${e.hits}`).join('\n'),
      }],
    },
    async execute() {
      const store = await storePromise
      const entries = (await store.list()).map((e) => ({
        id: e.id,
        source: e.source,
        segments: e.segments,
        createdAt: e.createdAt,
        tier: e.tier,
        resolution: e.resolution,
        hits: e.hits,
        imagePath: e.imagePath,
      }))
      return { entries }
    },
  })), 'ocr1-memory: list tool'))

  disposers.push(ctx.effect(() => ctx.tools.register(defineTool({
    name: 'ocr1_mem_metrics',
    description: '查看光学记忆的压缩比指标：估算文本 token 数 / 视觉 token 数（对应 OCR1 光学压缩效果）',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          entries: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                source: { type: 'string', required: true },
                tier: { type: 'string', required: true },
                resolution: { type: 'integer', required: true },
                textTokens: { type: 'number', required: true },
                visualTokens: { type: 'number', required: true },
                compressionRatio: { type: 'number', required: true },
                measuredPromptTokens: { type: 'number' },
                measuredVisualTokensApprox: { type: 'number' },
                measuredCompressionRatioApprox: { type: 'number' },
                measuredVisualTokensDirect: { type: 'number' },
                measuredCompressionRatioDirect: { type: 'number' },
                storedVisualTokens: { type: 'number' },
                embeddingDim: { type: 'number' },
                embeddingSource: { type: 'string' },
                embeddingPromptTokens: { type: 'number' },
                embeddingError: { type: 'string' },
              },
            },
            required: true,
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `压缩比指标（文本 tokens / 视觉 tokens）:\n` + value.entries.map((e) => `- ${e.id} [${e.source}] ${e.tier}@${e.resolution}: ${e.textTokens}/${e.visualTokens} = ${e.compressionRatio.toFixed(2)}x` +
          (e.measuredVisualTokensDirect != null ? `, 直接视觉=${e.measuredVisualTokensDirect}, 直接压缩=${e.measuredCompressionRatioDirect?.toFixed(2)}x` : '') +
          (e.measuredPromptTokens != null ? `, prompt=${e.measuredPromptTokens}, 近似视觉=${e.measuredVisualTokensApprox}` : '') +
          (e.embeddingDim ? `, embedding=${e.embeddingDim}d/${e.embeddingSource || '?'}` : '') +
          (e.embeddingError ? `, embeddingErr=${e.embeddingError}` : '')).join('\n'),
      }],
    },
    async execute() {
      const store = await storePromise
      // Reload so metrics reflect the on-disk store even when another process
      // (e.g. a migration script) has written entries/embeddings.
      await store.reload()
      const entries = memoryMetrics(store.entries, DEFAULT_TIERS, cfg.ocrTextOnlyPromptTokens).map((e) => {
        // Drop null optional fields so strict DSH output schemas don't reject them.
        const out = {}
        for (const [k, v] of Object.entries(e)) if (v !== null && v !== undefined) out[k] = v
        return out
      })
      return { entries }
    },
  })), 'ocr1-memory: metrics tool'))

  disposers.push(ctx.effect(() => ctx.tools.register(defineTool({
    name: 'ocr1_mem_calibrate',
    description: '校准 OCR 文本基线：向 OCR 后端发送纯文本请求，返回 prompt_tokens，用于更准确地估算视觉 token 数',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          promptTokens: { type: 'integer', required: true },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.ok ? `✅ 文本基线 prompt_tokens=${value.promptTokens}（可将 ocrTextOnlyPromptTokens 设为该值）` : `❌ ${value.message}` }],
    },
    async execute() {
      if (!cfg.ocrBaseUrl) throw new Error('ocr1_mem_calibrate: ocrBaseUrl 未配置')
      try {
        const r = await measureTextOnlyPromptTokens({ baseUrl: cfg.ocrBaseUrl, apiKey: cfg.ocrApiKey, model: cfg.ocrModel })
        return { ok: true, promptTokens: r.promptTokens, message: '' }
      } catch (error) {
        return { ok: false, promptTokens: 0, message: error?.message || String(error) }
      }
    },
  })), 'ocr1-memory: calibrate tool'))

  disposers.push(ctx.effect(() => ctx.tools.register(defineTool({
    name: 'ocr1_mem_forget',
    description: '删除一条光学记忆（按 id，ocr1_mem_list 可查）',
    parameters: {
      id: { type: 'string', required: true, description: '记忆 id' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          removed: { type: 'boolean', required: true },
          id: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.removed ? `🗑️ 已删除记忆 ${value.id}` : `未找到记忆 ${value.id}` }],
    },
    async execute(args) {
      const store = await storePromise
      const r = await store.remove(args.id)
      return { removed: Boolean(r?.removed), id: args.id }
    },
  })), 'ocr1-memory: forget tool'))

  disposers.push(ctx.effect(() => ctx.tools.register(defineTool({
    name: 'ocr1_mem_render_test',
    description: '渲染测试：把一条文本按 SoM 渲染成图像并返回路径（用于验证渲染管线）',
    parameters: {
      text: { type: 'string', required: true, description: '测试文本' },
      width: { type: 'integer', description: '图像宽度（默认 1024）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          path: { type: 'string', required: true },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.ok ? `✅ 渲染成功: ${value.path}` : `❌ ${value.message}` }],
    },
    async execute(args) {
      try {
        const store = await storePromise
        const segments = [{ id: 1, content: args.text }]
        const outputPath = join(cfg.storeDir, `render-test-${Date.now()}.png`)
        await renderer(segments, outputPath, { width: args.width || 1024, som: true })
        return { ok: true, path: outputPath, message: '' }
      } catch (error) {
        return { ok: false, path: '', message: error?.message || String(error) }
      }
    },
  })), 'ocr1-memory: render test tool'))

  disposers.push(ctx.effect(() => ctx.tools.register(defineTool({
    name: 'ocr1_mem_embed_test',
    description: '视觉 embedding 测试：对文本渲染图或已有图像调用 DeepSeek-OCR embeddings 后端，返回真实 1280 维视觉 embedding 和直接视觉 token 数',
    parameters: {
      text: { type: 'string', description: '要渲染后测 embedding 的文本' },
      imagePath: { type: 'string', description: '已有图像路径（与 text 二选一）' },
      width: { type: 'integer', description: 'text 模式下的渲染宽度（默认 1024）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          imagePath: { type: 'string', required: true },
          dim: { type: 'integer', required: true },
          promptTokens: { type: 'integer', required: true },
          emptyPromptTokens: { type: 'integer', required: true },
          visualTokensDirect: { type: 'integer', required: true },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.ok
        ? `✅ 视觉 embedding: dim=${value.dim}, prompt=${value.promptTokens}, empty=${value.emptyPromptTokens}, 直接视觉 tokens=${value.visualTokensDirect}\n图像: ${value.imagePath}`
        : `❌ ${value.message}` }],
    },
    async execute(args) {
      try {
        if (!cfg.ocrEmbeddingBaseUrl) throw new Error('ocr1_mem_embed_test: ocrEmbeddingBaseUrl 未配置')
        if (!embedding) throw new Error('ocr1_mem_embed_test: embedding client 未初始化')
        let imagePath = args.imagePath || ''
        if (!imagePath) {
          if (!args.text) throw new Error('ocr1_mem_embed_test: 需要 text 或 imagePath')
          const segments = [{ id: 1, content: args.text }]
          imagePath = join(cfg.storeDir, `embed-test-${Date.now()}.png`)
          await renderer(segments, imagePath, { width: args.width || 1024, som: true })
        }
        const result = await embedding(imagePath)
        return {
          ok: true,
          imagePath,
          dim: result.dim,
          promptTokens: result.promptTokens,
          emptyPromptTokens: result.emptyPromptTokens,
          visualTokensDirect: result.visualTokens,
          message: '',
        }
      } catch (error) {
        return { ok: false, imagePath: args.imagePath || '', dim: 0, promptTokens: 0, emptyPromptTokens: 0, visualTokensDirect: 0, message: error?.message || String(error) }
      }
    },
  })), 'ocr1-memory: embed test tool'))

  disposers.push(() => {
    if (embeddingIdleTimer) clearTimeout(embeddingIdleTimer)
    if (embeddingManagedPid) {
      try { process.kill(embeddingManagedPid) } catch { /* already stopped */ }
    }
  })

  return () => {
    for (const fn of disposers) {
      if (typeof fn === 'function') fn()
    }
  }
}