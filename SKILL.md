---
name: memory
description: 跨会话长期记忆：先感知 L1 索引，按需读取 L2/L3，带 evidence 写入，并维护 pending、溯源、归档/回滚、光学表示与 OCR 检索。
---

# OCR 分层记忆管理

这是一个同时具备分层治理和光学表示的长期记忆系统。

## 感知策略

1. 每轮先观察注入的 `memory:index`，它只表示有哪些记忆主题，不包含大量正文。
2. 当前任务与索引主题相关，或涉及本机环境、历史决策、用户偏好时，再调用 `memory_read` / `memory_list`。
3. 只有普通文本检索不足、需要跨表述匹配或需要视觉证据时，才调用 `memory_retrieve`；它会先走文本，再按需使用 embedding/OCR。
4. OCR 结果是视觉读回证据，不自动等同于已验证事实。

## 写入策略

- 用户明确要求“记住/保存”时，使用 `memory_write`。
- 技术事实、配置和实测结果必须提供本次成功操作/测试的 `evidence`。
- 用户明确声明的偏好可以记录为偏好，但必须注明来源是用户明确声明，不要伪装成环境事实。
- 成功工具调用产生的潜在经验会先进入 `memory_pending`，确认后再用 `memory_accept` 入正式记忆。
- 不要保存 PID、时间戳、临时路径、一次性状态或未经验证的推测。
- 同主题的新值使用 `memory_update`，默认保留旧版本历史。

## 分层

- L1 `index.txt`：最小存在性指针和 RULES。
- L2 `facts.md`：环境事实、配置和已验证参数。
- L3 `sops/*.md`：可复用的前置条件、坑点和稳定步骤。
- 光学层：SoM 图片、vivid/normal/fuzzy、OCR transcript、embedding、active recall。

## 生命周期

- `memory_archive` 只隐藏记忆，不物理删除。
- `memory_rollback` 恢复 `.history` 中的版本。
- `memory_maintain` 执行去重、L1 压缩、统计和合并候选。
- 光学 fuzzy 只是视觉表示降级，不等于逻辑记忆删除。

## 故障降级

OCR/embedding 服务不可用时，系统应继续提供 L1/L2/L3 和文本检索。不要为了获得 OCR 结果而阻塞整个任务；需要精确视觉证据时再显式重试。
