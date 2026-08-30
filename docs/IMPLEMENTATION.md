简体中文 | [English](../docs_en/IMPLEMENTATION.md)

# 实现说明（Implementation & Reproduction Status）

本文说明插件的架构、关键数据流、可选配置，以及对 DeepSeek-OCR（OCR1）和 OCR-Memory 方法的复现范围。部署实验与平台相关记录见 [DEPLOYMENT.md](DEPLOYMENT.md)，研究过程见 [EXPLORATION.md](EXPLORATION.md)。

## 1. 架构

| 层 | 代码 | 职责 |
|---|---|---|
| 光学记忆引擎 | `lib/core.js` | 分段、SoM 渲染调度、层级衰减、检索、定位器、缓存与并发保存 |
| DSH 入口 | `lib/index.js` | 配置解析、OCR/embedding 客户端、服务生命周期、OCR1 工具和治理工具注册 |
| context / L1 | `lib/context.js` | 同步生成限长的 L1/光学元数据 context，或兼容正文快照；不调用模型 |
| 分层治理适配器 | `lib/memory-system.js`、`lib/governance.js` | L1/L2/L3 记忆、命名空间、证据与溯源，并通过同一 OCR1 store 持久化光学表示 |
| 自动治理 | `lib/automation.js`、`lib/skill-content.js` | runtime skill、失败后成功 pending、turn/end 维护和阈值提醒 |
| 渲染器 | `scripts/render_memory.py` | 方形 SoM 图像、编号标签、CJK 字体与长文本布局 |
| 训练辅助 | `scripts/prepare_hotpotqa_locator.py`、`train_locator_unsloth.py`、`eval_locator.py` | 定位数据、LoRA 训练、评估和 collator 对齐检查 |

## 2. 数据流

### 2.1 写入

1. 输入文本按空行和长度切分为有序段落，段落 id 从 1 开始。
2. 渲染器把段落画到带编号的方形 SoM 图像中；原始段落同时写入 `memories.json`，作为确定性 Fetch 的唯一文本来源。
3. 图像按内容、分辨率和渲染版本生成缓存键。相同内容可复用缓存，内容或 tier 变化会使 OCR、定位器和 embedding 证据失效。
4. OCR 读回是可选的：`requireOcr: false` 时没有 OCR 客户端仍可保留文本路径，`requireOcr: true` 时 OCR 读回缺失或失败会报告错误。
5. 视觉 embedding 只有在 `embeddingRetrieval: true` 时才由持久化记忆生成；`ocr1_mem_embed_test` 仍可单独验证已配置的 embedding 客户端。

### 2.2 层级与热度

默认 tier 为：

- `vivid`：新鲜记忆的高分辨率表示；
- `normal`：经过第一阶段年龄衰减的表示；
- `fuzzy`：长期记忆的低分辨率表示。

基础策略只依据 `createdAt`。启用 `dynamicDecayEnabled` 后，命中时间会以最多 32 条的 `accessHistory` 保存，近期命中按指数权重计算有限倍率：

```text
effectiveAge = age(createdAt) / boundedHeatMultiplier(recent access frequency)
```

倍率有上限，且随访问变旧平滑下降；它不会修改 `createdAt`，也不会让记忆永久保持高清。该选项默认关闭，以避免升级旧库后改变既有 tier 行为。命中低清记忆仍会触发 active recall，并在短暂豁免期内保持 vivid。

`list`、`status` 和指标读取只投影当前 manifest，不触发重渲染、OCR 或 embedding。层级迁移由显式 `memory_maintain` 或自动维护执行，每次最多处理 `maintenanceBatchSize` 条；报告中的 `remaining`/`complete` 表示是否还有后续批次。维护按 namespace single-flight；重复调用返回 `already-running`，取消信号会传到 renderer/OCR/embedding，插件卸载会取消并等待自己拥有的维护任务。

### 2.3 检索

无定位器时，插件使用文本重叠、OCR 读回证据和可选 embedding 的 legacy 路径。配置 `opticalLocatorEnabled` 后，流程变为：

1. 对每条当前 SoM 图像请求 K 位 `0/1` 相关性标签；
2. `parseBinaryRelevance` 严格解析标签及 logprobs；
3. `selectRelevanceIndices` 使用阈值（默认 `0.4`），无命中时使用 Top-K 保底；
4. 只按段索引从 `memories.json` Fetch 原文，返回 verbatim，不生成复述。

定位请求通过 OpenAI 兼容接口发送，图像位于消息前部，带训练一致的换行前缀、温度 0、logprobs 和 llama.cpp GBNF 语法约束。`opticalLocatorStrict` 开启时，格式错误直接失败，不回退到文本打分。

### 2.4 每轮 context 快照

`autoInjectContext` 开启后，入口通过 DSH `systemPrompt.context()` 注册动态贡献。默认 `contextMode: index` 注入当前 namespace 的 L1 定位索引和光学 manifest 元数据（id、source、tier、segments、hits），不注入正文；`contextMode: snapshot` 注册兼容的正文快照 `ocr1-memory:context`。

provider 只读磁盘，不做 OCR、embedding、检索或网络请求；manifest 或索引损坏时返回空字符串，不阻断 prompt 组装。详细内容通过治理读取/检索工具按需 Fetch。

### 2.5 治理自动化

`lib/automation.js` 复用旧 layered-memory 的事件策略：记录同一工具的失败后成功序列，在 `session/event` 的 `turn/end` 写入 pending 候选；持久化 namespace 级 `turn-state.json`，按 `maintainEveryTurns` 执行维护，并在 pending、SOP 或 L1 超阈值且冷却结束后向 Agent 注入整理提醒。自动维护也使用 namespace single-flight，并在 disposer 中取消、等待尚未结束的任务。自动化不会直接把候选提升为正式记忆，正式写入仍由 `memory_accept`/`memory_write` 提供 evidence。

## 3. 配置要点

| 选项 | 默认 | 说明 |
|---|---:|---|
| `memoryDir` | `~/.dsh/memory` | 治理控制面根目录；按 namespace 保存 L1/L2/L3、pending 与 history |
| `maxIndexLines` | `30` | L1 索引最大行数 |
| `defaultNamespace` | 空 | 未启用自动命名空间时使用的名称 |
| `autoNamespace` | `true` | 从 workspace/git 上下文解析 namespace |
| `autoPending` | `true` | 是否从失败后成功序列生成 pending |
| `maintainEveryTurns` | `20` | 持久 turn 计数触发维护的周期；0 表示关闭 |
| `maintenanceBatchSize` | `8` | 每次维护最多重渲染的过期/缺图条目数 |
| `reflectPendingThreshold` | `5` | pending 阈值提醒 |
| `reflectSopsThreshold` | `40` | 活跃 SOP 阈值提醒 |
| `ocrBaseUrl` | 空 | OpenAI 兼容的 `/v1/chat/completions` 地址；显式端口也决定自动启动端口 |
| `requireOcr` | `false` | OCR 不可用时是否直接失败；`true` 不走静默文本降级 |
| `autoStartOcrServer` | `false` | 是否由插件按 endpoint 确保 `llama-server` 在线 |
| `ocrServerPath` / `ocrModelDir` | 空 | 自动启动时的可执行文件和模型目录；也可用 `OCR_SERVER_PATH` / `OCR_MODEL_DIR` |
| `ocrServerPort` | `18080` | URL 未写端口时的启动端口；URL 显式端口优先 |
| `ocrEmbeddingBaseUrl` | 空 | Embedding 地址；空值回退到 `ocrBaseUrl` |
| `ocrEmbeddingAutoStart` | `false` | 独立 embedding endpoint 是否在加载时自动启动 |
| `ocrEmbeddingOnDemand` | `true` | 独立 embedding 服务是否首次使用时启动 |
| `ocrEmbeddingPort` | `18084` | 独立 embedding 服务的默认端口 |
| `ocrEmbeddingUbatchSize` | `2048` | embedding llama-server 的 physical batch 上限 |
| `ocrEmbeddingContextSize` | `2048` | embedding/combined 服务的上下文长度 |
| `ocrEmbeddingIdleTimeoutMs` | `300000` | 按需独立 embedding 服务的空闲回收时间 |
| `ocrMaxEntriesPerRetrieve` | `5` | 每次检索最多请求 OCR 的条目数 |
| `opticalLocatorEnabled` | `false` | 是否走训练后的光学定位路径 |
| `opticalLocatorThreshold` | `0.4` | `p(1)` 选择阈值 |
| `opticalLocatorTopK` | `5` | 无阈值命中时的保底数量 |
| `opticalLocatorStrict` | `true` | 定位标签格式错误时是否拒绝回退 |
| `dynamicDecayEnabled` | `false` | 是否启用近期命中热度衰减 |
| `decayFrequencyWindowMs` | 7 天 | 命中频率的平滑窗口 |
| `decayRecencyHalfLifeMs` | 14 天 | 最近一次访问的权重半衰期 |
| `decayHitWeight` | `1` | 热度对倍率的权重 |
| `decayMaxMultiplier` | `4` | 有效年龄倍率上限 |
| `autoInjectContext` | `true` | 是否每轮注入限长 context |
| `contextMode` | `index` | `index` 注入 L1/光学元数据；`snapshot` 注入兼容正文快照 |
| `contextMaxEntries` | `5` | 摘要最多包含的记忆条目 |
| `contextMaxChars` | `4000` | 摘要最大字符数 |
| `sharedStore` | `false` | 是否每次操作前重载 manifest |
| `embeddingRetrieval` | `false` | 是否启用视觉 embedding 检索信号 |

其余渲染参数（`pythonPath`、`renderScript`、重复惩罚）、定位器超时/最大段数、embedding API key 与空文本 token 基线可直接查看 `lib/index.js` 的 `Config`。

当 OCR 与 embedding 共用同一个 endpoint 时，插件使用 combined 启动规格；独立 embedding endpoint 则可按需拉起并在 `ocrEmbeddingIdleTimeoutMs` 后回收。插件只停止自己启动并记录 PID 的服务，外部已运行的服务不会被卸载清理。

## 4. 定位器训练与部署链

训练脚本把带 distractor 的问答样本转成 SoM 图像和 K 位二元标签，再用 DeepSeek-OCR decoder 的 LoRA 适配器学习 Locate 任务。训练侧冻结视觉编码器，使用 q/k/v/o 投影的 LoRA、严格的标签区间监督和与推理一致的 `digit space ...` 输出语法。

部署时可以把 adapter 合并回基础模型，再转换为目标推理后端支持的模型格式；运行时只要求 `/v1/chat/completions` 兼容接口和对应的多模态图像输入。模型格式转换、量化选择、服务参数和已验证的端到端样例属于平台实验，见 [DEPLOYMENT.md](DEPLOYMENT.md)。

本仓库包含数据准备、训练、评估和对齐检查脚本，但小规模本地训练结果不等于论文主表复现；完整规模需要论文所用数据集和评测套件。

## 5. 论文复现矩阵

### 5.1 DeepSeek-OCR（OCR1）

| 论文概念 | 插件实现 | 程度 |
|---|---|---|
| 长文本到 optical 2D mapping | 段落 → SoM 方形图像 | 工程近似 |
| visual tokens 承载信息 | 对应分辨率 tier，并记录后端接口级 token 统计 | 接口级近似 |
| DeepEncoder 内部压缩 | 未从 llama.cpp 公共接口取得内部张量或逐层 token | 未复刻 |
| 官方视觉 embedding | 可通过兼容的 embedding 接口持久化，默认不作为主检索信号 | 接口级 |

### 5.2 OCR-Memory

| 方法概念 | 插件实现 | 程度 |
|---|---|---|
| SoM 编号分段 | 编号框和段落索引持久化 | 已实现 |
| Locate | LoRA 定位器输出 K 位二元标签，支持严格语法解码 | 已实现 |
| Transcribe | 按索引返回持久化 verbatim 原文 | 已实现 |
| age-aware multi-resolution | `vivid → normal → fuzzy`，按年龄重渲染 | 已实现 |
| hit-frequency decay | 有上限、可选、向后兼容的近期命中热度策略 | 已实现（默认关闭） |
| active recall | 命中低清图像后恢复 vivid | 已实现 |
| 阈值与 Top-K | 默认阈值 + 无命中保底，可切换 union 规则 | 已实现 |
| 每轮记忆 context | L1/光学元数据，兼容正文快照可选 | 已实现（默认开启） |

## 6. 明确边界

以下内容不在本插件中宣称完整复现：

- DeepEncoder 内部压缩实现、逐层 visual-token 数和内部张量可视化；
- 论文规模的训练数据、Mind2Web/AppWorld/RULER 等主表评测；
- 与官方内部 DeepEncoder 完全等价的多模态 embedding 输出；
- 任何特定硬件、驱动、量化格式或服务编排的普遍兼容性。

这些边界来自运行时公开接口、模型格式和可用资源，不影响 SoM、定位、确定性 Fetch、年龄 tier、active recall 以及可选 context 的工程功能。

## 7. 相关文档

- [README.md](../README.md)：快速入口；
- [DEPLOYMENT.md](DEPLOYMENT.md)：后端部署与平台验证记录；
- [STATUS.md](STATUS.md)：当前状态；
- [BENCHMARK.md](BENCHMARK.md)：隔离基准；
- [EXPLORATION.md](EXPLORATION.md)：研究与实验记录；
- [TEST_SPEC.md](TEST_SPEC.md) / [TEST_REPORT.md](TEST_REPORT.md)：测试规范与结果；当前全量回归为 88/88（健康真实后端可用时）。
- [2510.18234-paper-vs-plugin-verifiable-concepts.md](2510.18234-paper-vs-plugin-verifiable-concepts.md)：论文原生机制、工程扩展与验收边界。
