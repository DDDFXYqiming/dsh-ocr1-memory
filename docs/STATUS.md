# dsh-ocr1-memory 状态总览

> 最后更新：2026-08-28 深夜（DSH 接手收尾）
> 文档导航：[实现说明](IMPLEMENTATION.md) · [BENCHMARK](BENCHMARK.md) · [EXPLORATION](EXPLORATION.md) · [TEST_SPEC](TEST_SPEC.md) · [TEST_REPORT](TEST_REPORT.md) · [README](../README.md)

## 当前状态

| 项目 | 状态 |
|---|---|
| 插件目录 | `<repo_root>\dsh-plugins\dsh-ocr1-memory` |
| 测试数量 | `npm test` 57/57 通过 |
| 真实 OCR 后端 | llama-server `http://127.0.0.1:18080/v1`（**Windows 原生**，Q8_0 merged 定位器模型） |
| 真实 Embedding 后端 | 与 OCR 共用 `http://127.0.0.1:18080/v1`（combined `--embeddings --pooling mean`） |
| 模型 | Q8_0 merged（`deepseek-ocr-locator-q8_0.gguf` + `mmproj-locator-q8_0.gguf`，LoRA 已合并） |
| 光学定位器 | ✅ 已部署启用（`opticalLocatorEnabled: true`，headless profile）；Q8_0 merged 10 段定位命中目标段，输出与 WSL 验证逐位一致 |
| 自动拉起 | `lib/ocr-server.js` + `autoStartOcrServer` / `ocrEmbeddingAutoStart` 配置 |
| 对比基准 | `docs/BENCHMARK.md`、`scripts/compare-memory.mjs`（R1–R6 已用修正后脚本完整重跑） |

## 已实现功能

- `ocr1_mem_status`
- `ocr1_mem_store`
- `ocr1_mem_update`
- `ocr1_mem_retrieve`
- `ocr1_mem_list`
- `ocr1_mem_metrics`
- `ocr1_mem_calibrate`
- `ocr1_mem_forget`
- `ocr1_mem_render_test`
- `ocr1_mem_embed_test`
- 真实 DeepSeek-OCR 1280 维视觉 embedding 存储
- 视觉 embedding 相似度作为主检索信号（`embeddingRetrieval`）
- 直接视觉 token 数测量（marker-only embeddings 请求）
- SoM 分段渲染
- 年龄衰减（vivid/normal/fuzzy 对应 1280/1024/640）
- active recall
- Locate-and-Transcribe（返回原始 verbatim）
- 渲染缓存
- 并发安全
- OCR 文本基线校准
- 多 Agent 共享 store（`sharedStore` + 原子写入 + 操作前 reload）
- 图像缺失 / 渲染缓存损坏自动恢复
- 超长输入边界处理与测试
- **光学定位器部署闭环**（2026-08-28）：LoRA → GGUF → 合并基座 → Q8_0 merged → Windows 原生 llama-server（18080）→ DSH 检索真实选段 + verbatim 回读；10 段 SoM 图定位输出 `0 0 1 1 0 0 0 0 0 0`，选中段 [3,4]（段 3 为目标证据）

## 测试覆盖

- 核心单元测试：8
- 复杂隔离测试 T1–T24：24
- OCR HTTP / 渲染缓存 / server 生命周期：4
- Embedding 测试 E1–E5：5
- 定位器测试 L1–L8：8
- 渲染几何 RG1–RG2：2
- Robustness 测试 M1–M6：6
- 合计：57

## 对比结果（dsh-ocr1-memory vs dsh-memory）

| 任务 | 结果 |
|---|---|
| R1 准确检索 | 两者 PASS |
| R2 测试时学习 | 两者 PASS |
| R3 长程理解 | 两者 PASS |
| R4 冲突消解 | 两者 PASS |
| R5 选择性遗忘 | dsh-ocr1-memory PASS；dsh-memory 本次脚本 PASS，但此前手动验证曾 FAIL（归档后仍可读到），行为不稳定 |
| R6 跨会话持久化 | 两者 PASS |

## 已知差距（均不影响核心效果）

1. 视觉 token 数现为“直接测量”：通过 embeddings 端点只发 media marker（无可见文本）得到 `prompt_tokens`，再减空文本基线；比之前近似更接近 DeepEncoder 纯视觉 token 数，但仍依赖 llama.cpp 的 token 统计接口，不是论文 DeepEncoder 内部的逐层输出。
2. ~~LoRA 微调 DeepSeek-OCR 做 SoM 编号检索：按目标要求不需要做~~ → **已实现并部署**（2026-08-28）：300×3 LoRA（mean F1 0.375 vs base 0.139）→ Q8_0 merged GGUF（3.12GB，与官方 Q8_0 字节数一致）→ Windows 原生 llama-server 18080 → DSH 定位器真实选段。GGUF 部署保留训练效果 ~89%（HotpotQA 未见样本 mean F1 0.333）。
3. optical memory 已存储**真实 DeepSeek-OCR 1280 维视觉 embedding**（`visualMemory.embedding`，来源 `deepseek-ocr-embeddings`），并已作为主检索信号（`embeddingRetrieval`）；无 embeddings 后端时保留 64 维图像派生 embedding 作为降级。
4. DSH 级 R1–R6 已用修正后的 `scripts/compare-memory.mjs` 完整重跑；core 层 T18/T19 亦通过。

## 当前运行服务与后续推进条件

- 当前实际需要的服务：
  - `18080`：**Windows 原生** DeepSeek-OCR combined 服务（Q8_0 merged 定位器模型），同时提供 `/v1/chat/completions`（OCR 读回 + 光学定位）和 `/v1/embeddings`（1280 维视觉 embedding / embedding 检索）。
- 已知坑（2026-08-28 实证）：
  - **WorkBuddy 沙箱会终止其子进程中的 llama-server**（表现为 0xC0000374 堆损坏退出码）；计划任务 / DSH 环境（node spawn detached）正常。不要在 WorkBuddy 的 Bash/PowerShell 里启动 llama-server。
  - **Q4_K_M 基座（含 `--lora`）定位效果不可用**（无 LoRA 全 1 退化、Q4+LoRA 选错段）；发布形态必须是 Q8_0 merged。
  - 本机内存 17.8GB，同时只宜运行一个推理服务。
- 已验证的推进边界：
  - 无微调让 DeepSeek-OCR 直接输出 SoM 编号：当前 llama.cpp 后端不可靠（输出无关文本），因此论文原版 Locate 需要 LoRA 才能推进。→ **LoRA 路线已打通并部署**。
  - DeepEncoder 内部压缩管线 / 内部逐层 visual token 数：当前 llama.cpp 公开接口无法获取。
  - 多模态 embedding 依赖 llama.cpp 扩展；在 AMD 无 NVIDIA/vLLM 环境下无法切换到官方 DeepEncoder 输出。
- 后续可推进条件：
  - 规模化：当前 300 条训练已 F1=0.333（部署侧），按论文规模跑数千条 HotpotQA 差距会明显拉开。
  - 若具备 NVIDIA/vLLM 环境：可进一步对齐 DeepEncoder 内部压缩、内部 visual token 输出和官方多模态 embedding。

## 安全说明

- 本环境禁止 kill 进程操作，避免影响 DSH 自身服务。
- 所有测试均在隔离临时目录执行，不污染默认 store。
