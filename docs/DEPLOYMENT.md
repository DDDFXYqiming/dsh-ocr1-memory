简体中文 | [English](../docs_en/DEPLOYMENT.md)

# 部署与验证记录（Deployment Notes）

本文收纳平台相关的部署方法、定位器模型转换和已验证的运行边界；它们不是所有机器的兼容性承诺。快速配置请看 [README.md](../README.md)，通用架构请看 [IMPLEMENTATION.md](IMPLEMENTATION.md)。

## 1. 后端接口

插件不绑定某个推理进程，只要求 OpenAI 兼容接口：

- `/v1/chat/completions`：图像 OCR 读回，或输出定位器的 K 位 `0/1` 标签；
- `/v1/embeddings`：可选的多模态视觉 embedding。

vLLM、llama.cpp 或其他兼容服务均可作为后端。定位器请求需要支持图像输入；启用严格模式时，还应支持与模型输出一致的语法约束。

如果同一个 llama.cpp 服务同时启用 chat 和 embeddings，插件可以复用一个后端；如果使用独立 embedding 服务，则配置对应的 embedding 地址和生命周期选项。大图的物理 batch 上限必须不小于单图视觉 token 数，否则后端可能返回 input-too-large。

## 2. 服务启动

仓库提供两种通用入口：

```text
node scripts/ensure-ocr-server.mjs <port>
powershell -File scripts/start-ocr-server.ps1
```

脚本会检查健康状态，必要时以 detached 子进程启动 `llama-server`。也可以通过 `autoStartOcrServer` 让插件加载时自动确保服务在线；模型目录和可执行文件通过 `ocrModelDir`、`ocrServerPath`、`OCR_MODEL_DIR`、`OCR_SERVER_PATH` 或 PATH 提供。仓库不包含本机绝对路径；服务不在线且未提供模型目录时，启动会明确报错。

典型的本机 CPU-only 配置（路径按机器替换）如下：

```yaml
ocrBaseUrl: 'http://127.0.0.1:18080/v1'
ocrEmbeddingBaseUrl: 'http://127.0.0.1:18080/v1' # combined chat + embeddings
requireOcr: true
autoStartOcrServer: true
ocrServerPath: 'D:/models/llama.cpp-cpu/llama-server.exe'
ocrModelDir: 'D:/models/deepseek-ocr-gguf'
ocrServerPort: 18080
embeddingRetrieval: false
```

建议先独立确认 `/health` 或 `/props`，再把服务的 `/v1` 地址填入 `ocrBaseUrl`。使用 combined 模式时，将同一个地址填入 `ocrEmbeddingBaseUrl`，或留空让插件回退到 OCR 地址。URL 中的显式端口是启动与健康检查的权威端口；同一 endpoint 的并发启动会合并为一个任务。插件只回收自己启动的进程，启动失败、取消和卸载都会等待并清理已拥有的服务。`requireOcr: false` 才允许 OCR 不可用时保留文本路径；`true` 会让 OCR 读回显式失败。

## 3. 定位器模型链

定位器的可复现链路如下：

1. `scripts/prepare_hotpotqa_locator.py` 将带 distractor 的问答样本转换为 SoM 图像和二元标签；
2. `scripts/train_locator_unsloth.py` 使用 DeepSeek-OCR decoder 的 LoRA 学习 K 位定位输出；
3. `scripts/eval_locator.py` 在相同标签语法下评估 base 与 LoRA；
4. `verify_collator_alignment.py` 检查图像、prompt、标签区间和 EOS 的对齐；
5. 用模型转换工具将 adapter 合并为目标后端可加载的格式；
6. 在 DSH 配置 `opticalLocatorEnabled: true`，执行真实的 Locate → deterministic Fetch 闭环。

训练输入和运行时请求必须保持一致：图像布局、换行前缀、空格分隔的 `0/1` 序列、停止条件和 GBNF 约束都属于协议的一部分。

在本机验证中，LoRA 训练和模型合并路线已经打通；小规模样本可以改善定位，但不代表论文规模的统计复现。验证过的发布形态是合并后的高精度 GGUF；较激进的低比特量化在定位任务上可能放大 LoRA 小增量，发布前应重新做端到端检验。

## 4. 视觉 embedding

llama.cpp 的多模态 embedding 请求使用运行时返回的 media marker 和裸 base64 图像数据。插件会保存向量维度、图像版本和直接视觉 token 统计；渲染图像变化后，旧 embedding 会被视为失效。

视觉 embedding 默认不参与主检索，也不会因仅配置 `ocrEmbeddingBaseUrl` 就为每条记忆生成；只有 `embeddingRetrieval: true` 时，持久化 store 才生成向量并将其用于召回。`ocr1_mem_embed_test` 是独立诊断工具，可直接测量已配置的 embedding client。只有在目标模型和数据上验证了跨模态区分度后，才建议打开 `embeddingRetrieval`；否则使用文本/OCR 召回更可控。

Embedding 与 OCR 使用同一 endpoint 时，插件复用 OCR server；独立 endpoint 可由 `ocrEmbeddingOnDemand` 首次使用时启动，并在 `ocrEmbeddingIdleTimeoutMs` 后回收。`ocrEmbeddingAutoStart` 可改为加载时启动独立服务。

## 5. 已验证的运行边界

- Windows 原生和 Linux/WSL 的 llama.cpp 服务均可作为兼容后端，但构建、驱动、模型量化和进程托管行为可能不同。
- 某些宿主沙箱会在命令返回后清理其子进程，导致 llama-server 看似崩溃；应使用 DSH 的 detached 生命周期或宿主认可的服务管理方式启动，不要把一次沙箱退出直接归因于模型文件损坏。
- AMD/ROCm 路线可用于部分 transformers/LoRA 实验；DeepEncoder 内部表示是否能取得，取决于可用的模型代码和钩子，不应把它笼统归因于某一种 GPU。
- llama.cpp 的公开 HTTP API 不提供 DeepEncoder 内部张量和逐层 visual-token 明细，因此本插件的 token 指标是接口级统计，不是论文内部测量。
- 论文级训练规模以及 Mind2Web、AppWorld、RULER 等评测需要额外数据、时间和计算资源；本仓库的本地验证不能替代这些主表结果。

## 6. 无独显运行

记忆系统本身不依赖独立显卡。插件逻辑、JSON 持久化、tier 管理、同步 context 快照和 Python/Pillow 图像渲染均可由 CPU 完成；OCR、Locate 和视觉 embedding 则由外部 llama.cpp/vLLM 服务提供。

本机已验证的运行方案是 Windows CPU-only llama.cpp：OCR 与 embedding 共用一个 CPU 服务，运行时不占用 RX 7800 XT。LoRA 训练属于独立的开发流程，训练时可以使用 GPU，但部署已合并的模型和日常存取不需要重新训练。

若不配置 OCR 后端且 `requireOcr=false`，文本记忆路径仍可使用。需要 OCR、Locate 或视觉 embedding 时，才需要启动对应服务。

核显是可选加速设备，不是必要条件。带 Vulkan 后端的 llama.cpp 理论上可以使用核显，但当前本机真实验收覆盖的是 CPU-only 路径，没有把完整链路单独归因到核显。要保证不使用独显，应把 `OCR_SERVER_PATH` 或 `ocrServerPath` 指向 CPU-only `llama-server`；仅使用 PATH 解析不会自动选择 CPU、核显或独显。

注意：这只描述 OCR1 记忆服务的硬件依赖；DSH 使用的其他主模型是否占用独显，属于另一条链路。

## 7. 验证清单

部署后建议按顺序检查：

1. 后端健康检查和图像请求；
2. SoM 渲染与缺失图像恢复；
3. OCR 读回及 `prompt_tokens` 记录；
4. `requireOcr` 严格模式与无后端时的文本降级边界；
5. embedding 维度、按需启动和失败降级；
6. 定位器严格 K-bit 输出；
7. 定位后的 verbatim Fetch；
8. 共享 store、active recall、动态衰减和 context 快照；
9. `memory_maintain` 的 batch/remaining/取消行为与重复调用；
10. `npm test` 全量回归。

详细测试场景见 [TEST_SPEC.md](TEST_SPEC.md) 和 [TEST_REPORT.md](TEST_REPORT.md)。
