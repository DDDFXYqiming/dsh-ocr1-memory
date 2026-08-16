# dsh-ocr1-memory 测试报告

> 目标：在隔离临时环境中持续测试与修复，直到插件稳定实现 DeepSeek-OCR1（Contexts Optical Compression）的记忆系统效果。
> 本文档持续更新，所有测试均使用隔离临时目录，不污染 `~/.dsh/ocr1-memory`。

## 测试环境

| 项目 | 值 |
|---|---|
| 插件目录 | `<Agent_Extensions>\dsh-plugins\dsh-ocr1-memory` |
| 真实 OCR 后端 | `http://127.0.0.1:18080/v1`（llama-server + DeepSeek-OCR Q4_K_M + mmproj q8_0） |
| 真实 Embedding 后端 | 与 OCR 共用 `http://127.0.0.1:18080/v1`（combined `--embeddings --pooling mean`） |
| 采样参数 | `temperature=0`、`repeat_penalty=1.2`、`no_repeat_ngram_size=30` |
| 渲染 | Python + Pillow + CJK 字体（微软雅黑/黑体） |
| 隔离方式 | 每个测试 `mkdtemp` 独立目录，测试结束自动删除 |

## 当前通过状态

| 套件 | 结果 |
|---|---|
| `npm test`（已固化） | 47/47 通过 |
| 核心单元测试 | 8/8 通过 |
| 复杂隔离测试（T1–T24） | 24/24 通过 |
| OCR HTTP / 渲染缓存测试 | 2/2 通过 |
| Embedding 测试（E1–E5） | 5/5 通过 |
| OCR server 生命周期测试 | 2/2 通过 |
| Robustness 测试（M1–M6） | 6/6 通过 |
| 真实 OCR / Embedding 隔离测试 | PASS（T6/T15/T16/T21/T23/T24/E4，依赖 llama-server） |

## 单元测试覆盖

- `splitSegments`：空行分段、连续 id、超长段落切分
- `scoreSegment`：命中、未命中、空文本
- `tierIndexFor`：vivid/normal/fuzzy 年龄边界
- store + retrieve：verbatim 返回、OCR 文本写入
- active recall：fuzzy → vivid
- OCR 驱动召回：原始文本未命中但 OCR 命中时仍召回
- OCR HTTP 客户端：OpenAI 兼容 `/v1/chat/completions` 集成
- 渲染缓存：相同分段集合 + 分辨率复用图像

## 复杂隔离测试覆盖

| ID | 场景 | 结果 |
|---|---|---|
| T1 | 时间旅行：fuzzy → 命中 → vivid | PASS |
| T2 | 30 条模糊记忆中只升级命中的 1 条 | PASS |
| T3 | 多主题记忆检索互不串扰 | PASS |
| T4 | 50 段大文本中准确命中目标段 | PASS（修复后） |
| T5 | 中文/英文/日文/Emoji/特殊符号 | PASS |
| T6 | 真实 DeepSeek-OCR 连续 3 次读图稳定 | PASS |
| T7 | OCR 后端不可用：严格模式报错/宽松模式降级 | PASS |
| T8 | 20 个并发 store 后 JSON 完整 | PASS |

## 已发现并修复的问题

### 1. 检索打分污染（T4 暴露）

**现象**：查询 `unique-key-37` 时，所有包含 `unique`/`key` 的无关片段被整条记忆的聚合分抬到 topK，目标段 37 被挤出。

**原因**：`retrieveSegments` 给每个字面命中片段使用了 `Math.max(segScore, est.score * 0.5)`，其中 `est.score` 是整条记忆的聚合分，导致泛化词片段集体虚高。

**修复**：
- 字面命中片段直接使用片段级得分 `segScore`；
- OCR 聚合分只用于“原始文本无命中时的 OCR 兜底召回”，不再污染普通片段得分。

**回归**：T4 通过，单元测试仍 9/9。

### 2. 分辨率层级未对齐 OCR1 官方模式

**修改**：`DEFAULT_TIERS` 从 `1024/768/512` 调整为：

```
vivid  1280 → 400 tokens（对应 OCR1 Large）
normal 1024 → 256 tokens（对应 OCR1 Base）
fuzzy  640  → 100 tokens（对应 OCR1 Small）
```

**原因**：更贴近 DeepSeek-OCR 论文中的原生分辨率模式。

## Embedding 测试覆盖

| ID | 场景 | 结果 |
|---|---|---|
| E1 | `measureImageEmbedding` 通过 media marker 请求，返回 embedding / 直接视觉 token 数 | PASS |
| E2 | 记忆 store 存储真实 multimodal embedding 与 `visualTokensDirect` | PASS |
| E3 | embedding 后端失败时降级为像素 embedding 并记录 `embeddingError` | PASS |
| E4 | 真实 DeepSeek-OCR embeddings 后端生成 1280 维视觉 embedding | PASS |
| E5 | 视觉 embedding 相似度作为主检索信号：embedding 更近的记忆排在前面 | PASS |

真实 E4 实测：`prompt_tokens=785`（marker-only），空文本基线 `prompt_tokens=1`，直接视觉 token=784，embedding 维度=1280。

## 真实 OCR 隔离测试记录

```
ISOLATED_REAL_TEST_PASS
storeDir=临时目录（已删除）

输入文本：
Orbit API 需要登录并携带 token。

OCR 回读（节选）：
"### 题目内容
**Orbit API 需要登录并携带 token。**
..."

检索结果：
[entryId=..., segmentId=1, score=1.00, tier=vivid]
content: "Orbit API 需要登录并携带 token。"
```

## 第二轮复杂隔离测试

| ID | 场景 | 结果 |
|---|---|---|
| T9 | 路径穿越安全：source 注入 `../`、绝对路径 | PASS |
| T10 | `memories.json` 损坏后安全重建为空库 | PASS |
| T11 | 500 轮 store/retrieve/forget 长稳 | PASS |
| T12 | 10 路并发 active recall 命中同一目标 | PASS（修复后） |
| T13 | 分辨率模式对齐 OCR1：1280/1024/640 | PASS |
| T14 | 压缩比指标：textTokens / visualTokens | PASS |
| T15 | 真实 OCR 记录 `usage.prompt_tokens` | PASS |
| T16 | 真实 OCR 近似视觉 token 数 / 近似压缩比 | PASS |
| T17 | update 冲突消解：旧值被新值覆盖 | PASS |
| T18 | 选择性遗忘：删除后检索不到 | PASS |
| T19 | 跨会话持久化：重建 store 后仍可检索 | PASS |
| T20 | 实测视觉 token 使用文本-only baseline 校准 | PASS |
| T21 | 文本-only prompt_tokens 校准请求 | PASS |
| T22 | 相同 source 的 store 自动更新为最新值 | PASS |
| T23 | optical memory 存储 visual token 元数据 | PASS |
| T24 | 渲染图像生成并存储视觉 embedding（无 embeddings 后端时为 64 维像素 embedding） | PASS |

## Robustness 测试覆盖（M1–M6）

| ID | 场景 | 结果 |
|---|---|---|
| M1 | 多 Agent 共享 store：两个 store 实例通过 reload 互相看到新增记忆 | PASS |
| M2 | 原子保存：多次写入后无 `.tmp` 残留 | PASS |
| M3 | 图像文件丢失后自动重新渲染恢复 | PASS |
| M4 | 渲染缓存损坏（缓存路径被替换为目录）时回退到全新渲染 | PASS |
| M5 | 超长多段落输入（>200KB）分段存储并检索命中目标 | PASS |
| M6 | 超长单段落（约 250KB）切分后无数据丢失 | PASS |

## 已发现并修复的问题（第二轮）

### 并发 active recall 渲染竞争（T12 暴露）

**现象**：多个并发 retrieve 同时命中同一条 fuzzy 记忆时，渲染缓存写入报 `EBUSY: resource busy or locked`。

**原因**：同一输出路径被多个异步渲染同时写入/复制。

**修复**：
- 在 `createMemoryStore` 内增加 `renderLocks`，同一 `outputPath` 的并发渲染只执行一次；
- 缓存写入改为 best-effort，失败不阻断主流程。

**回归**：T12 通过，单元测试仍 9/9。

## 已发现并修复的问题（第三轮：DSH 级 R5/R6 验证）

### DSH 工具输出 schema 严格性（R5 暴露）

**现象**：headless Agent 调用 `ocr1_mem_store` / `ocr1_mem_list` 时提示 "invalid output"，因为返回对象包含 schema 未声明字段（`updated` / `ocrText` / `visualMemory`）。

**修复**：
- `ocr1_mem_store` 输出 schema 增加 `updated: boolean`；
- `ocr1_mem_list` 在 execute 中只返回 schema 声明字段；
- `ocr1_mem_metrics` 去掉 null 可选字段，避免严格 schema 拒绝。

**回归**：DSH 级 R5 再次执行无 invalid output，结果 PASS。

## 自动拉起 OCR 服务验证

**手动故障恢复验证**：

1. 停止 llama-server；
2. 运行 `node scripts/ensure-ocr-server.mjs 18080`；
3. 结果：`OCR server started: http://127.0.0.1:18080/v1`；
4. 随后 `npm test` 全部通过。

**修复记录**：
- 最初通过 PowerShell 脚本 spawn 时，`stdio:'ignore'` 和反斜杠路径会导致服务无法启动；
- 改为直接 spawn `llama-server.exe` 后稳定工作。

## 对比基准：dsh-ocr1-memory vs dsh-memory

- 设计文档：`docs/BENCHMARK.md`
- 执行脚本：`scripts/compare-memory.mjs`
- 隔离环境：两个临时 store + `--patch` 互斥禁用插件
- 结果：已用修正后的 `scripts/compare-memory.mjs` 完整重跑 R1–R6；dsh-ocr1-memory 全部 PASS，dsh-memory 本次也全部 PASS（R5 此前手动验证曾 FAIL，行为不稳定）。dsh-ocr1-memory 未出现落后于 dsh-memory 的情况。

## 后续计划

- [x] 固化复杂测试脚本为 `test/complex.test.mjs` 并纳入 `npm test`
- [x] 自动拉起 OCR 服务（`lib/ocr-server.js` + `autoStartOcrServer`）
- [x] 对比基准脚本 `scripts/compare-memory.mjs`
- [x] 多 Agent 共享 store（`sharedStore` + reload + 原子保存）
- [x] 图像缺失/缓存损坏恢复测试
- [x] 超长输入边界测试（>200KB 多段落 + 超长单段落）
- [ ] 超长输入（10MB）与内存压力
- [ ] LoRA 微调：**按目标要求不需要做**
- [x] 直接视觉 token 数：通过 embeddings 端点 marker-only 请求测量（`visualMemory.visualTokensDirect`）
