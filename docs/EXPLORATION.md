[简体中文] | [English](../docs_en/EXPLORATION.md)

# 模型后端与光学定位

插件使用 DeepSeek-OCR 读取 SoM 记忆图，通过分段定位与原文回读提供长期记忆。模型部署、插件逻辑和 LoRA 训练属于不同环节，应分别验证。

## 模型与参考实现

[DeepSeek-OCR](https://arxiv.org/abs/2510.18234) 使用 DeepEncoder 压缩文档图像。[OCR-Memory](https://arxiv.org/abs/2604.26622) 结合 SoM、定位后转写、多分辨率和主动召回；[AgentOCR](https://github.com/langfengQ/AgentOCR) 则采用其他视觉语言模型实现光学缓存。

插件的指标与论文内部指标需要区分。HTTP 接口返回的 usage 和 pooled embedding 不能直接证明等于 DeepEncoder 内部表示，论文规模的复现还需要一致的数据划分与评测协议。

## 运行服务

GGUF 模型可通过兼容的 llama-server 提供 OCR 和 embedding 接口。配置方式见 [部署说明](DEPLOYMENT.md)。模型路径和可执行文件由配置项或环境变量提供。

OCR 与 embedding 可以共用支持这两种请求的服务。自主管理服务时，插件合并同一 endpoint 的并发启动，并在取消或卸载时回收自己启动的进程。

## 多模态 embedding

请求前从 `GET /props` 读取当前 `media_marker`。请求体的 `multimodal_data` 使用原始 Base64，不带 data URL 前缀。

```json
{"input":[{"prompt_string":"<media_marker>","multimodal_data":["<raw base64>"]}]}
```

图像产生的视觉 token 需要足够的 physical batch size。服务配置与图像尺寸改变后，应重新验证容量和输出。插件保存向量维度、图像标识与接口级 token 统计，默认关闭 embedding 检索，启用前需测量跨模态区分度。

## LoRA 定位器

训练链依次准备 SoM 图像和二元标签、训练 decoder LoRA、比较 base 与 adapter、合并权重并转换为部署格式。训练和推理的图像布局、空格分隔的 0/1 语法、结束规则必须一致。

输入包括 `images=[(patches, global_view)]`、`images_seq_mask` 和 `images_spatial_crop`。只监督目标标签，图像和提示部分使用忽略标签。兼容性检查应覆盖 tokenizer、collator 与所用模型代码版本。

小规模定位实验可以验证训练、解码与回读链路。完整性能判断还需固定样本划分、量化方式和解码约束。相关测试入口见 [测试规范](TEST_SPEC.md) 与 [测试记录](TEST_REPORT.md)。
