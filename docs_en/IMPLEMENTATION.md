[Chinese](../docs/IMPLEMENTATION.md) | English

# Implementation and Reproduction Scope

This document follows the code to describe the plugin architecture, data flow, configuration, and training entry points. Platform deployment is covered in [DEPLOYMENT.md](DEPLOYMENT.md), and experiments are recorded in [EXPLORATION.md](EXPLORATION.md).

## 1. Architecture and data flow

| Layer | Code | Responsibility |
|---|---|---|
| Optical memory engine | `lib/core.js` | segmentation, SoM rendering, tier decay, retrieval, locating, caching, and concurrent persistence |
| DSH entry | `lib/index.js` | configuration, OCR/embedding clients, service lifecycle, tool and context registration |
| Context / L1 | `lib/context.js` | bounded synchronous L1 and optical metadata context, or body snapshots |
| Memory governance | `lib/memory-system.js`, `lib/governance.js` | L1/L2/L3, namespaces, evidence, provenance, and the OCR1 store |
| Automatic maintenance | `lib/automation.js`, `lib/skill-content.js` | runtime skill, pending candidates, turn/end maintenance, and threshold reminders |
| Rendering and training | `scripts/` | SoM images, CJK layout, locator data, LoRA training, and evaluation |

On write, input is split by blank lines and length into ordered segments. The renderer creates a numbered square SoM image, while the source text is written to `memories.json`. The image cache key includes content, resolution, and renderer version, so a content or tier change invalidates OCR, locator, and embedding evidence. `requireOcr` controls the text fallback, and `embeddingRetrieval` controls persistent visual embeddings.

The default tiers are `vivid`, `normal`, and `fuzzy`. The base policy uses `createdAt`; `dynamicDecayEnabled` keeps up to 32 access records and lets recent hits affect effective age within a cap. It does not change `createdAt`. A low-resolution hit triggers active recall. `list`, `status`, and metrics only read the current manifest.

Without a locator, retrieval uses text overlap, OCR evidence, and optional embeddings. With `opticalLocatorEnabled`, each SoM image receives a K-bit `0/1` request. `parseBinaryRelevance` validates the response, `selectRelevanceIndices` applies the threshold and Top-K fallback, and the plugin fetches the original segment from `memories.json`. Locator requests use an OpenAI-compatible interface and can enable temperature 0, logprobs, and llama.cpp GBNF constraints. `opticalLocatorStrict` rejects malformed results.

`autoInjectContext` registers dynamic context through DSH's `systemPrompt.context()`. `index` injects the L1 locator index and optical metadata; `snapshot` keeps body snapshots. The provider reads disk only and performs no OCR, embedding, retrieval, or network request. A malformed manifest produces empty context. `memory_maintain` and automatic maintenance run single-flight per namespace, process at most `maintenanceBatchSize` entries, support cancellation, and report `remaining` and `complete`.

Automatic governance records failure-then-success sequences at `turn/end` and creates pending candidates. A candidate becomes formal memory only after `memory_accept` or an evidence-backed `memory_write`.

## 2. Key configuration

| Option | Default | Purpose |
|---|---|---|
| `memoryDir` | `~/.dsh/memory` | root for L1/L2/L3, pending, archive, and history |
| `maxIndexLines` | `30` | L1 index line limit |
| `autoNamespace` | `true` | resolve a namespace from workspace or git context |
| `autoPending` | `true` | create pending candidates from failure-then-success sequences |
| `maintainEveryTurns` | `20` | automatic maintenance interval, `0` disables it |
| `maintenanceBatchSize` | `8` | stale or missing-image entries handled per run |
| `reflectPendingThreshold` | `5` | pending reminder threshold |
| `reflectSopsThreshold` | `40` | active-SOP reminder threshold |
| `ocrBaseUrl` | empty | OpenAI-compatible `/v1/chat/completions` endpoint |
| `ocrModel` | `deepseek-ai/DeepSeek-OCR` | OCR backend model name |
| `requireOcr` | `false` | fail when OCR is unavailable |
| `autoStartOcrServer` | `false` | ensure llama-server is online by endpoint |
| `ocrServerPath` / `ocrModelDir` | empty | executable and model directory for auto-start |
| `ocrServerPort` | `18080` | launch port when the URL has none |
| `ocrEmbeddingBaseUrl` | empty | embedding endpoint, falling back to `ocrBaseUrl` |
| `ocrEmbeddingOnDemand` | `true` | start a separate embedding service on first use |
| `ocrEmbeddingPort` | `18084` | default port for a separate embedding service |
| `ocrMaxEntriesPerRetrieve` | `5` | entries sent through OCR per retrieval |
| `opticalLocatorEnabled` | `false` | enable the trained locator path |
| `opticalLocatorThreshold` | `0.4` | `p(1)` selection threshold |
| `opticalLocatorTopK` | `5` | fallback count when no threshold hit exists |
| `opticalLocatorStrict` | `true` | reject malformed labels |
| `opticalLocatorAutoStart` | `false` | auto-start a separate locator endpoint |
| `opticalLocatorServerPort` | `18081` | default locator launch port |
| `dynamicDecayEnabled` | `false` | enable recent-hit-aware aging |
| `autoInjectContext` | `true` | inject bounded context each turn |
| `contextMode` | `index` | choose metadata or body-snapshot context |
| `contextMaxEntries` | `5` | context entry limit |
| `contextMaxChars` | `4000` | context character limit |
| `sharedStore` | `false` | reload the manifest before each operation |
| `embeddingRetrieval` | `false` | use visual embeddings for retrieval |

Renderer options, locator timeouts and segment limits, embedding API settings, and the text-token baseline are defined in the `Config` object in `lib/index.js`. Shared OCR and embedding endpoints use one startup specification. Separate services can start on demand and stop after the idle timeout. Disposal stops only plugin-started processes with recorded PIDs.

## 3. Locator training and reproduction scope

The training scripts convert question-and-distractor samples into SoM images and K-bit labels, then train a LoRA adapter on the DeepSeek-OCR decoder while keeping the visual encoder frozen. Training supervises the target label interval and uses the same `digit space ...` grammar as inference. For deployment, merge the adapter into the base model and convert it to a format supported by the target multimodal backend. Complete parameters and validated examples are in [DEPLOYMENT.md](DEPLOYMENT.md).

Small-scale local training covers data preparation, training, evaluation, and label-alignment checks. It does not reproduce the paper's main table. Full scale requires the paper data, complete evaluation suites, and a long-running inference service.

| Paper concept | Plugin implementation | Current assessment |
|---|---|---|
| Long text to optical 2D mapping | paragraphs become square SoM images | engineering approximation |
| Visual tokens carry information | tiers and endpoint-level token statistics | interface-level approximation |
| DeepEncoder internal compression | public HTTP interface exposes no internal tensors | not reproduced |
| Official visual embeddings | persisted through a compatible embedding interface | interface-level |
| SoM, Locate, and Transcribe | numbered segments, strict labels, indexed source fetch | implemented |
| Age-aware tiers and active recall | `vivid → normal → fuzzy` and low-resolution recovery | implemented |
| Hit-frequency decay | bounded optional recent-hit policy | implemented, disabled by default |
| Threshold, Top-K, and per-turn context | selection rules and L1/optical metadata context | implemented |

The current release does not claim layer-wise DeepEncoder tensors, paper-scale training or main-table evaluation. It also does not promise universal compatibility across hardware, drivers, quantization formats, or service supervisors. These limits follow from public interfaces, model formats, and available resources; the SoM, locating, deterministic Fetch, tiers, active recall, optional decay, and DSH context remain usable independently.

## 4. Related documents

- [README](../README.en.md) quick start
- [DEPLOYMENT.md](DEPLOYMENT.md) backend deployment and platform validation
- [STATUS.md](STATUS.md) current status
- [BENCHMARK.md](BENCHMARK.md) isolated benchmark
- [EXPLORATION.md](EXPLORATION.md) research and experiment log
- [TEST_SPEC.md](TEST_SPEC.md) and [TEST_REPORT.md](TEST_REPORT.md) test specification and results
- [Paper mapping and plugin boundaries](2510.18234-paper-vs-plugin-verifiable-concepts.md)
