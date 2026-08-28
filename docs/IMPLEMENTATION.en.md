[简体中文](IMPLEMENTATION.md) | English

# Implementation and Reproduction Status

This document describes the plugin architecture and its reproduction scope for DeepSeek-OCR (OCR1) and OCR-Memory. Platform-specific experiments live in [DEPLOYMENT.en.md](DEPLOYMENT.en.md).

## 1. Architecture

| Layer | Code | Responsibility |
|---|---|---|
| Optical memory engine | `lib/core.js` | segmentation, tier decay, retrieval, locating, caching, and atomic persistence |
| DSH entry | `lib/index.js` | configuration, backend clients, lifecycle, tool and context registration |
| Context snapshot | `lib/context.js` | bounded synchronous prompt context from the manifest |
| Governed adapter | `lib/memory-system.js`, `lib/governance.js` | L1/L2/L3 memory, namespaces, evidence, and provenance |
| Renderer | `scripts/render_memory.py` | square SoM images, numbered segments, CJK and long-text layout |
| Training helpers | `scripts/prepare_hotpotqa_locator.py`, `train_locator_unsloth.py`, `eval_locator.py` | locator data, LoRA training, evaluation, and alignment checks |

## 2. Data flow

### Write

Text is split by paragraphs and length, rendered as a numbered SoM image, and persisted alongside the original segments in `memories.json`. The source segments remain the sole authority for deterministic Fetch. A content/resolution change invalidates prior OCR, locator, and embedding evidence.

### Age and hit-frequency decay

The default `vivid → normal → fuzzy` tiers depend only on `createdAt`. With `dynamicDecayEnabled`, the store retains up to 32 access timestamps and computes:

```text
effectiveAge = age(createdAt) / boundedHeatMultiplier(recent access frequency)
```

Exponential weighting makes the multiplier decay smoothly and a hard cap prevents memories from becoming immortal. The option is off by default so an upgraded manifest keeps its previous tier behavior. Active recall remains separate: a hit on a low-resolution entry restores it to vivid for a short exemption window.

### Retrieval

Without a locator, the legacy path can combine text overlap, OCR evidence, and optional embeddings. With `opticalLocatorEnabled`:

1. the model emits K-bit `0/1` relevance labels for each SoM image;
2. `parseBinaryRelevance` validates labels and logprobs;
3. `selectRelevanceIndices` applies a probability threshold and Top-K fallback;
4. Fetch returns the selected persisted segments verbatim.

Strict mode rejects malformed locator output instead of silently switching to lexical scoring.

### Per-turn context

With `autoInjectContext`, the plugin registers `ocr1-memory:context` through DSH `systemPrompt.context()`. The synchronous provider reads only the manifest, ranks entries by hits and recency, and enforces `contextMaxEntries` and `contextMaxChars`. It never starts OCR, embeddings, retrieval, or network requests. Malformed manifests produce an empty contribution.

The option is off by default because dynamic context becomes model-visible session history. Enable it only when stored content is appropriate for automatic disclosure to the agent.

## 3. Key options

| Option | Default | Purpose |
|---|---:|---|
| `ocrBaseUrl` | empty | OpenAI-compatible `/v1/chat/completions` endpoint |
| `requireOcr` | `false` | fail instead of degrading when OCR is unavailable |
| `opticalLocatorEnabled` | `false` | enable the trained optical locating path |
| `opticalLocatorThreshold` | `0.4` | `p(1)` selection threshold |
| `opticalLocatorTopK` | `5` | fallback when no segment crosses the threshold |
| `opticalLocatorStrict` | `true` | reject malformed labels |
| `dynamicDecayEnabled` | `false` | enable recent-hit-aware tier aging |
| `decayMaxMultiplier` | `4` | maximum effective-age multiplier |
| `autoInjectContext` | `false` | add a bounded snapshot on prompt assembly |
| `contextMaxEntries` | `5` | maximum entries in that snapshot |
| `contextMaxChars` | `4000` | maximum snapshot characters |
| `embeddingRetrieval` | `false` | use visual embeddings as a retrieval signal |

The complete runtime schema is the `Config` object in `lib/index.js`.

## 4. Locator training and deployment

The training scripts convert question/distractor samples into SoM images and K-bit labels, then apply LoRA to the DeepSeek-OCR decoder while keeping the visual encoder frozen. Only the target digit positions are supervised, and training/inference share the same spaced binary grammar.

For deployment, merge the adapter into the base model and convert it to a format supported by the chosen multimodal backend. The runtime only requires an OpenAI-compatible chat endpoint. Model conversion, quantization findings, and service notes are in [DEPLOYMENT.en.md](DEPLOYMENT.en.md).

The included scripts establish an end-to-end engineering chain, not a claim to reproduce paper-scale tables.

## 5. Reproduction matrix

### DeepSeek-OCR

| Concept | Implementation | Degree |
|---|---|---|
| Optical 2D mapping | paragraph text → square SoM images | engineering approximation |
| Visual-token budget | official resolution-aligned tiers and endpoint-level usage | interface-level |
| DeepEncoder internals | no internal tensors or layer-wise token export from the runtime API | not reproduced |
| Visual embeddings | optional compatible endpoint; retrieval off by default | interface-level |

### OCR-Memory

| Concept | Implementation | Degree |
|---|---|---|
| SoM identifiers | numbered boxes and persistent segment indexes | implemented |
| Locate | LoRA-trained K-bit locator with strict grammar | implemented |
| Transcribe | deterministic verbatim Fetch by index | implemented |
| Age-aware resolution | `vivid → normal → fuzzy` rendering | implemented |
| Hit-frequency aging | bounded, opt-in access-frequency policy | implemented |
| Active recall | low-resolution hit restores vivid | implemented |
| Context exposure | bounded DSH dynamic-context snapshot | implemented, opt-in |

## 6. Explicit boundaries

This repository does not claim full reproduction of:

- DeepEncoder internal compression, tensors, or layer-wise visual-token counts;
- official internal multimodal embeddings;
- paper-scale training and Mind2Web/AppWorld/RULER evaluation;
- universal compatibility across hardware, drivers, quantization formats, and process supervisors.

These boundaries require model-internal access, larger data/evaluation resources, or different runtime conditions. They do not block the implemented SoM, locating, verbatim Fetch, tier aging, active recall, dynamic decay, or DSH context integration.

## References

- [DeepSeek-OCR repository](https://github.com/deepseek-ai/DeepSeek-OCR)
- [DeepSeek-OCR paper](https://arxiv.org/abs/2510.18234)
- [OCR-Memory](https://arxiv.org/abs/2604.26622)
- [DSH system-prompt dynamic context](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/system-prompt)
