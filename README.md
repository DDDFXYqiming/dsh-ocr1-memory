简体中文 | [English](README.en.md)

# @dsh-external/dsh-ocr1-memory

受 **DeepSeek-OCR: Contexts Optical Compression**（OCR1）启发的 DSH 光学记忆插件。

文本记忆会被按段落渲染为带 SoM 编号的图像，旧记忆按年龄降低分辨率；检索默认走文本/OCR 证据，可选由光学定位器选择相关段，最后确定性地返回原始 verbatim 文本。

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

1. 文本按空行和长度切成段落，并渲染为 SoM 图像。
2. `vivid → normal → fuzzy` 三级分辨率随年龄衰减；命中低清记忆时 active recall 恢复高清。
3. 配置光学定位器后，模型输出 K 位 `0/1` 标签，插件按阈值和 Top-K 规则选择段。
4. Fetch 阶段只从持久化原文取回选中段，不生成替代文本。
5. 视觉 embedding、命中热度衰减和每轮 context 注入都是可选能力。
6. 治理工具和 OCR1 store 使用同一插件实例；默认每轮只注入 L1/光学元数据，详细正文按需 Fetch，历史 context 快照可通过 `contextMode: snapshot` 保留。
7. `tools/result` 的失败后成功序列会在 `turn/end` 生成 pending；达到维护周期或阈值时自动维护/提醒，正式记忆仍由带 evidence 的治理写入确认。

## 配置

在 profile 的 `cordis.patch.yml` 中覆盖需要的选项：

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

需要真实 CPU `llama-server` 时，可将 `autoStartOcrServer` 设为 `true`，并同时提供 `ocrServerPath` 与 `ocrModelDir`；`ocrBaseUrl` 中的显式端口优先用于健康检查和启动。Embedding 默认不参与主检索；若复用同一服务，将 `ocrEmbeddingBaseUrl` 留空即可。

高级选项见 [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md)。

## 安装

```bash
dsh plugin --profile web add github:DDDFXYqiming/dsh-ocr1-memory
```

## OCR 后端

插件使用 OpenAI 兼容接口（llama.cpp 官方文档列出 `/v1/chat/completions`、`/v1/embeddings` 和多模态输入能力）：

- `/v1/chat/completions`：OCR 读回和光学定位；
- `/v1/embeddings`：可选的多模态视觉 embedding。

配置 `ocrBaseUrl` 后即可使用 OCR。`requireOcr: false` 时后端不可用会保留文本检索路径；`requireOcr: true` 时会直接报告 OCR 错误。`autoStartOcrServer` 开启后，插件按 endpoint 去重启动 `llama-server`，仅在插件自己启动的进程上执行卸载清理。后端启动、CPU-only 配置、模型格式和平台注意事项见 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)。

## 文档

- [WORKFLOW](docs/OPTICAL_MEMORY_WORKFLOW.md)：工作流程图；
- [IMPLEMENTATION](docs/IMPLEMENTATION.md)：架构与实现说明；
- [DEPLOYMENT](docs/DEPLOYMENT.md)：后端部署与验证；
- [STATUS](docs/STATUS.md)：当前实现状态；
- [BENCHMARK](docs/BENCHMARK.md)：与 `dsh-memory` 的隔离对比；
- [EXPLORATION](docs/EXPLORATION.md)：研究与实测记录；
- [TEST_SPEC](docs/TEST_SPEC.md) / [TEST_REPORT](docs/TEST_REPORT.md)：测试说明与报告；当前 `npm test` 为 88/88 通过（无后端时真实后端用例会跳过）。
- [PAPER_MAPPING](docs/2510.18234-paper-vs-plugin-verifiable-concepts.md)：论文原生机制与插件工程扩展的逐项边界。

## 参考

- [DeepSeek-OCR](https://github.com/deepseek-ai/DeepSeek-OCR) · [论文](https://arxiv.org/abs/2510.18234)
- [OCR-Memory](https://arxiv.org/abs/2604.26622)
- [AgentOCR](https://github.com/langfengQ/AgentOCR)
