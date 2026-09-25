[简体中文] | [English](../docs_en/IMPLEMENTATION.md)

# 实现说明与复现范围

本文按代码说明插件的架构、主要数据流、配置和训练入口。平台部署见 [DEPLOYMENT.md](DEPLOYMENT.md)，实验记录见 [EXPLORATION.md](EXPLORATION.md)。

## 1. 架构与数据流

| 层 | 代码 | 职责 |
|---|---|---|
| 光学记忆引擎 | `lib/core.js` | 分段、SoM 渲染、tier 衰减、检索、定位器、缓存和并发保存 |
| DSH 入口 | `lib/index.js` | 配置、OCR/embedding 客户端、服务生命周期、工具和 context 注册 |
| context / L1 | `lib/context.js` | 从 manifest 同步生成限长的 L1 与光学元数据，或正文快照 |
| 记忆治理 | `lib/memory-system.js`、`lib/governance.js` | L1/L2/L3、namespace、evidence、provenance 和 OCR1 store |
| 自动维护 | `lib/automation.js`、`lib/skill-content.js` | runtime skill、pending 候选、turn/end 维护和阈值提醒 |
| 渲染与训练 | `scripts/` | SoM 图像、CJK 排版、定位数据、LoRA 训练和评估 |

写入时，输入按空行和长度切成有序 segment，渲染器生成带编号的方形 SoM 图像，原文写入 `memories.json`。图像缓存键包含内容、分辨率和渲染版本，内容或 tier 变化会使 OCR、定位器和 embedding 证据失效。`requireOcr` 控制 OCR 不可用时是否保留文本路径，`embeddingRetrieval` 控制持久化视觉 embedding。

默认 tier 为 `vivid`、`normal` 和 `fuzzy`。基础策略看 `createdAt`；打开 `dynamicDecayEnabled` 后，最多保存 32 条访问记录，近期命中会影响有效年龄，但倍率有上限且不会修改 `createdAt`。命中低清图像会触发 active recall。`list`、`status` 和指标读取只读取当前 manifest，不触发重渲染。

没有定位器时，检索使用文本重叠、OCR 证据和可选 embedding。开启 `opticalLocatorEnabled` 后，每张 SoM 图像请求 K 位 `0/1` 标签，`parseBinaryRelevance` 负责严格解析，`selectRelevanceIndices` 使用阈值和 Top-K 保底，最后按 segment 索引从 `memories.json` Fetch 原文。定位请求走 OpenAI 兼容接口，并可启用温度 0、logprobs 与 llama.cpp GBNF 约束。`opticalLocatorStrict` 会拒绝格式错误的定位结果。

`autoInjectContext` 通过 DSH 的 `systemPrompt.context()` 注册动态 context。`index` 模式注入 L1 定位索引和光学元数据，`snapshot` 模式保留正文快照。provider 只读磁盘，不做 OCR、embedding、检索或网络请求，损坏的 manifest 会产生空 context。`memory_maintain` 和自动维护按 namespace single-flight，每次最多处理 `maintenanceBatchSize` 条，支持取消并报告 `remaining` 与 `complete`。

自动治理记录同一工具的失败后成功序列，在 `turn/end` 生成 pending 候选，并按周期维护。正式记忆仍由 `memory_accept` 或带 evidence 的 `memory_write` 确认，自动化不会直接提升候选。

## 2. 关键配置

| 选项 | 默认 | 作用 |
|---|---|---|
| `memoryDir` | `~/.dsh/memory` | L1/L2/L3、pending、归档和 history 的根目录 |
| `maxIndexLines` | `30` | L1 索引行数上限 |
| `autoNamespace` | `true` | 从 workspace 或 git 上下文解析 namespace |
| `autoPending` | `true` | 从失败后成功序列生成 pending |
| `maintainEveryTurns` | `20` | 自动维护周期，`0` 表示关闭 |
| `maintenanceBatchSize` | `8` | 单次重渲染的过期或缺图条目数 |
| `reflectPendingThreshold` | `5` | pending 提醒阈值 |
| `reflectSopsThreshold` | `40` | 活跃 SOP 提醒阈值 |
| `ocrBaseUrl` | 空 | OpenAI 兼容的 `/v1/chat/completions` 地址 |
| `ocrModel` | `deepseek-ai/DeepSeek-OCR` | OCR 后端模型名 |
| `requireOcr` | `false` | OCR 不可用时是否直接失败 |
| `autoStartOcrServer` | `false` | 是否按 endpoint 确保 llama-server 在线 |
| `ocrServerPath` / `ocrModelDir` | 空 | 自动启动所需的可执行文件和模型目录 |
| `ocrServerPort` | `18080` | URL 没写端口时的启动端口 |
| `ocrEmbeddingBaseUrl` | 空 | embedding 地址，空值回退到 `ocrBaseUrl` |
| `ocrEmbeddingOnDemand` | `true` | 是否首次使用时启动独立 embedding 服务 |
| `ocrEmbeddingPort` | `18084` | 独立 embedding 服务默认端口 |
| `ocrMaxEntriesPerRetrieve` | `5` | 单次检索送入 OCR 的条目数 |
| `opticalLocatorEnabled` | `false` | 是否启用训练后的定位路径 |
| `opticalLocatorThreshold` | `0.4` | `p(1)` 选择阈值 |
| `opticalLocatorTopK` | `5` | 没有阈值命中时的数量 |
| `opticalLocatorStrict` | `true` | 是否拒绝格式错误的标签 |
| `opticalLocatorAutoStart` | `false` | 是否自动启动独立 Locator endpoint |
| `opticalLocatorServerPort` | `18081` | Locator 默认启动端口 |
| `dynamicDecayEnabled` | `false` | 是否启用近期命中衰减 |
| `autoInjectContext` | `true` | 是否每轮注入限长 context |
| `contextMode` | `index` | 选择 L1 元数据或正文快照 |
| `contextMaxEntries` | `5` | context 条目数上限 |
| `contextMaxChars` | `4000` | context 字符数上限 |
| `sharedStore` | `false` | 是否在每次操作前重载 manifest |
| `embeddingRetrieval` | `false` | 是否使用视觉 embedding 检索 |

渲染参数、定位器超时和最大 segment 数、embedding API 设置以及文本 token 基线，见 `lib/index.js` 的 `Config`。OCR 与 embedding 共用 endpoint 时使用 combined 启动规格，独立服务可以按需启动并在空闲超时后回收。插件只停止自己启动并记录 PID 的进程。

## 3. 定位器训练与复现范围

训练脚本把带 distractor 的问答样本转成 SoM 图像和 K 位二元标签，在冻结视觉编码器的 DeepSeek-OCR decoder 上训练 LoRA。训练只监督目标标签区间，并使用与推理相同的 `digit space ...` 语法。部署时可以把 adapter 合并回基础模型，再转换为目标多模态后端支持的格式。完整参数和已验证样例见 [DEPLOYMENT.md](DEPLOYMENT.md)。

小规模本地训练已经覆盖数据准备、训练、评估和标签一致性检查。它不能代表论文主表，完整规模还需要论文数据、完整评测套件和更长时间的推理服务。

| 论文概念 | 插件实现 | 当前判断 |
|---|---|---|
| 长文本到 optical 2D mapping | 段落转为 SoM 方形图像 | 工程近似 |
| visual tokens 承载信息 | tier 与接口级 token 统计 | 接口级近似 |
| DeepEncoder 内部压缩 | 公共 HTTP 接口未提供内部张量 | 未复刻 |
| 官方视觉 embedding | 兼容 embedding 接口可持久化 | 接口级 |
| SoM、Locate、Transcribe | 编号、严格标签解码、按索引返回原文 | 已实现 |
| age-aware tier、active recall | `vivid → normal → fuzzy` 与低清命中恢复 | 已实现 |
| hit-frequency decay | 有上限的可选近期命中策略 | 已实现，默认关闭 |
| 阈值、Top-K 与 per-turn context | 选择规则和 L1/光学元数据 context | 已实现 |

当前版本不宣称复现 DeepEncoder 的逐层 tensor、论文规模训练和主表评测，也不保证某种硬件、驱动、量化格式或服务管理器普遍兼容。这些边界来自公开接口、模型格式和可用资源，SoM、定位、确定性 Fetch、tier、active recall、动态衰减与 DSH context 仍可独立使用。

## 4. 相关文档

- [README.md](../README.zh.md) 快速入口
- [DEPLOYMENT.md](DEPLOYMENT.md) 后端部署与平台验证
- [STATUS.md](STATUS.md) 当前状态
- [BENCHMARK.md](BENCHMARK.md) 隔离基准
- [EXPLORATION.md](EXPLORATION.md) 研究与实验记录
- [TEST_SPEC.md](TEST_SPEC.md) 与 [TEST_REPORT.md](TEST_REPORT.md) 测试规范和结果
- [论文机制与插件边界清单](2510.18234-paper-vs-plugin-verifiable-concepts.md)
