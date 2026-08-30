简体中文 | [English](README.en.md)

# @dsh-external/dsh-ocr1-memory

一个 DSH 光学记忆插件，思路来自 **DeepSeek-OCR** 论文（Contexts Optical Compression，OCR1）。文本记忆按段落渲染成带 SoM 编号的图像，旧记忆按年龄降低分辨率。检索默认依据文本与 OCR 证据，配置了光学定位器的话，可以再由模型挑出相关段，最后确定性地返回原始 verbatim 文本。

把记忆渲染成图像，用的是论文里对长上下文做光学压缩的思路，这一步到底省了多少，`ocr1_mem_metrics` 会给出文本 token、视觉 token 和压缩比的实测数字，省不省一目了然。

## 能力

| 工具 | 作用 |
|---|---|
| `ocr1_mem_status` | 查看存储、渲染与 OCR 配置状态 |
| `ocr1_mem_store` | 分段、渲染并保存记忆 |
| `ocr1_mem_update` | 更新记忆并重置为最新层级 |
| `ocr1_mem_retrieve` | 检索、OCR 读回、active recall |
| `ocr1_mem_list` | 列出记忆条目与命中次数 |
| `ocr1_mem_metrics` | 查看文本/视觉 token 与压缩比 |
| `ocr1_mem_calibrate` | 校准文本 token 基线 |
| `ocr1_mem_forget` | 删除记忆及其光学产物 |
| `ocr1_mem_render_test` | 渲染管线自测 |
| `ocr1_mem_embed_test` | 视觉 embedding 自测 |
| `memory_read` / `memory_retrieve` | 读取 L1/L2/L3，并优先走 OCR1 光学召回 |
| `memory_write` / `memory_update` | 带 evidence 的治理写入，自动同步 OCR1 SoM |
| `memory_search` / `memory_promote` | 全文检索与跨 namespace 提升 |
| `memory_pending` / `memory_accept` | 审阅自动蒸馏候选并确认入库 |
| `memory_maintain` / `memory_stats` | 去重、L1 压缩、统计与光学状态 |
| `memory_index` / `memory_archive` / `memory_rollback` | 重建索引、归档与历史恢复 |
| `memory_expand` / `memory_activate` | 展开 DSH 溯源事件、激活记忆治理 |

## 工作方式

1. 文本按空行和长度切成段落，再渲染为 SoM 图像。
2. 记忆图像的分辨率随年龄在 `vivid → normal → fuzzy` 三级之间衰减。哪次检索命中了低清记忆，active recall 会先把它恢复成高清。
3. 配置光学定位器后，由模型输出 K 位 `0/1` 标签，插件按阈值和 Top-K 规则选出段落。
4. Fetch 阶段只从持久化原文取回选中的段，返回的就是原文本身，没有替代文本。
5. 视觉 embedding 和命中热度衰减是可选能力。每轮 context 注入默认开启，`index` 模式注入 L1 与光学元数据，要保留正文快照就选 `contextMode: snapshot`。
6. 治理工具和 OCR1 store 用的是同一个插件实例。每轮默认只注入 L1 与光学元数据，详细正文按需 Fetch，历史 context 快照靠 `contextMode: snapshot` 保留。
7. `tools/result` 里先失败后成功的序列会在 `turn/end` 生成 pending。到了维护周期或阈值就自动维护并提醒，正式记忆仍由带 evidence 的治理写入确认。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖需要的选项。

```yaml
- id: dsh-ocr1-memory
  config:
    storeDir: ''
    memoryDir: '~/.dsh/memory'
    maxIndexLines: 30
    autoNamespace: true
    autoPending: true
    maintainEveryTurns: 20
    maintenanceBatchSize: 8 # 每次维护最多处理的光学条目数
    reflectPendingThreshold: 5
    reflectSopsThreshold: 40

    # OCR / llama-server
    ocrBaseUrl: ''
    ocrApiKey: ''
    ocrModel: 'deepseek-ai/DeepSeek-OCR'
    requireOcr: false # true = OCR 不可用时失败，不静默走文本降级
    autoStartOcrServer: false
    ocrServerPath: '' # 也可使用 OCR_SERVER_PATH 或 PATH 中的 llama-server
    ocrModelDir: ''
    ocrServerPort: 18080

    # Optical locator
    opticalLocatorEnabled: false
    opticalLocatorBaseUrl: ''
    opticalLocatorModel: 'deepseek-ocr-memory'
    opticalLocatorThreshold: 0.4
    opticalLocatorTopK: 5
    opticalLocatorStrict: true
    opticalLocatorAutoStart: false
    opticalLocatorServerPath: ''
    opticalLocatorModelDir: ''
    opticalLocatorServerPort: 18081
    opticalLocatorModelFile: 'deepseek-ocr-locator-q8_0.gguf'
    opticalLocatorMmprojFile: 'mmproj-locator-q8_0.gguf'

    # Context / retrieval
    dynamicDecayEnabled: false
    autoInjectContext: true
    contextMode: 'index' # snapshot 可保留正文快照
    contextMaxEntries: 5
    contextMaxChars: 4000
    sharedStore: false
    embeddingRetrieval: false
    ocrMaxEntriesPerRetrieve: 5
```

想让插件自己管一个真实的 CPU `llama-server`，把 `autoStartOcrServer` 设为 `true`，同时提供 `ocrServerPath` 和 `ocrModelDir`。`ocrBaseUrl` 里写了显式端口的话，健康检查和启动都以它为准。Embedding 默认不参与主检索，复用同一个服务时把 `ocrEmbeddingBaseUrl` 留空即可。训练后的 Locator 可以通过 `opticalLocatorAutoStart` 在独立 endpoint 自动启动，模型目录也可以交给 `OPTICAL_LOCATOR_MODEL_DIR` 提供。

高级选项见 [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md)。

## 安装

```bash
dsh plugin --profile web add github:DDDFXYqiming/dsh-ocr1-memory
```

## OCR 后端

插件通过 OpenAI 兼容接口与后端通信（llama.cpp 官方文档列出了 `/v1/chat/completions`、`/v1/embeddings` 和多模态输入能力）。

- `/v1/chat/completions` 负责 OCR 读回和光学定位。
- `/v1/embeddings` 提供可选的多模态视觉 embedding。

配好 `ocrBaseUrl` 就能用上 OCR。`requireOcr: false` 时后端不可用会保留文本检索路径，`requireOcr: true` 时则直接报告 OCR 错误。`autoStartOcrServer` 开启后，插件按 endpoint 去重启动 `llama-server`，只清理自己启动的进程。后端启动、CPU-only 配置、模型格式和平台注意事项见 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)。

## 文档

| 文档 | 内容 |
|---|---|
| [WORKFLOW](docs/OPTICAL_MEMORY_WORKFLOW.md) | 工作流程图 |
| [IMPLEMENTATION](docs/IMPLEMENTATION.md) | 架构与实现说明 |
| [DEPLOYMENT](docs/DEPLOYMENT.md) | 后端部署与验证 |
| [STATUS](docs/STATUS.md) | 当前实现状态 |
| [BENCHMARK](docs/BENCHMARK.md) | 与 `dsh-memory` 的隔离对比 |
| [EXPLORATION](docs/EXPLORATION.md) | 研究与实测记录 |
| [TEST_SPEC](docs/TEST_SPEC.md) / [TEST_REPORT](docs/TEST_REPORT.md) | 测试说明与报告 |
| [PAPER_MAPPING](docs/2510.18234-paper-vs-plugin-verifiable-concepts.md) | 论文原生机制与插件工程扩展的逐项边界 |

当前 `npm test` 为 88/88 通过（无后端时真实后端用例会跳过）。

## 参考

- [DeepSeek-OCR](https://github.com/deepseek-ai/DeepSeek-OCR) · [论文](https://arxiv.org/abs/2510.18234)
- [OCR-Memory](https://arxiv.org/abs/2604.26622)
- [AgentOCR](https://github.com/langfengQ/AgentOCR)
