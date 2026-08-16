# Changelog

## 0.1.0 (current)

### Added
- 真实 DeepSeek-OCR 多模态 embedding 支持
  - `measureImageEmbedding` / `measureTextEmbedding` / `createEmbeddingHttpClient` / `measureEmptyPromptTokens`
  - 通过 llama.cpp `/v1/embeddings` 的 `prompt_string` + `multimodal_data` 请求真实 1280 维视觉 embedding
  - `visualMemory` 新增 `embeddingDim` / `embeddingSource` / `embeddingPromptTokens` / `visualTokensDirect` / `embeddingError`
  - 新增 `ocr1_mem_embed_test` 工具
  - `lib/ocr-server.js` 支持启动 `--embeddings --pooling mean -ub 2048` 专用服务
- 视觉 embedding 相似度检索
  - `measureTextEmbedding` 用于把查询文本嵌入到同一向量空间
  - `embeddingRetrieval` 配置（默认 true）：检索时先用 query embedding 与记忆 visual embedding 的余弦相似度作为主信号排序，再在命中的记忆内做文本分段定位
  - `retrieveSegmentsWithEmbeddings` 混合排序函数
- DSH 插件骨架：`@dsh-external/dsh-ocr1-memory`
- 核心记忆引擎 `lib/core.js`
  - 文本分段
  - SoM 编号
  - 年龄衰减（vivid/normal/fuzzy：1280/1024/640）
  - active recall
  - Locate-and-Transcribe
  - 渲染缓存
  - 并发渲染锁
  - 更新记忆 `update`
  - 相同 source 的 `store` 自动更新
  - optical memory 元数据：`visualMemory`（图像路径 + prompt_tokens + 视觉 token 数 + 64 维视觉 embedding）
  - 压缩比指标 `memoryMetrics`
  - OCR 文本基线校准 `measureTextOnlyPromptTokens`
  - 视觉 token 基线可配置 `ocrTextOnlyPromptTokens`
- Python 渲染脚本 `scripts/render_memory.py`（CJK 字体支持）
- DSH 工具
  - `ocr1_mem_status`
  - `ocr1_mem_store`
  - `ocr1_mem_update`
  - `ocr1_mem_retrieve`
  - `ocr1_mem_list`
  - `ocr1_mem_metrics`
  - `ocr1_mem_calibrate`
  - `ocr1_mem_forget`
  - `ocr1_mem_render_test`
- OCR 服务生命周期
  - `scripts/start-ocr-server.ps1`
  - `scripts/ensure-ocr-server.mjs`
  - `lib/ocr-server.js`
  - `autoStartOcrServer` 配置
- 对比基准
  - `scripts/compare-memory.mjs`
  - `docs/BENCHMARK.md`
- 多 Agent 共享 store 支持
  - `sharedStore` 配置：操作前 reload `memories.json`
  - 原子保存：唯一临时文件 + rename，并串行化同一 store 实例内的写入
- 图像缺失 / 渲染缓存损坏自动恢复
- 超长输入边界处理与测试
- 测试规范调研
  - `docs/TEST_SPEC.md`：MemoryAgentBench / LongMemEval / LoCoMo / AMB 映射到 R1–R6

### Changed
- 默认模型切换为 `deepseek-ocr-Q4_K_M.gguf` + `mmproj-deepseek-ocr-q8_0.gguf`，降低显存占用；`lib/ocr-server.js` 与 `scripts/start-ocr-server.ps1` 同步更新。
- 确认当前 llama.cpp 的 `--embeddings --pooling mean` 可同时提供 `/v1/chat/completions` 与 `/v1/embeddings`，因此 OCR 与视觉 embedding 合并为**单个 18080 服务**，不再需要常驻 18084。

### Fixed
- 检索打分污染：片段级得分不再被整条记忆聚合分抬高
- 并发 active recall 渲染竞争（EBUSY）
- OCR 服务自动拉起：直接 spawn `llama-server.exe`，避免 PowerShell spawn 不稳定
- CJK 字体渲染：使用微软雅黑/黑体
- DSH 工具输出 schema 严格性：`ocr1_mem_store` 补 `updated` 字段，`ocr1_mem_list` 只返回 schema 声明字段，避免 headless Agent 报 invalid output
- 并发保存冲突：唯一临时文件 + 串行化 save，避免 Windows 下 rename EPERM/ENOTEMPTY

### DSH 级对比（R1–R6）
- 用修正后的 `scripts/compare-memory.mjs` 完整重跑 R1–R6：
  - dsh-ocr1-memory 全部 PASS
  - dsh-memory 本次也全部 PASS；但 R5 此前手动验证曾 FAIL（`memory_archive` 后 `memory_read` 仍可读到），行为不稳定
- 手动验证 R5/R6 时 dsh-ocr1-memory 使用完整 OCR + embedding 配置

### Tests
- `npm test` 47/47 通过
- 核心单元测试 8
- 复杂隔离测试 T1–T24 24
- OCR HTTP / 渲染缓存 2
- Embedding 测试 E1–E5 5
- OCR server 生命周期 2
- Robustness 测试 M1–M6 6

### Docs
- `README.md`
- `docs/TEST_REPORT.md`
- `docs/EXPLORATION.md`
- `docs/BENCHMARK.md`
- `docs/STATUS.md`
- `CHANGELOG.md`
- 记录 SoM locate 实验限制、当前运行服务、后续可推进条件
