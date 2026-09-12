[Chinese](../docs/EXPLORATION.md) | English

# Model Backends and Optical Locating

The plugin reads SoM memory images through DeepSeek-OCR and combines segment locating with verbatim retrieval. Model serving, plugin logic and LoRA training are separate paths and need separate validation.

## References

[DeepSeek-OCR](https://arxiv.org/abs/2510.18234) compresses document images with DeepEncoder. [OCR-Memory](https://arxiv.org/abs/2604.26622) combines SoM, locate-and-transcribe, multiple resolutions and active recall. [AgentOCR](https://github.com/langfengQ/AgentOCR) explores optical caching with a different model family.

HTTP usage and pooled embeddings do not establish equivalence with internal DeepEncoder representations. Paper-scale reproduction also requires matching datasets, splits and evaluation protocols.

## Serving

A compatible llama-server can expose OCR and embedding endpoints for GGUF models. See [Deployment](DEPLOYMENT.md). Executable and model locations come from configuration or environment variables.

OCR and embedding requests may share a service that supports both. Plugin-managed startup coalesces requests for the same endpoint and only disposes of processes owned by the plugin.

## Multimodal Embeddings

Read the current `media_marker` from `GET /props`. Supply raw Base64 image data without a data URL prefix.

```json
{"input":[{"prompt_string":"<media_marker>","multimodal_data":["<raw base64>"]}]}
```

Physical batch size must accommodate the image tokens. Recheck capacity after changing image dimensions or service settings. The plugin stores vector dimensions, image identity and endpoint-level token statistics. Embedding retrieval is disabled by default and should be enabled only after testing cross-modal discrimination.

## LoRA Locator

The training path prepares SoM images and binary labels, trains a decoder adapter, compares base and adapter outputs, merges weights and converts the result for deployment. Image layout, spaced 0/1 labels and stopping rules must agree between training and inference.

Inputs include `images=[(patches, global_view)]`, `images_seq_mask` and `images_spatial_crop`. Supervise target labels only; image and prompt positions use ignored labels. Check tokenizer, collator and model-code compatibility together.

Small experiments can validate training, decoding and retrieval. Performance comparisons need fixed sample splits, quantization and decoding constraints. See [Test Specification](TEST_SPEC.md) and [Test Report](TEST_REPORT.md).
