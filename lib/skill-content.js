// Runtime skill instructions for the integrated OCR1 governance layer.
// The plugin remains a plugin; this is registered through ctx.skills at runtime.

export const SKILL_NAME = 'memory'

export const SKILL_DESCRIPTION = '跨会话长期记忆：L1 索引、L2 环境事实、L3 任务 SOP、OCR1 光学表示、全文/光学检索、pending 蒸馏、溯源、归档、回滚与维护。涉及本机环境、工具配置、历史踩坑或可复用验证经验时使用。'

export const SKILL_WHEN_TO_USE = '新任务需要历史环境事实或相似经验时读取；任务完成且有行动验证成功、未来可复用的信息时写入；出现失败后成功的重试序列时审阅 pending；记忆条目或索引达到维护条件时整理。'

export const SKILL_CONTENT = `# 记忆管理（OCR1 integrated）

本插件把长期记忆分成治理层和光学层：
- L1 index：每轮注入的轻量定位索引；
- L2 facts：已验证的环境事实；
- L3 sops：已验证的任务经验与稳定步骤；
- OCR1 optical store：SoM 图像、vivid/normal/fuzzy 层级、OCR/embedding 缓存和确定性原文 Fetch。

## 读取

- 新任务涉及本机路径、配置、特定工具、旧故障或类似任务时，先用 'memory_retrieve' 按问题检索；需要知道有哪些条目时用 'memory_list'。
- 已看到 L1 索引中的相关主题后，用 'memory_read' 读取具体 fact/SOP。
- 需要跨 namespace 或包括已归档条目时用 'memory_search'。
- 'memory_retrieve' 会优先使用 OCR1 光学表示并按命中段 Fetch 原文；没有光学后端时安全降级为文本检索。
- 直接检查全部 SoM 图像、层级和 active recall 时使用 'ocr1_mem_retrieve'。

## 写入

任务完成或阶段完成后，只有在存在行动验证证据且内容未来可复用时才写入：
- 环境特异性路径、配置、实测参数 → 'memory_write(entry_type=fact)'；
- 多次排错后得到的前置条件、坑点和稳定步骤 → 'memory_write(entry_type=sop)'；
- evidence 必须描述实际成功的命令、测试、用户确认或可核验结果。

不写入模型常识、推测、未验证假设、临时 PID/时间戳/一次性状态或无复用价值的日志。

## 自动蒸馏与整理

- 工具调用出现“同一工具先失败、随后成功”时，turn/end 自动创建 pending 候选；它不是正式记忆，使用 'memory_pending' 审阅，再用 'memory_accept' 补全并确认。
- turn 计数达到维护周期时自动执行去重、L1 压缩、统计和合并候选分析。
- pending、SOP 或 L1 超过阈值时会注入整理提醒；使用 'memory_maintain' 执行整理。
- 正式记忆会同步生成 OCR1 SoM 图像；更新会保留历史，归档不会物理丢失内容。

## 工具选择

- 治理入口：'memory_read', 'memory_list', 'memory_write', 'memory_retrieve', 'memory_search', 'memory_index', 'memory_pending', 'memory_accept', 'memory_update', 'memory_archive', 'memory_rollback', 'memory_stats', 'memory_maintain', 'memory_expand', 'memory_promote'。
- 光学诊断/直接操作：'ocr1_mem_status', 'ocr1_mem_store', 'ocr1_mem_update', 'ocr1_mem_retrieve', 'ocr1_mem_list', 'ocr1_mem_metrics', 'ocr1_mem_forget'。
`
