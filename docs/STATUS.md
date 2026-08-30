[简体中文] | [English](../docs_en/STATUS.md)

# dsh-ocr1-memory 状态总览

快速入口：[README](../README.md) · [实现说明](IMPLEMENTATION.md) · [部署记录](DEPLOYMENT.md) · [基准](BENCHMARK.md) · [测试报告](TEST_REPORT.md)

## 当前状态

| 项目 | 状态 |
|---|---|
| DSH 插件 | ✅ 可安装并注册 OCR1 光学工具与治理工具 |
| 基础记忆链 | ✅ SoM 渲染、年龄 tier、缓存、OCR 读回、verbatim Fetch |
| Locate-and-Transcribe | ✅ 严格 K 位定位器链；需要兼容的已训练模型 |
| Active recall | ✅ 低清命中后恢复 vivid |
| 命中热度动态衰减 | ✅ 已实现；`dynamicDecayEnabled` 默认关闭 |
| 每轮 context | ✅ 默认注入 L1/光学元数据；`contextMode: snapshot` 保留正文快照 |
| 视觉 embedding | ✅ `embeddingRetrieval` 开启时可保存真实向量；主检索默认关闭 |
| 共享 store | ✅ 可选 reload + 原子保存 |
| OCR 服务生命周期 | ✅ endpoint 去重、可取消启动、仅清理插件自启动进程 |
| 维护与取消 | ✅ 每批最多 8 条、namespace single-flight、dispose 会取消并等待 |
| 治理接线 | ✅ runtime skill、L1、pending、turn/end 维护、阈值提醒与 OCR1 同实例同步 |
| 测试 | ✅ `npm test` 88/88 通过（当前真实后端在线） |

## 工具

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
- `memory_read` / `memory_list` / `memory_write` / `memory_retrieve`
- `memory_search` / `memory_index` / `memory_pending` / `memory_accept`
- `memory_update` / `memory_archive` / `memory_rollback` / `memory_promote`
- `memory_stats` / `memory_maintain` / `memory_expand` / `memory_activate`

## 已实现功能

- 文本按段落和长度切分，渲染为带 SoM 编号的方形图像；
- `vivid → normal → fuzzy` 年龄衰减，分辨率变化时强制重新生成并失效旧 OCR 证据；
- OCR 读回、可选文本/视觉 embedding 召回；无后端时 `requireOcr=false` 安全降级，严格模式显式失败；
- LoRA 光学定位器的请求解析、概率选择、阈值/Top-K 规则和 GBNF 严格模式；
- Locate 后按段索引返回原始 verbatim 文本；
- active recall、命中次数、有限访问历史与可选动态衰减；
- `systemPrompt.context()` 同步注入 L1 与光学元数据，带条目数和字符数上限；`snapshot` 模式仍提供正文快照，不在 provider 内调用模型；
- 渲染缓存、并发锁、原子 manifest、多 Agent 共享和损坏产物恢复；
- 集成治理层中的 namespace、evidence、provenance、pending、archive、rollback、全文搜索和跨 namespace 提升；治理写入与 OCR1 store 使用同一实例。

## 测试覆盖

| 套件 | 数量 |
|---|---:|
| 核心 store 测试 | 12 |
| context 测试 | 7 |
| 复杂隔离测试 T1–T24 | 24 |
| OCR HTTP | 2 |
| OCR 服务生命周期 | 4 |
| Embedding 测试 E1–E5 | 5 |
| 定位器测试 L1–L8 | 8 |
| 治理层与取消信号测试 | 13 |
| 集成接线与自动治理测试 | 2 |
| 渲染几何 RG1–RG2 | 2 |
| Robustness M1–M9 | 9 |
| **合计** | **88** |

真实 OCR、embedding 和渲染依赖后端与 Python 环境；当前真实后端在线时 88 项全通过，后端不可用时 8 个 live-backend 用例跳过，其余测试仍可执行。

## 对论文的复现边界

已实现的是 OCR1/OCR-Memory 的工程对应物：SoM、分辨率衰减、active recall、Locate-and-Transcribe、严格二元定位、可选 embedding、动态衰减和 context 快照。

仍未完整复现：

1. DeepEncoder 内部压缩、逐层 visual-token 数和内部张量导出；
2. 官方内部多模态 embedding 的完全等价输出；
3. 论文规模训练以及 Mind2Web、AppWorld、RULER 等完整主表评测；
4. 任意硬件、驱动、量化或服务托管组合下的普遍性能保证。

这些项目需要不同的模型内部访问、数据/评测资源或平台条件；不应把当前小规模端到端验证写成论文主表复现。当前本机以 Windows CPU-only `llama-server` 验证了 OCR/embedding 端到端路径；无真实后端时，8 个依赖服务的用例会跳过而不是伪造通过。平台细节和已验证的模型转换路线见 [DEPLOYMENT.md](DEPLOYMENT.md)。
