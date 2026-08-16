# Agent 记忆系统测试规范（调研与映射）

> 目标：确认“简单通用的 agent 记忆测试规范”有哪些，并把当前 dsh-ocr1-memory vs dsh-memory 的隔离对比映射到这些规范上。

## 1. 调研结论

社区常用的 agent 记忆基准/规范主要有：

| 基准/规范 | 核心能力 | 指标 |
|---|---|---|
| **MemoryAgentBench**（arXiv:2507.05257） | Accurate Retrieval、Test-Time Learning、Long-Range Understanding、Conflict Resolution | Substring Exact Match、Recall、分类准确率、Latest-fact Exact Match |
| **LongMemEval** | Single-session user/assistant/preference recall、Knowledge update、Temporal reasoning、Multi-session recall | Accuracy、Latency、Token consumption |
| **LoCoMo** | Single-hop、Multi-hop、Open-domain、Temporal memory recall | BLEU/F1、LLM judge、Latency |
| **BEAM / AMB** | 超长上下文、偏好/指令跟随、信息抽取、知识更新、多会话推理、矛盾消解、成本/延迟 | Accuracy、Token consumption、Latency |

简化后，**一个可落地的通用最小测试集**通常包含：

1. **准确检索**：存一条事实，查这条事实，必须返回原文关键内容。
2. **测试时学习**：存一条用户规则/偏好，后续能按该规则回答。
3. **长程理解 / 长列表检索**：存入多条事实，能准确命中目标条目，不串扰。
4. **冲突消解 / 更新**：同一主题旧值被新值覆盖后，应返回最新值。
5. **选择性遗忘**：删除/归档后，不应再被普通检索命中。
6. **跨会话持久化**：第一次会话写入，第二次独立会话能读到。

## 2. 当前对比测试映射

`scripts/compare-memory.mjs` 与 `docs/BENCHMARK.md` 中的 R1–R6 对应关系：

| 任务 | 对应通用规范 | 通过标准 |
|---|---|---|
| R1 准确检索 | MemoryAgentBench AR / LongMemEval single-session recall | 返回内容包含全部关键 token |
| R2 测试时学习 | MemoryAgentBench TTL / LongMemEval preference recall | 返回内容包含规则关键内容 |
| R3 长程理解 | MemoryAgentBench LRU / LoCoMo multi-hop | 20 条中准确命中第 17 条 |
| R4 冲突消解 | MemoryAgentBench CR / LongMemEval knowledge update | 返回最新值 `B` |
| R5 选择性遗忘 | MemoryAgentBench selective forgetting / LongMemEval knowledge deletion | 删除后检索输出 NOT_FOUND |
| R6 跨会话持久化 | LongMemEval multi-session recall | 第二次独立会话能命中第一次写入内容 |

## 3. 隔离环境要求

- 同一官方原装 DSH + headless profile；
- Profile A：只启用 `dsh-ocr1-memory`；
- Profile B：只启用 `dsh-memory`；
- 各自使用 `mkdtemp` 临时 store/memoryDir，跑完清理；
- 不修改默认 `~/.dsh/ocr1-memory` 与 `~/.dsh/memory`；
- 不 kill 进程：脚本默认 `COMPARE_TIMEOUT_MS=0`（无超时 kill），必要时用后台任务观察。

## 4. 当前结果摘要

| 任务 | dsh-ocr1-memory | dsh-memory |
|---|---|---|
| R1 | PASS | PASS |
| R2 | PASS | PASS |
| R3 | PASS | PASS |
| R4 | PASS | PASS |
| R5 | PASS | 本次脚本 PASS；此前手动验证曾 FAIL（归档后仍可被 `memory_read` 读到），行为不稳定 |
| R6 | PASS | PASS |

结论：dsh-ocr1-memory 未出现落后于 dsh-memory 的情况；dsh-memory 的 R5 结果受 Agent 选择“物理删除/归档”影响，存在不稳定性。

## 5. 参考链接

- MemoryAgentBench: https://arxiv.org/abs/2507.05257
- LongMemEval: https://arxiv.org/abs/2410.10813
- LoCoMo: https://arxiv.org/abs/2402.17753
- AMB / Agent Memory Benchmark: https://github.com/vectorize-io/agent-memory-benchmark
- Mem0 State of AI Agent Memory: https://mem0.ai/blog/state-of-ai-agent-memory-2026
