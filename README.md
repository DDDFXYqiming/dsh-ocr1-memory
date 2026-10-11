简体中文 | [English](README.en.md)

# @dsh-external/dsh-ocr1-memory

**基于 DeepSeek-OCR 光学上下文压缩（OCR1）的 DeepSeek Harness 视觉记忆扩展**。

本插件将 DeepSeek-OCR 论文中提出的“上下文光学压缩”（Contexts Optical Compression, OCR1）前沿架构引入智能体记忆工程中。系统将长文本记忆分段排版并渲染为带有 Set-of-Mark (SoM) 编号的光学图像，利用视觉 Token 对文本信息的超高信息密度进行压缩存储，并结合动态分辨率衰减与主动回忆（Active Recall）机制，在保持极高压缩率的同时实现无损原文召回。

---

## 核心设计与技术亮点

* **文本光学压缩（Optical Context Compression）**：打破传统纯文本或嵌入向量存储的局限，将段落文本渲染为密集视觉图像。通过视觉 Token 替代海量文本 Token，在长程上下文中显著削减 Token 开销。
* **分级分辨率衰减与主动回忆（Active Recall）**：
  * **时间衰减三档位**：记忆图像随时间推移在 `vivid (高清)` → `normal (标准)` → `fuzzy (模糊/低显存)` 档位间动态退化。
  * **主动回忆机制**：当检索命中低分辨率历史记忆时，系统触发 Active Recall 将其自动恢复至高清层，保证后续重读的高置信度。
* **SoM 空间标记与光学定位器（Optical Locator）**：
  * 图像预置 SoM 编号锚点，支持可选的轻量级本地视觉定位器（基于 GGUF/llama-server）。
  * 模型仅需输出 K-bit 的 `0/1` 视觉分类标记即可快速命中目标候选段落，最后精准还原并输出百分之百真实的原文。
* **压缩效率监控面板（Metrics & Baseline）**：内建 `ocr1_mem_metrics` 工具，实时跟踪文本 Token 数、视觉 Token 消耗及实际光学压缩比。
* **完备的治理与生命周期**：原生兼容三层记忆治理体系（L1 索引紧凑化、版本回滚、归档与跨命名空间晋升）。

---

## 运行架构

```
[原始长文本] ──> [段落切片 + 排版] ──> [渲染为 SoM 标记图像] ──> [分辨率衰减管理]
                                                                        │
                                                                        ▼
[无损原文输出] <── [精确原文回溯] <── [视觉定位器 / OCR 筛选] <── [检索触发 (Active Recall)]
```

---

## 工具矩阵

| 工具名称 | 核心职责 | 技术特征 |
| :--- | :--- | :--- |
| `ocr1_mem_store` | 将文本切片、渲染为 SoM 图像并光学存盘 | 光学渲染与索引录入 |
| `ocr1_mem_retrieve` | 光学与文本混合检索，触发 Active Recall | 多模态召回与高清恢复 |
| `ocr1_mem_metrics` | 统计文本 Token、视觉 Token 及压缩比率 | 量化评估面板 |
| `ocr1_mem_update` | 更新记忆内容并重置其生命周期活跃度 | 增量重构与刷新 |
| `ocr1_mem_calibrate`| 校准基准分词器与文本 Token 估算基线 | 基线标定 |
| `ocr1_mem_forget` | 彻底擦除指定记忆及其衍生的光学图像文件 | 物理擦除 |
| `memory_read` / `write` | 兼容通用分层治理读写接口 | 治理体系互通 |

---

## 安装与快速上手

```bash
# 通过 DSH 插件管理器安装
dsh plugin --profile web add github:DDDFXYqiming/dsh-ocr1-memory
```

本地开发：
```bash
git clone https://github.com/DDDFXYqiming/dsh-ocr1-memory.git
cd dsh-ocr1-memory
npm install && npm run build
dsh plugin --profile web add .
```

---

## 配置指南

在对应 Profile 的 `cordis.patch.yml` 中配置光学存储与 OCR 服务：

```yaml
- id: dsh-ocr1-memory
  config:
    memoryDir: '~/.dsh/memory'         # 记忆与光学文件主目录
    ocrModel: 'deepseek-ai/DeepSeek-OCR' # OCR 模型标识
    requireOcr: false                  # 是否在 OCR 服务离线时阻断降级
    maintenanceBatchSize: 8            # 批次维护的光学条目上限

    # 本地 llama-server 自启配置（可选）
    autoStartOcrServer: false          # 是否由插件托管拉起 OCR 服务进程
    ocrServerPort: 18080               # 服务端口
    ocrServerPath: ''                  # llama-server 二进制绝对路径
    ocrModelDir: ''                    # GGUF 模型文件目录

    # 光学定位器设置（可选）
    opticalLocatorEnabled: false       # 是否启用基于视觉定位器的快速标记过滤
    opticalLocatorThreshold: 0.4       # 召回阈值
    opticalLocatorTopK: 5              # 最大候选数
```

---

## 许可证

本项目基于 [MIT License](LICENSE) 开源。
