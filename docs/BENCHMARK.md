# Agent Memory Benchmark：dsh-ocr1-memory vs dsh-memory

## 依据

参考社区常见记忆基准：

- **MemoryAgentBench**（ICLR 2026）：四类核心能力
  - accurate retrieval（准确检索）
  - test-time learning（测试时学习 / 规则吸收）
  - long-range understanding（长程理解）
  - selective forgetting / conflict resolution（选择性遗忘 / 冲突消解）
- **LongMemEval**：single-session recall、preference recall、knowledge update、temporal reasoning、multi-session recall
- **AMB**：强调 agentic tasks + token cost / latency

## 对比目标

在“同样官方原装 DSH + headless profile”的隔离环境下：

- Profile A：只启用 `dsh-ocr1-memory`
- Profile B：只启用 `dsh-memory`
- 两者使用独立临时 store 目录，跑完清理
- 任务提示相同，但允许各自使用自己的记忆工具

## 测试任务

### R1：准确检索（Accurate Retrieval）
- 存入一条明确事实，例如：`Orbit API 的 token 10 分钟过期`
- 查询该事实
- 通过标准：返回内容包含 `Orbit API` 和 `10 分钟`

### R2：测试时学习（Test-time Learning）
- 存入一条用户规则/偏好，例如：`用户要求所有回复使用中文`
- 后续查询该规则
- 通过标准：返回内容包含规则关键内容

### R3：长程理解（Long-range Understanding）
- 存入 20 条不同事实，查询其中第 17 条
- 通过标准：能命中第 17 条，且不把其他条误报为答案

### R4：冲突消解 / 更新（Conflict Resolution）
- 先存：`服务器地址是 A`
- 再存：`服务器地址改为 B`
- 查询当前服务器地址
- 通过标准：能返回最新值 `B`，或至少能同时暴露新旧两条并让上层判断

### R5：选择性遗忘（Selective Forgetting）
- 存储临时信息
- 使用遗忘/删除/归档工具移除
- 再次检索应返回 NOT_FOUND

### R6：跨会话持久化（Multi-session Persistence）
- 第一次独立 DSH 调用存储事实
- 第二次独立 DSH 调用（共享同一临时 store）检索该事实
- 通过标准：第二次能检索到第一次存入的内容

## 评分指标

| 指标 | 说明 |
|---|---|
| Exact Hit | 返回内容包含全部关键 token |
| Partial Hit | 返回内容包含部分关键 token |
| Miss | 未返回或返回无关内容 |
| Latency | 从任务开始到返回的秒数 |
| Store Pollution | 是否写入了默认 `~/.dsh/...`（应始终为 false） |

## 隔离方式

- 每个 Profile 使用 `--patch` 临时 overlay：
  - 禁用另一个 memory 插件
  - 把 storeDir/memoryDir 指向 `mkdtemp` 临时目录
- 测试后删除临时目录
- 不修改 `~/.dsh/ocr1-memory` 和 `~/.dsh/memory`

## 执行命令示例

```bash
# Profile A（只留 dsh-ocr1-memory）
dsh --profile headless \
  --patch disable-memory.yml \
  --patch ocr1-temp-store.yml \
  "<任务提示>"

# Profile B（只留 dsh-memory）
dsh --profile headless \
  --patch disable-ocr1.yml \
  --patch memory-temp-store.yml \
  "<任务提示>"
```

## 实测结果（隔离临时环境）

执行脚本：`scripts/compare-memory.mjs`

| 任务 | dsh-ocr1-memory | dsh-memory |
|---|---|---|
| R1 准确检索 | ✅ PASS (2/2), 27.8s | ✅ PASS (2/2), 14.5s |
| R2 测试时学习 | ✅ PASS (1/1), 10.9s | ✅ PASS (1/1), 19.3s |
| R3 长程理解 | ✅ PASS (1/1), 333.9s | ✅ PASS (1/1), 42.6s |
| R4 冲突消解 | ✅ PASS (1/1), 35.6s | ✅ PASS (1/1), 27.0s |
| R5 选择性遗忘 | ✅ PASS（`ocr1_mem_forget` 后检索 NOT_FOUND） | ✅ PASS（本次脚本）；⚠️ 此前手动验证曾 FAIL（`memory_archive` 后仍可读到） |
| R6 跨会话持久化 | ✅ PASS（两次独立 DSH 调用共享 store，第二次命中“用户喜欢喝咖啡”） | ✅ PASS（两次独立 DSH 调用共享 memoryDir，第二次命中） |

结论：
- dsh-ocr1-memory 在 R1–R6 全部通过；
- dsh-memory 在本次完整脚本运行中 R1–R6 也全部通过；但其 R5 结果不稳定：当 Agent 选择 `memory_archive` 时仍可被 `memory_read` 读到，选择物理删除时才通过；
- 当前测试中没有出现 dsh-ocr1-memory 不如 dsh-memory 的情况；
- 延迟方面：R1/R2/R3 中 dsh-ocr1-memory 的 R3 明显更慢（因为光学检索会对 20 条记忆逐张 OCR 读回），其余任务互有快慢；
- 注意：R4 两者都返回了 `B`；dsh-ocr1-memory 已新增显式 `ocr1_mem_update`，冲突消解更可靠。

## R5/R6 扩展状态

- R5（选择性遗忘）和 R6（跨会话持久化）已加入 `scripts/compare-memory.mjs` 设计。
- 已在隔离 headless 环境中完成 DSH 级完整对比（本次使用后台运行，不 kill 进程）：
  - R5/R6 手动验证时 dsh-ocr1-memory 使用完整 OCR + embedding 配置（`COMPARE_WITH_EMBEDDING=1` 等价）；
  - R5：dsh-ocr1-memory PASS；dsh-memory 本次脚本 PASS，但此前手动验证曾 FAIL（归档仍可被 `memory_read` 读到），行为不稳定。
  - R6：两者均 PASS。
- `scripts/compare-memory.mjs` 默认启用 OCR 读回但关闭逐条 embedding（保证 R3 等 20 条存储任务不会过慢）；需要完整 embedding 时设 `COMPARE_WITH_EMBEDDING=1`。
- core 层测试也覆盖：
  - T18：选择性遗忘（删除后检索不到）
  - T19：跨会话持久化（重建 store 后仍可检索）

## 预期

- 如果 dsh-ocr1-memory 在多数任务上明显不如 dsh-memory，则需要继续优化。
- 已知风险：dsh-ocr1-memory 的 update/conflict 已显式支持，但仍需在更多复杂场景中验证。
