简体中文 | [English](../docs_en/IMPLEMENTATION.md)

# 实现说明（Implementation & Reproduction Status）

本文说明插件的架构、关键数据流、可选配置，以及对 DeepSeek-OCR（OCR1）和 OCR-Memory 方法的复现范围。部署实验与平台相关记录见 [DEPLOYMENT.md](DEPLOYMENT.md)，研究过程见 [EXPLORATION.md](EXPLORATION.md)。

## 1. 架构

| 层 | 代码 | 职责 |
|---|---|---|
| 光学记忆引擎 | `lib/core.js` | 分段、SoM 渲染调度、层级衰减、检索、定位器、缓存与并发保存 |
| DSH 入口 | `lib/index.js` | 配置解析、OCR/embedding 客户端、服务生命周期和 `ocr1_mem_*` 工具注册 |
| context 快照 | `lib/context.js` | 从持久化 manifest 同步生成限长的 prompt context，不调用模型 |
| 分层治理适配器 | `lib/memory-system.js`、`lib/governance.js` | L1/L2/L3 记忆、命名空间、证据与溯源、可选光学表示 |
| 渲染器 | `scripts/render_memory.py` | 方形 SoM 图像、编号标签、CJK 字体与长文本布局 |
| 训练辅助 | `scripts/prepare_hotpotqa_locator.py`、`train_locator_unsloth.py`、`eval_locator.py` | 定位数据、LoRA 训练、评估和 collator 对齐检查 |

## 2. 数据流

### 2.1 写入

1. 输入文本按空行和长度切分为有序段落，段落 id 从 1 开始。
2. 渲染器把段落画到带编号的方形 SoM 图像中；原始段落同时写入 `memories.json`，作为确定性 Fetch 的唯一文本来源。
3. 图像按内容、分辨率和渲染版本生成缓存键。相同内容可复用缓存，内容或 tier 变化会使 OCR、定位器和 embedding 证据失效。
4. 可配置 OCR 读回和多模态 embedding。后端不可用时，宽松配置保留文本记忆；`requireOcr` 可改为严格报错。

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

### 2.3 检索

无定位器时，插件使用文本重叠、OCR 读回证据和可选 embedding 的 legacy 路径。配置 `opticalLocatorEnabled` 后，流程变为：

1. 对每条当前 SoM 图像请求 K 位 `0/1` 相关性标签；
2. `parseBinaryRelevance` 严格解析标签及 logprobs；
3. `selectRelevanceIndices` 使用阈值（默认 `0.4`），无命中时使用 Top-K 保底；
4. 只按段索引从 `memories.json` Fetch 原文，返回 verbatim，不生成复述。

定位请求通过 OpenAI 兼容接口发送，图像位于消息前部，带训练一致的换行前缀、温度 0、logprobs 和 llama.cpp GBNF 语法约束。`opticalLocatorStrict` 开启时，格式错误直接失败，不回退到文本打分。

### 2.4 每轮 context 快照

`autoInjectContext` 开启后，入口通过 DSH `systemPrompt.context()` 注册名为 `ocr1-memory:context` 的动态贡献。provider 每次 prompt assemble 同步读取 manifest，按命中数和最近访问时间排序，压缩段落文本，并受 `contextMaxEntries` 与 `contextMaxChars` 限制。

该 provider 只读磁盘，不做 OCR、embedding、检索或网络请求；manifest 损坏时返回空字符串，不阻断 prompt 组装。由于快照会进入模型上下文和会话记录，默认关闭，启用前应确认记忆内容适合暴露给 Agent。

## 3. 配置要点

| 选项 | 默认 | 说明 |
|---|---:|---|
| `ocrBaseUrl` | 空 | OpenAI 兼容的 `/v1/chat/completions` 地址 |
| `requireOcr` | `false` | OCR 不可用时是否直接失败 |
| `opticalLocatorEnabled` | `false` | 是否走训练后的光学定位路径 |
| `opticalLocatorThreshold` | `0.4` | `p(1)` 选择阈值 |
| `opticalLocatorTopK` | `5` | 无阈值命中时的保底数量 |
| `opticalLocatorStrict` | `true` | 定位标签格式错误时是否拒绝回退 |
| `dynamicDecayEnabled` | `false` | 是否启用近期命中热度衰减 |
| `decayFrequencyWindowMs` | 7 天 | 命中频率的平滑窗口 |
| `decayRecencyHalfLifeMs` | 14 天 | 最近一次访问的权重半衰期 |
| `decayHitWeight` | `1` | 热度对倍率的权重 |
| `decayMaxMultiplier` | `4` | 有效年龄倍率上限 |
| `autoInjectContext` | `false` | 是否每轮注入限长摘要 |
| `contextMaxEntries` | `5` | 摘要最多包含的记忆条目 |
| `contextMaxChars` | `4000` | 摘要最大字符数 |
| `sharedStore` | `false` | 是否每次操作前重载 manifest |
| `embeddingRetrieval` | `false` | 是否启用视觉 embedding 检索信号 |

其余渲染、embedding 服务和自动启动选项可直接查看 `lib/index.js` 的 `Config`。

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
| 每轮记忆 context | DSH `systemPrompt.context()` 限长快照 | 已实现（默认关闭） |

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
- [TEST_SPEC.md](TEST_SPEC.md) / [TEST_REPORT.md](TEST_REPORT.md)：测试规范与结果。
