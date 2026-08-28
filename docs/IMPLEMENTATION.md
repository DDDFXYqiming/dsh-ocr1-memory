# 实现说明（Implementation & Reproduction Status）

> 最后更新：2026-08-28。本文回答两个问题：**这个插件实现了什么、怎么实现的**，以及**对 DeepSeek-OCR（OCR1）与 OCR-Memory 论文的复现程度**。配套文档：[STATUS](STATUS.md)（状态）· [BENCHMARK](BENCHMARK.md)（R1–R6 对比）· [EXPLORATION](EXPLORATION.md)（探索实测记录）· [TEST_SPEC](TEST_SPEC.md) / [TEST_REPORT](TEST_REPORT.md)（测试）。

## 1. 系统总览

光学记忆系统：**文本 → SoM 编号图像存储 → 按年龄降分辨率（vivid/normal/fuzzy）→ 光学定位器选段 → 返回原始 verbatim**。

| 层 | 文件 | 职责 |
|---|---|---|
| 核心引擎 | `lib/core.js` | 分段（空行分隔）、SoM 渲染调度、tier 衰减、检索召回、光学定位器、渲染缓存、并发安全 |
| 分层治理 | `lib/memory-system.js` + `lib/governance*.js` | L1 索引 / L2 facts / L3 sops + 光学层（SoM 图、transcript、embedding、active recall） |
| 工具注册 | `lib/index.js` | 11 个 `ocr1_mem_*` DSH 工具 |
| 服务生命周期 | `lib/ocr-server.js` | llama-server 自动拉起（node spawn detached，Windows 原生） |
| SoM 渲染 | `scripts/render_memory.py` | 1024²/512² 方形图、红色编号框 + 36pt 高对比标签、CJK 字体 |
| 训练链 | `scripts/prepare_hotpotqa_locator.py` / `train_locator_unsloth.py` / `eval_locator.py` / `verify_collator_alignment.py` | HotpotQA SoM 数据 → LoRA 训练 → 评估 → 对齐自测 |
| 部署 | `scripts/ensure-ocr-server.mjs` / `start-ocr-server.ps1` / `lib/ocr-server.js` | combined 服务（`--embeddings --pooling mean`）一键确保在线 |

## 2. 光学定位器（Locate-and-Transcribe）：完整实现

### 2.1 JS 检索管线（`lib/core.js`）

- `parseBinaryRelevance`：从生成 token 流严格解析 K 位 0/1；有 logprobs 时按论文校准式 `p(1)=exp(z1)/(exp(z0)+exp(z1))` 计算概率；不接受自由文本（宁报错不猜测）。
- `selectRelevanceIndices`：论文 **Appendix A** 规则——阈值优先（tau=0.4），全部低于阈值才用 Top-K 保底；`alwaysUnionTopK=true` 可切换论文 Eq.12 字面行为。
- `createOcrLocatorHttpClient`：OpenAI 兼容 POST，请求形状与训练**逐字一致**：图在前 + text 前导 `\n` + **GBNF grammar 硬约束**（`d ::= "0" | "1"` 显式展开 K 位空格分隔，llama.cpp 侧等价于训练时的严格语法解码）+ temperature 0 + logprobs。
- `retrieve` 光学优先路径：`opticalLocatorEnabled` 时对所有 SoM 图做列表定位 → 按段索引取回**原始 verbatim**（确定性 Fetch，不做生成式复述）；`locatorStrict: true` 时定位失败直接报错，绝不回退文本打分。

### 2.2 训练链（HotpotQA，WSL2 ROCm）

- 数据：`data/hotpotqa-300`（train，seed=7）与 `data/hotpotqa-30`（eval，seed=42），**ID 零重叠**；每样本 10 段 SoM（2 正/8 负），1024² 全局 + 640² crops。
- 模型：`unsloth/DeepSeek-OCR` 4-bit QLoRA，q/k/v/o r16/α32 dropout 0.05，frozen encoder；输入严格按官方 `DeepseekOCRProcessor`：`[(patches, global)]` 二元组 + `<image>` id + `images_seq_mask`。
- 监督：只监督 target 区间内 0/1 单 token（id 18/19）；`tokenizer.encode(f"\n{prompt}")` 的 `\n` 计入长度；EOS 不监督；w+=4/w-=1 类别平衡；生成遵循 `digit space ...` 语法。
- 关键修复（2026-08-28 上午）：**监督错位 bug**（prompt 数字当标签）→ 对齐自测 6/6；images 结构定案。
- 结果：单样本过拟合 F1=1.0；**300×3 LoRA mean F1=0.375 vs base 0.139（≈2.7×）**。

### 2.3 部署链（LoRA → GGUF → llama-server）

1. `convert_lora_to_gguf.py`：adapter → `locator-lora.gguf`（96 张量 / 7.9MB）；`--base` 必须本地目录。
2. **合并路线（发布形态）**：transformers `merge_and_unload` → 清理非持久 buffer（`position_ids`）→ 补齐配置（`preprocessor_config.json`、remote code）→ `convert_hf_to_gguf.py` 两遍（主模型 + mmproj）。
3. 产物：`deepseek-ocr-locator-q8_0.gguf`（3.12GB，**字节数与官方 Q8_0 完全一致** 3,126,139,712）+ `mmproj-locator-q8_0.gguf`（461MB）。
4. 运行时：**Windows 原生** llama-server（combined，18080）或 WSL2 Linux 构建纯 CPU；`-ngl 0` 不占独显。
5. 验证（2026-08-28）：
   - HotpotQA 6 条未见样本：**mean F1=0.333**（训练侧 0.375 → 部署保留 ~89%；base 同语法 0.139）。
   - 10 段真实记忆定位：输出 `0 0 1 1 0 0 0 0 0 0`，**选中段 [3,4]，段 3 = 目标证据**，retrieve 回读 verbatim——**Locate-and-Transcribe 完整闭环**。
   - `npm test` **57/57**（含真实 OCR + embeddings）。

## 3. 对论文的复现程度（逐项对照）

### 3.1 DeepSeek-OCR（OCR1, arXiv:2510.18234）

| 论文概念 | 本插件 | 程度 |
|---|---|---|
| 长文本 → 光学 2D 映射 | 段落自动分段 → SoM 方形图 | ✅ 工程近似 |
| visual tokens 承载信息 | 分辨率模式 vivid 1280 / normal 1024 / fuzzy 640 + 接口级真实视觉 token 数 | ✅ 工程近似 |
| DeepEncoder 内部压缩 | llama.cpp OCR/embeddings 接口读回 | ❌ 未复刻（公开接口无法取内部张量；transformers 可加载 DeepEncoder 权重，训练链即用） |
| 官方 1280 维视觉 embedding | 真实存储（`visualMemory.embedding`），默认不作为检索主信号（实测区分度不足，诚实标注） | ✅ 接口级 |

### 3.2 OCR-Memory（方法蓝本, arXiv:2604.26622）

| 论文概念 | 本插件 | 程度 |
|---|---|---|
| SoM 编号分段 | 1024²/512² + 红色编号框 + 标签 | ✅ 完整实现 |
| Locate：模型输出 K 位 0/1 标签 | **LoRA 微调 DeepSeek-OCR + 严格语法解码 + GBNF 部署**（不再是文本打分） | ✅ 完整实现（2026-08-28 部署闭环） |
| Transcribe：确定性取回原文 | 按段索引返回原始 verbatim，零生成 | ✅ 完整实现 |
| age-aware 多分辨率 | 按 createdAt 衰减 vivid→normal→fuzzy（强制重渲染，旧 OCR 证据失效） | ✅ 完整实现 |
| active recall | 命中低清记忆 → 恢复高清 + 衰减豁免期 | ✅ 完整实现 |
| 阈值 tau + Top-K | tau=0.4 + 无命中时 Top-5 保底（附录 A；Eq.12 可切换） | ✅ 完整实现 |

### 3.3 未复刻 / 明确不做

- DeepEncoder 内部压缩管线与逐层 visual token 数（需 NVIDIA/vLLM 或 transformers 钩子）。
- 论文主表级规模复现：本机训练 300 条；论文用更大 HotpotQA + Mind2Web/AppWorld/RULER 评测。
- 多模态 embedding 官方 DeepEncoder 输出（AMD 环境无 vLLM/NVIDIA）。

## 4. 部署与运维（2026-08-28 实证）

- **Windows 原生**：`node scripts/ensure-ocr-server.mjs 18080`（combined 模式自动带 `--embeddings --pooling mean`）；Q8_0 merged 服务 10 段定位与 WSL 输出逐位一致。
- **已知坑**：
  - WorkBuddy 沙箱会终止其子进程中的 llama-server（表现为 0xC0000374）——计划任务 / DSH 环境（node spawn detached）正常，不要在 WorkBuddy 内起服务。
  - **Q4_K_M 基座（含 `--lora`）定位效果不可用**（无 LoRA 全 1 退化、Q4+LoRA 选错段）——发布形态必须是 Q8_0 merged。
  - 本机内存 17.8GB，同时只宜运行一个推理服务。
- 服务：18080 = Windows 原生 Q8_0 merged；重启后手动 `node scripts/ensure-ocr-server.mjs 18080`（或配置 `autoStartOcrServer` + 自定义模型目录）。

## 5. 文档导航

- [STATUS.md](STATUS.md) — 当前状态总览（测试、服务、差距）
- [BENCHMARK.md](BENCHMARK.md) — dsh-ocr1-memory vs dsh-memory R1–R6 对比
- [EXPLORATION.md](EXPLORATION.md) — 论文阅读与实测探索记录
- [TEST_SPEC.md](TEST_SPEC.md) / [TEST_REPORT.md](TEST_REPORT.md) — 测试规范与报告
- 论文原文：`docs/papers/`（2510.18234 / 2604.26622，不入库）
- [README.md](../README.md) / [README.en.md](../README.en.md) — 快速上手
