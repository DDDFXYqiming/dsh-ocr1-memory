简体中文 | [English](README.en.md)

# @dsh-external/dsh-ocr1-memory

基于 **DeepSeek-OCR: Contexts Optical Compression**（OCR1）思想的 DSH 光学记忆插件。

> 这是 DSH plugin，不是 agent skill；仓库不需要 `SKILL.md`。

文本记忆会被按段落渲染为带 SoM 编号的图像，旧记忆按年龄降低分辨率；检索时可由光学定位器选择相关段，再确定性地返回原始 verbatim 文本。这样既保留视觉压缩路径，也避免生成式复述带来的幻觉。

## 能力

| 工具 | 作用 |
|---|---|
| `ocr1_mem_status` | 查看存储、渲染与 OCR 配置状态 |
| `ocr1_mem_store` | 分段、渲染并保存记忆 |
| `ocr1_mem_update` | 更新记忆并重置为最新层级 |
| `ocr1_mem_retrieve` | 检索、OCR 读回、active recall |
| `ocr1_mem_list` | 列出记忆条目与命中次数 |
| `ocr1_mem_metrics` | 查看文本/视觉 token 与压缩比 |
| `ocr1_mem_calibrate` | 校准文本 token 基线 |
| `ocr1_mem_forget` | 删除记忆及其光学产物 |
| `ocr1_mem_render_test` | 渲染管线自测 |
| `ocr1_mem_embed_test` | 视觉 embedding 自测 |

## 工作方式

1. 文本按空行和长度切成段落，并渲染为 SoM 图像。
2. `vivid → normal → fuzzy` 三级分辨率随年龄衰减；命中低清记忆时 active recall 恢复高清。
3. 配置光学定位器后，模型输出 K 位 `0/1` 标签，插件按阈值和 Top-K 规则选择段。
4. Fetch 阶段只从持久化原文取回选中段，不生成替代文本。
5. 视觉 embedding、命中热度衰减和每轮 context 注入都是可选能力。

## 配置

在 profile 的 `cordis.patch.yml` 中覆盖需要的选项：

```yaml
- id: dsh-ocr1-memory
  config:
    storeDir: ''
    ocrBaseUrl: ''                 # OpenAI 兼容 /v1/chat/completions；留空可使用文本路径
    ocrApiKey: ''
    ocrModel: 'deepseek-ai/DeepSeek-OCR'
    requireOcr: false
    opticalLocatorEnabled: false   # 需要已训练的定位器模型
    opticalLocatorBaseUrl: ''
    opticalLocatorModel: 'deepseek-ocr-memory'
    opticalLocatorThreshold: 0.4
    opticalLocatorTopK: 5
    dynamicDecayEnabled: false     # 按近期命中频率延缓层级衰减；升级兼容，默认关闭
    autoInjectContext: false       # 每次 prompt assemble 注入限长记忆摘要；默认关闭
    contextMaxEntries: 5
    contextMaxChars: 4000
    sharedStore: false
    embeddingRetrieval: false      # 视觉 embedding 检索，默认关闭
```

未列出的高级选项（渲染器、服务生命周期、embedding、定位器严格模式等）见 [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md)。

## 安装

```bash
dsh plugin --profile web add github:DDDFXYqiming/dsh-ocr1-memory
```

## OCR 后端

插件使用 OpenAI 兼容接口：

- `/v1/chat/completions`：OCR 读回和光学定位；
- `/v1/embeddings`：可选的多模态视觉 embedding。

将 `ocrBaseUrl` 指向兼容服务即可启用 OCR；未配置时仍可使用不依赖 OCR 的文本记忆路径。后端启动、模型格式和平台注意事项见 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)。

## 复现范围

这是对 OCR1 和 OCR-Memory 思想的工程实现，不宣称复刻模型内部机制或论文主表：

- ✅ SoM、年龄分辨率、active recall、Locate-and-Transcribe、严格 K-bit 定位链；
- ✅ 可选真实视觉 embedding、命中频率动态衰减、DSH `systemPrompt.context()` 摘要注入；
- ⚠️ DeepEncoder 内部张量/逐层 visual token、官方内部 embedding 和论文规模评测不在本插件内完整复现。

详细架构、训练/部署链和逐项对照见 [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md)。

## 文档

- [IMPLEMENTATION](docs/IMPLEMENTATION.md)：架构与论文复现矩阵；
- [DEPLOYMENT](docs/DEPLOYMENT.md)：后端部署与验证注意事项；
- [STATUS](docs/STATUS.md)：当前实现状态与已知边界；
- [BENCHMARK](docs/BENCHMARK.md)：与 `dsh-memory` 的隔离对比；
- [EXPLORATION](docs/EXPLORATION.md)：研究与实测记录；
- [TEST_SPEC](docs/TEST_SPEC.md) / [TEST_REPORT](docs/TEST_REPORT.md)：测试说明与报告。

## 参考

- [DeepSeek-OCR](https://github.com/deepseek-ai/DeepSeek-OCR) · [论文](https://arxiv.org/abs/2510.18234)
- [OCR-Memory](https://arxiv.org/abs/2604.26622)
- [AgentOCR](https://github.com/langfengQ/AgentOCR)
