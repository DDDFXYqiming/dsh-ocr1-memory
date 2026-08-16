# 探索记录 / Exploration Log

本文件记录为实现 DeepSeek-OCR1 记忆插件过程中进行的联网搜索、技术选型和验证结论。

## 1. DeepSeek-OCR 论文

- 论文：DeepSeek-OCR: Contexts Optical Compression
- arXiv：https://arxiv.org/abs/2510.18234
- 核心：用 DeepEncoder 把文档图像压缩成少量 visual tokens，再用 DeepSeek-3B-MoE-A570M 解码。
- 官方分辨率模式：
  - Tiny：512×512 → 64 tokens
  - Small：640×640 → 100 tokens
  - Base：1024×1024 → 256 tokens
  - Large：1280×1280 → 400 tokens
  - Gundam：动态拼接

## 2. 记忆系统相关论文/实现

- OCR-Memory（ACL 2026）：明确以 DeepSeek-OCR 3B 为 backbone，SoM + Locate-and-Transcribe + age-aware multi-resolution + active recall。
  - https://arxiv.org/abs/2604.26622
  - 未找到官方开源代码。
- AgentOCR（ACL 2026 Oral）：光学自压缩 + segment optical caching，有开源代码，但 backbone 是 Qwen2.5-VL。
  - https://github.com/langfengQ/AgentOCR
- MemOCR（美团）：视觉记忆 agent，backbone 是 Qwen2.5-VL，属于思路相近而非 OCR1 直系实现。
- VTC-R1：光学 memory 用于长上下文推理，backbone 是 Glyph/Qwen3-VL，非 DeepSeek-OCR。

## 3. DeepSeek-OCR 本地部署

- vLLM 官方支持 DeepSeek-OCR，但本机为 AMD RX 7800 XT，无 NVIDIA CUDA，vLLM 官方路线不推荐。
- 社区 GGUF 来源：
  - Ollama：`ollama run deepseek-ocr`（需 v0.13.0+）
  - Hugging Face：
    - `ggml-org/DeepSeek-OCR-GGUF`（Q8_0，官方 llama.cpp 博客推荐）
    - `sabafallah/DeepSeek-OCR-GGUF`（Q4_K_M / Q8_0 / BF16）
    - `NexaAI/DeepSeek-OCR-GGUF`（Q4_K / Q5_K / Q6_K / Q8_0 等）
- 实测：
  - `ollama pull deepseek-ocr` 卡在 84%，速度降至 100KB/s，放弃。
  - 使用 aria2c 多线程从 `hf-mirror.com` 下载成功，速度可达数 MB/s。
  - `sabafallah` 的 Q4_K_M 在 llama.cpp CLI 中触发崩溃，可能属于 PR 分支转换；但 `llama-server` 下可稳定运行。
  - 当前使用 `sabafallah` 的 `deepseek-ocr-Q4_K_M.gguf` + `mmproj-deepseek-ocr-q8_0.gguf` 通过 `llama-server` 稳定运行。

## 4. llama.cpp / AMD 路线

- 下载：`llama-b10453-bin-win-vulkan-x64.zip` 与 `llama-b10453-bin-win-cpu-x64.zip`
- 路径：`<models>\llama.cpp\`、`<models>\llama.cpp-cpu\`
- 运行：
  - `llama-server` 监听 `127.0.0.1:18080`
  - 使用 `deepseek-ocr-Q4_K_M.gguf` + `mmproj-deepseek-ocr-q8_0.gguf`（更省显存）
- 关键参数：
  - 必须使用 `\nFree OCR.` 风格 prompt
  - 必须加 `repeat_penalty` 和 `no_repeat_ngram_size` 防止重复输出
- 注意：
  - `llama-mtmd-cli` 在 Vulkan 和 CPU 模式下均崩溃（0xC0000409），但 `llama-server` 可正常工作。
  - 这是本机实测现象，可能与 Windows/驱动/构建有关。

## 5. 本机环境

- GPU：AMD Radeon RX 7800 XT（16GB）+ Radeon 780M
- 无 NVIDIA CUDA
- Python 3.12 / Node 24 / bun 1.3
- Pillow 已安装，torch 未安装
- 模型文件：`<models>\deepseek-ocr-gguf\`

## 6. llama-server 运行注意事项

- 使用 `-c 8192` 启动更稳定，可容纳 1280×1280 图像产生的视觉 token。
- 插件已内置自动拉起：`lib/ocr-server.js` + `autoStartOcrServer` 配置。
- 自动拉起实现细节：直接 spawn `llama-server.exe`，不要走 PowerShell `-File`（实测 PowerShell spawn 在 detached + pipe 下不稳定）。
- 当前启动命令：
  ```
  llama-server.exe --host 127.0.0.1 --port 18080 \
    -m deepseek-ocr-Q4_K_M.gguf \
    --mmproj mmproj-deepseek-ocr-q8_0.gguf \
    --alias deepseek-ocr -c 8192 -n 1024
  ```

## 7. llama.cpp 多模态 embedding（真实视觉 embedding）

- 结论：llama.cpp `llama-server` 的 `/v1/embeddings` 支持图片输入，但请求格式不是 OpenAI 标准 `input` 字符串，而是：
  ```json
  { "input": [ { "prompt_string": "<media_marker>", "multimodal_data": ["<raw base64>"] } ] }
  ```
- `<media_marker>` 必须从 `GET /props` 的 `media_marker` 字段动态获取（每次启动随机）。
- `multimodal_data` 必须是**裸 base64**，不能是 `data:image/png;base64,...`（后者会报 `Failed to load image or audio file`）。
- 默认 `-ub`（physical batch size）为 512，1024×200 的 SoM 记忆图约 784 视觉 token，会报 `input too large`；需 `-ub 2048`。
- 实测：
  - 当前 llama.cpp 构建在 `--embeddings --pooling mean` 下**同时支持 `/v1/chat/completions` 和 `/v1/embeddings`**，因此 OCR 与视觉 embedding 可共用同一个 18080 服务；
  - marker-only 请求 `prompt_tokens=785`；
  - 空文本 `input:""` 的 `prompt_tokens=1`；
  - 直接视觉 token = 784，embedding 维度 = 1280；
  - 服务端已按欧氏范数归一化（`--embd-normalize 2` 默认）。
- 插件已集成：`measureImageEmbedding` / `createEmbeddingHttpClient`，并在 `visualMemory` 中持久化 `embedding`、`embeddingDim`、`visualTokensDirect`。

## 8. 关键结论

- 插件核心已能真实调用 DeepSeek-OCR 读图。
- 隔离临时环境测试通过，`npm test` 已固化 47 项测试。
- 新增 `ocr1_mem_metrics` 工具：按官方分辨率模式估算文本 token / 视觉 token 压缩比，并记录真实 OCR 请求的 `usage.prompt_tokens` 和近似视觉 token 数。
- 新增 `ocr1_mem_update` 工具：支持显式更新记忆，用于冲突消解/最新值覆盖。
- 新增 `scripts/start-ocr-server.ps1`、`scripts/ensure-ocr-server.mjs`、`lib/ocr-server.js`。
- 插件新增 `autoStartOcrServer` 配置：启用后插件加载时自动确保 llama-server 在线。
- 对比基准（`docs/BENCHMARK.md`、`scripts/compare-memory.mjs`）：R1–R6 已用修正后脚本完整重跑；dsh-ocr1-memory 全部通过；dsh-memory 本次也全部通过，但 R5 此前手动验证曾 FAIL（归档后仍可读到），行为不稳定；R4 现在有显式 update 能力。
- DSH 级 R1–R6 已在隔离 headless 环境完成完整对比（不 kill 进程，后台运行）：dsh-ocr1-memory 全部 PASS。
- 已实现 robustness 增强：多 Agent 共享 store（`sharedStore`）、图像缺失/缓存损坏自动恢复、超长输入边界测试。
- 现已通过 llama.cpp `/v1/embeddings` 的 marker-only 请求存储**真实 1280 维 DeepSeek-OCR 视觉 embedding**，并测量直接视觉 token 数（marker-only `prompt_tokens` − 空文本基线）。
- 已将视觉 embedding 相似度作为**主检索信号**：`measureTextEmbedding` 嵌入查询，`retrieveSegmentsWithEmbeddings` 先按余弦相似度排序记忆，再在命中记忆内做文本分段定位。
- 已调研通用 agent 记忆测试规范（MemoryAgentBench / LongMemEval / LoCoMo / AMB），并整理成 `docs/TEST_SPEC.md`；R1–R6 与这些规范一一映射。
- 尝试“无微调让 DeepSeek-OCR 直接输出 SoM 编号”的实验：当前 llama.cpp 后端在自定义 locate prompt 下输出不可靠（返回无关文本而非编号），因此在不做 LoRA 的前提下，论文原版 Locate（模型输出编号）不可推进。
- 距离“完全复现 OCR1 论文效果”仍缺：
  - DeepEncoder 内部逐层输出的纯 visual token 数量（当前使用 llama.cpp token 统计，属于接口级直接测量）
  - LoRA 微调 DeepSeek-OCR 做 SoM 编号检索（按目标要求不做）
