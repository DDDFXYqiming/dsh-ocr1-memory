简体中文 | [English](README.en.md)

# @dsh-external/dsh-ocr1-memory

基于 **DeepSeek-OCR: Contexts Optical Compression**（arXiv:2510.18234）思想实现的 DSH 光学记忆系统。

记忆不再只存文本——它被**渲染成图像（SoM 编号分段）并保留下来**；按年龄把旧记忆**降分辨率（越久远越模糊）**；检索命中低清记忆后通过 **active recall 恢复高清**；最终返回**原始 verbatim 片段**（Locate-and-Transcribe），避免生成式幻觉。

## 能力

| 工具 | 说明 |
|---|---|
| `ocr1_mem_status` | 状态：存储目录 / OCR 后端 / 条目数 / 渲染依赖 / 层级 |
| `ocr1_mem_store` | 文本 → 自动分段 → 渲染 SoM 图像 → 存入记忆库 |
| `ocr1_mem_update` | 更新已有记忆，替换为新内容并重置为 vivid（冲突消解） |
| `ocr1_mem_retrieve` | 按查询检索，OCR 读回图像 + 分段召回；命中低清记忆自动 active recall |
| `ocr1_mem_list` | 列出记忆条目（id / 来源 / 段数 / 层级 / 命中数） |
| `ocr1_mem_metrics` | 查看压缩比指标：文本 token 数 / 视觉 token 数 / 实测 prompt_tokens |
| `ocr1_mem_calibrate` | 校准 OCR 文本基线 prompt_tokens，用于更准确的视觉 token 估算 |
| `ocr1_mem_forget` | 按 id 删除记忆 |
| `ocr1_mem_render_test` | 渲染管线自测 |
| `ocr1_mem_embed_test` | 视觉 embedding 自测：返回真实 1280 维 DeepSeek-OCR embedding 与直接视觉 token 数 |

## 设计（对应 OCR1 论文）

| OCR1 概念 | 本插件实现 |
|---|---|
| 长文本 → 光学 2D 映射 | 文本按段落自动分段，渲染为方形 SoM 图像（1024²/512²，红色编号框 + 36pt 高对比标签） |
| visual tokens 承载信息 | 分辨率模式对应 OCR1 官方设计：`vivid 1280(≈400) → normal 1024(≈256) → fuzzy 640(≈100)`；会记录接口级真实视觉 token 数（marker-only 请求实测） |
| 记忆随时间模糊 | 按 `createdAt` 年龄衰减，旧记忆降到低分辨率（并强制重渲染，旧 OCR 证据失效） |
| 人类记忆的 vivid-to-fuzzy | 越旧越低清，但保留语义 gist |
| 记忆刷新 | 命中低清记忆 → active recall 恢复高清，并在一段时间内豁免再衰减 |
| Locate-and-Transcribe（本方案） | **光学定位器（OCR-Memory 论文核心）**：用 DeepSeek-OCR + LoRA 微调，对每张 SoM 图输出 K 位 0/1 相关性标签（sigmoid logits），按阈值 0.4 + Top-5 保底选择段；严格模式不接受自由文本输出，宁可报错也不回退到文本打分 |
| 确定性 Fetch | 定位只给出段索引；返回的永远是原始 verbatim 段落，不做生成式复述 |
| OCR 证据回溯 | 无定位器时退化为"文本打分 + OCR 读回证据"旧路径（非论文方案，标记为 legacy） |
| 视觉 embedding | 存储真实 DeepSeek-OCR 1280 维视觉向量（`visualMemory.embedding`）；**默认关闭**作为检索信号（实测未证明跨模态可靠，见下） |
| 渲染缓存 | AgentOCR 式哈希缓存（v2，square 几何 + sidecar 同步）；分辨率/内容变化自动失效 |

## 实现说明

完整的**架构分层、光学定位器训练/部署链、对 DeepSeek-OCR / OCR-Memory 论文的复现程度对照**见 **[docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md)**。配套文档：[STATUS](docs/STATUS.md)（状态）· [BENCHMARK](docs/BENCHMARK.md)（R1–R6 对比）· [EXPLORATION](docs/EXPLORATION.md)（探索实测）· [TEST_SPEC](docs/TEST_SPEC.md) / [TEST_REPORT](docs/TEST_REPORT.md)（测试）。

## 配置

在 profile 的 cordis.patch.yml 中覆盖（裸条目）：

```yaml
- id: dsh-ocr1-memory
  config:
    storeDir: ''                 # 默认 <home>/.dsh/ocr1-memory
    ocrBaseUrl: ''               # DeepSeek-OCR vLLM/OpenAI 兼容端点；留空则跳过 OCR 读回
    ocrApiKey: ''
    ocrModel: 'deepseek-ai/DeepSeek-OCR'
    pythonPath: 'python'
    renderScript: '<插件目录>/scripts/render_memory.py'
    requireOcr: false            # true 时 OCR 不可用会直接报错
    useMockRenderer: false       # true 时跳过 Python 渲染（仅测试）
    # 论文 Locate 定位器（需微调后的 DeepSeek-OCR+LoRA；未启用时不参与）
    opticalLocatorEnabled: false       # true 时 retrieve 走"光学定位器先选段"路径
    opticalLocatorBaseUrl: ''          # 默认回退 ocrBaseUrl（llama-server/vLLM 兼容端点）
    opticalLocatorApiKey: ''
    opticalLocatorModel: 'deepseek-ocr-memory'   # 微调后的模型名/合并后模型
    opticalLocatorTimeoutMs: 120000
    opticalLocatorThreshold: 0.4       # 论文 tau（p(1) 阈值）
    opticalLocatorTopK: 5              # 无命中时 Top-K 保底
    opticalLocatorMaxSegments: 20      # 单次 retrieve 全局段上限
    opticalLocatorAlwaysUnionTopK: false  # true=论文 Eq.12 字面；false=附录 A（默认，更接近论文意图）
    opticalLocatorStrict: true         # 定位输出非严格标签即报错，不回退文本打分
    autoStartOcrServer: false    # true 时插件加载后自动确保 llama-server 在线
    ocrServerPath: ''            # llama-server.exe 路径；留空用默认值
    ocrModelDir: ''              # DeepSeek-OCR GGUF 目录；留空用默认值
    ocrServerPort: 18080         # OCR 服务端口
    ocrEmbeddingBaseUrl: ''      # 通常与 ocrBaseUrl 相同（combined 模式）；留空自动回退到 ocrBaseUrl
    ocrEmbeddingApiKey: ''
    ocrEmbeddingModel: ''        # 留空则使用 ocrModel
    ocrEmbeddingTimeoutMs: 120000
    ocrEmbeddingEmptyPromptTokens: 1  # 空文本 embedding 的 prompt_tokens 基线
    ocrEmbeddingAutoStart: false       # 仅当 embedding 使用独立服务时才需要 true
    ocrEmbeddingPort: 18084            # 独立 embedding 服务端口（combined 模式不使用）
    ocrEmbeddingUbatchSize: 2048       # 必须 >= 单图视觉 token 数（默认 512 会拒大图）
    ocrEmbeddingServerPath: ''         # embeddings 用的 llama-server.exe 路径
    ocrEmbeddingModelDir: ''           # embeddings 用的 GGUF 目录
    ocrEmbeddingOnDemand: true         # 仅当 embedding 使用独立服务时生效；combined 模式下直接复用 18080
    ocrEmbeddingIdleTimeoutMs: 300000  # embedding 服务空闲多少毫秒后自动关闭
    ocrEmbeddingContextSize: 2048      # embedding 服务上下文（不需要长生成，2048 够用）
    sharedStore: false                 # true 时每次操作前重读 memories.json，支持多 Agent 共享同一 store
    embeddingRetrieval: false          # 1280 维视觉 embedding 相似度检索（默认关：实测未见跨模态可靠证据）
    ocrMaxEntriesPerRetrieve: 5        # 文本检索不足 topK 时，最多对多少条记忆做 OCR 读回（防止大库检索卡死）
```

## 安装

```bash
# 从 GitHub 安装（推荐）
dsh plugin --profile web add github:DDDFXYqiming/dsh-ocr1-memory

# headless（自测）
dsh plugin --profile headless add github:DDDFXYqiming/dsh-ocr1-memory
```

本地开发时也可直接使用仓库目录：

```bash
dsh plugin --profile web add <本目录>
```

运行时注入（免重启，开发用）：

```text
dev_inject_plugin <本目录>
```

## 接上真正的 DeepSeek-OCR

本插件把 OCR 后端抽象成 OpenAI 兼容的 `/v1/chat/completions`（vLLM 已支持 DeepSeek-OCR）。

```bash
# 例：用 vLLM 起 DeepSeek-OCR 服务
python -m vllm.entrypoints.openai.api_server \
  --model deepseek-ai/DeepSeek-OCR \
  --max-model-len 16384
```

然后把 `ocrBaseUrl` 配成 `http://127.0.0.1:8000/v1` 即可让检索真正走光学读回路径。

本机 AMD 路线（llama.cpp，**运行时只占 CPU/核显**）：

`llama-server` 优先使用 **CPU-only 构建**（`<models>\llama.cpp-cpu\llama-server.exe`，无 Vulkan 后端，不占独显），默认路径解析顺序：`OCR_SERVER_PATH` 环境变量 → CPU 构建（存在时）→ Vulkan 构建（兜底）。插件 `autoStartOcrServer`、`node scripts/ensure-ocr-server.mjs 18080`、`scripts/start-ocr-server.ps1` 三处均遵循该顺序。

```bash
# 一键启动/确保 DeepSeek-OCR llama-server 在线（自动选 CPU 版）
node scripts/ensure-ocr-server.mjs 18080
# 或手动
powershell -File scripts/start-ocr-server.ps1
# 显式指定 GPU/Vulkan 版（仅当你要临时提速，会占独显）
powershell -File scripts/start-ocr-server.ps1 -Server '<models>\llama.cpp\llama-server.exe'
```

默认后端地址：`http://127.0.0.1:18080/v1`，模型默认为 `deepseek-ocr-Q4_K_M.gguf`（`DeepSeek-OCR-Q8_0.gguf` 也可通过 `ocrModelDir`/脚本参数覆盖）。

> 实测（2026-08-28）：CPU 版（b10453）prefill ≈49 tok/s、decode ≈80 tok/s，足以支撑检索链路；`Get-Counter '\GPU Engine(*)'` 确认 llama-server 不进入任何 GPU 引擎，dGPU 空闲。

### 真实视觉 embedding（DeepSeek-OCR embeddings 端点）

llama.cpp 的 `/v1/embeddings` 支持多模态输入（`prompt_string` + `multimodal_data`）。当前构建的 `llama-server` 在 `--embeddings --pooling mean` 下**同时提供 `/v1/chat/completions` 和 `/v1/embeddings`**，所以只需要一个服务即可同时做 OCR 和视觉 embedding：

```bash
# 方式一：使用 start-ocr-server.ps1（已默认启用 combined 模式）
powershell -File scripts/start-ocr-server.ps1 -Port 18080

# 方式二：手动启动（需 -ub 大于单图视觉 token 数，默认 512 会拒绝大图）
# 用 CPU 版（不占独显）：<models>\llama.cpp-cpu\llama-server.exe
llama-server.exe --host 127.0.0.1 --port 18080 --embeddings --pooling mean \
  -m <model_dir>\deepseek-ocr-Q4_K_M.gguf \
  --mmproj <model_dir>\mmproj-deepseek-ocr-q8_0.gguf \
  --alias deepseek-ocr -c 8192 -np 1 -n 1024 -b 2048 -ub 2048
```

然后把 `ocrEmbeddingBaseUrl` 配成与 `ocrBaseUrl` 相同的 `http://127.0.0.1:18080/v1`（不配置时也会自动回退到 `ocrBaseUrl`）。插件会为每条记忆存储 **1280 维真实视觉 embedding**，并报告“直接视觉 token 数”（仅用 media marker 请求，`prompt_tokens - 空文本基线`）。

## 与 DeepSeek OCR1 论文的差距

当前实现是 **OCR1 思想的工程近似**，不是论文内部机制的完整复刻：

1. **DeepEncoder 内部压缩未复刻**
   - 论文：DeepEncoder 把文档图像真正压缩成少量 visual tokens，再交给 DeepSeek-3B 解码。
   - 当前：使用 llama.cpp 的 OCR/embeddings 接口做光学读回和视觉向量存储；视觉 token 数来自接口统计，不是 DeepEncoder 内部张量输出。

2. **Locate-and-Transcribe 现在是论文路线**
   - OCR-Memory：模型直接输出 K 位 0/1 相关性标签（Locate），再确定性取回原文（Transcribe）。
   - 本仓库已实现：
     - 纯 JS 端：`parseBinaryRelevance`（从 logprobs 读 0/1 token 概率）→ `selectRelevanceIndices`（tau=0.4 + Top-K 保底）→ `createOcrLocatorHttpClient`（OpenAI 兼容 POST，请求严格 K 位标签）；
     - `retrieve` 在配置 `opticalLocatorEnabled` 时走**光学优先**路径：先对所有 SoM 图做列表定位，再按段索引取回原始 verbatim（不经过文本打分）；
     - 训练侧：`scripts/prepare_hotpotqa_locator.py`（HotpotQA distractor → 1024² SoM 渲染 + 0/1 标签 JSONL）+ `scripts/train_locator_unsloth.py`（DeepSeek-OCR + q/k/v/o LoRA r16/α32/dropout0.05，frozen encoder，加权 BCE，30%1024²/70%512² 课程；输入管线复用 vLLM 官方 `DeepseekOCRProcessor`：`input_ids/<image>+pixel_values(1024²全局+640² crops)+images_seq_mask`，监督位置=0/1 单 token(18/19)）；
     - 训练允许占用独显（RX 7800 XT/ROCm 已验证模型加载与 LoRA attach）；**运行时（llama-server OCR/embedding）默认 CPU-only 构建，不占独显**；
     - **部署闭环已完成（2026-08-28）**：LoRA → 合并基座 → Q8_0 merged GGUF（3.12GB，与官方 Q8_0 字节一致）→ Windows 原生 llama-server 18080 → DSH 检索真实选段 + verbatim 回读（10 段 SoM 命中目标段；HotpotQA 未见样本 mean F1=0.333，部署保留训练效果 ~89%）。完整链路见 [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md)；
     - 未启用定位器时保留旧"文本打分 + OCR 证据"路径，并明确标记为 legacy（`locatorStrict: true` 时宁报错不回落）。

3. **视觉 embedding 默认关闭（诚实标注）**
   - 本机实测 `--pooling mean` 的 1280 维向量跨模态检索区分度不足（query↔真命中与 query↔干扰项余弦差距很小，见本仓库 `docs/EXPLORATION.md` 第 7 节），因此 `embeddingRetrieval` 默认 `false`；
   - `visualMemory.embedding` 仍存储真实 1280 维向量，但仅当显式开启时作为检索信号，不再默认用。

4. **视觉 token 数是接口级直接测量**
   - 通过 embeddings 端点 marker-only 请求得到 `visualTokensDirect`；
   - 不是 DeepEncoder 内部逐层显式输出。

## 当前运行服务与后续推进条件

- 当前实际需要的服务：
  - `18080`：DeepSeek-OCR combined 服务，同时提供 `/v1/chat/completions`（OCR 读回）和 `/v1/embeddings`（1280 维视觉 embedding / embedding 检索）。
- 不再需要独立的 `18084`；WorkBuddy 时代验证用的 `18081/18082` 计划任务服务已停（定义保留可重注册）。
- 已验证的推进边界：
  - **LoRA 微调已在本机实跑并量化验证**：WSL2 `/root/ocr1-train-env`（torch 2.11.0+rocm7.2 + transformers 4.57.2 + unsloth）加载 `unsloth/DeepSeek-OCR`（4-bit QLoRA），q/k/v/o r16/α32 adapter 落盘。独立 12 条 HotpotQA 评估：base exact 0/12、mean F1=0.139；300 条×3 epochs LoRA exact 1/12、mean F1=0.375（约 2.7×）；单样本过拟合达到 exact 1/1、F1=1.0。输入严格按官方格式：`images=[(patches, global_view)]` + `<image>` id128815 + `images_seq_mask`，监督=target 区间内 0/1 单 token(id18/19)。关键修复：`\n` 计入 prompt 长度、EOS 不监督、生成遵循 `digit space ...` 语法、w+=4 类别平衡、正确梯度累积；`scripts/verify_collator_alignment.py` 固化对齐自测。
  - 无微调让 DeepSeek-OCR 直接输出 SoM 编号：llama.cpp 后端不可靠（输出无关文本），实测确认，**论文原版 Locate 必须经过 LoRA 训练**。
  - DeepEncoder 内部压缩管线 / 内部逐层 visual token 数：llama.cpp 公开接口无法获取；transformers 路线可直接加载 DeepEncoder（本仓库训练脚本即用 AutoModel 全模型加载）。
- 后续可推进条件：
  - **训练 Locate LoRA**：用 `scripts/prepare_hotpotqa_locator.py` 生成数据集 → `scripts/train_locator_unsloth.py` 训练 → 合并/部署到 llama-server 或 vLLM → 配置 `opticalLocatorEnabled: true` 即全程论文路线。
  - DeepEncoder 内部逐层输出 / 官方多模态 embedding：需要 NVIDIA/vLLM 或直接用 transformers 加载官方权重做逐层钩子（训练脚本已基于该路线）。

## 开发与测试

```bash
npm run build        # node --check
npm test             # 全部测试（含 locator/render-geometry 新增项；真实 OCR/embedding 若后端在线则跳过与否取决于运行）
npm run test:smoke   # 本地端到端冒烟（真实 Python 渲染 + mock OCR）
node scripts/compare-memory.mjs  # 对比 dsh-ocr1-memory vs dsh-memory（隔离临时环境）
dsh --profile headless --dump-config   # 检查插件层已装配
```

## 测试与对比结果

- `npm test`：**57/57 通过**（2026-08-28，含定位器 L1–L8 与渲染几何 RG1–RG2；真实 OCR/embedding 项在 Windows 原生 18080 服务上实测通过）。
- Robustness：多 Agent 共享 store、图像缺失/缓存损坏恢复、超长输入边界均通过。
- 对比基准（`scripts/compare-memory.mjs`，隔离 headless + 官方原装 DSH）：
  - dsh-ocr1-memory：R1–R6 全部 PASS。
  - dsh-memory：本次 R1–R6 全部 PASS；但 R5 此前手动验证曾 FAIL（`memory_archive` 后仍可被 `memory_read` 读到），行为不稳定。
  - 结论：dsh-ocr1-memory 未出现落后于 dsh-memory 的情况。

## Roadmap

- [x] OCR-Memory 光学定位器管线（`parseBinaryRelevance` / `selectRelevanceIndices` / `createOcrLocatorHttpClient` / 光学优先 retrieve；配置 `opticalLocatorEnabled`）
- [x] HotpotQA locator 训练数据集脚本（`scripts/prepare_hotpotqa_locator.py`）
- [x] DeepSeek-OCR+LoRA 训练/eval（`train_locator_unsloth.py` / `eval_locator.py` / `verify_collator_alignment.py`；RX 7800 XT ROCm 实测 base F1 0.139 → LoRA 0.375，单样本 F1 1.0）
- [x] AgentOCR 式 segment optical caching（哈希分段缓存，降低渲染成本；已实现 `.render-cache` 复用）
- [x] 压缩比指标与 OCR 文本基线校准（`ocr1_mem_metrics` / `ocr1_mem_calibrate`）
- [x] 显式记忆更新（`ocr1_mem_update`，冲突消解）
- [x] 自动确保 OCR 服务在线（`autoStartOcrServer`）
- [x] 对比 dsh-memory 的隔离基准（R1–R6 已用修正后脚本完整重跑；dsh-ocr1-memory 全部 PASS）
- [x] 真实 DeepSeek-OCR 视觉 embedding 存储（1280 维，`visualMemory.embedding`；默认关闭检索）
- [x] 直接视觉 token 测量（embeddings 端点 marker-only 请求，`visualMemory.visualTokensDirect`）
- [x] 多 Agent 共享 store（`sharedStore` + reload + 原子保存）
- [x] 图像缺失 / 渲染缓存损坏自动恢复
- [x] 超长输入边界测试
- [x] LoRA 训练后把 adpater 合并回 DeepSeek-OCR 并部署到 llama-server/vLLM（全链路端到端定位验证；**2026-08-28 完成**：LoRA → Q8_0 merged GGUF → Windows 原生 llama-server 18080 → DSH 定位器真实选段，10 段 SoM 定位命中目标段，HotpotQA 未见样本 mean F1=0.333）
- [ ] 记忆命中热度驱动的动态衰减策略
- [ ] 自动注入 `/context` 让 Agent 每轮看到记忆摘要

## 相关参考

- DeepSeek-OCR（OCR1）：<https://arxiv.org/abs/2510.18234> · <https://github.com/deepseek-ai/DeepSeek-OCR>
- OCR-Memory（方法蓝本，未开源）：<https://arxiv.org/abs/2604.26622>
- AgentOCR（工程参考，已开源）：<https://github.com/langfengQ/AgentOCR>
