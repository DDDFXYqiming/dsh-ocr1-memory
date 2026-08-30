[Chinese](../docs/IMPLEMENTATION.md) | English

# Implementation and Reproduction Status

This document describes the plugin architecture and its reproduction scope for DeepSeek-OCR (OCR1) and OCR-Memory. Platform-specific experiments live in [DEPLOYMENT.md](DEPLOYMENT.md), and the research log is in [EXPLORATION.md](EXPLORATION.md).

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

### 2.1 Write

1. Input text is split by blank lines and length into ordered segments, starting at segment id 1.
2. The renderer draws the segments into a numbered square SoM image; the original segments are written to `memories.json` as the sole source for deterministic Fetch.
3. The image cache key includes content, resolution, and renderer version. A content or tier change invalidates OCR, locator, and embedding evidence.
4. OCR readback is optional: with `requireOcr: false`, the text path remains available without an OCR client; with `requireOcr: true`, missing or failed OCR readback is reported.
5. Persistent visual embeddings are generated only when `embeddingRetrieval: true`; `ocr1_mem_embed_test` can still probe a configured embedding client independently.

### 2.2 Tiers and hit frequency

The default tiers are:

- `vivid`: high-resolution representation of a fresh memory;
- `normal`: representation after the first age transition;
- `fuzzy`: low-resolution representation of a long-term memory.

The base policy uses only `createdAt`. With `dynamicDecayEnabled`, up to 32 access timestamps are retained and recent hits contribute a bounded exponential multiplier:

```text
effectiveAge = age(createdAt) / boundedHeatMultiplier(recent access frequency)
```

The multiplier is capped and decays smoothly as accesses become old. It does not modify `createdAt` or keep a memory permanently high-resolution. The option is disabled by default so upgrading an existing store preserves its tier behavior. A hit on a low-resolution memory still triggers active recall and a short vivid grace period.

### 2.3 Retrieval

Without a locator, the plugin uses the legacy path of text overlap, OCR readback evidence, and optional embeddings. With `opticalLocatorEnabled`, the flow is:

1. request K-bit `0/1` relevance labels for each current SoM image;
2. strictly parse labels and logprobs with `parseBinaryRelevance`;
3. apply the default `0.4` threshold with Top-K fallback through `selectRelevanceIndices`;
4. Fetch the selected original segments by index from `memories.json` and return them verbatim.

Locator requests use an OpenAI-compatible interface. The image appears at the front of the message with the training-consistent newline prefix, temperature 0, logprobs, and llama.cpp GBNF constraints. With `opticalLocatorStrict` enabled, malformed output fails instead of falling back to text scoring.

### 2.4 Per-turn context snapshots

With `autoInjectContext` enabled, the entry registers `ocr1-memory:context` through DSH `systemPrompt.context()`. The provider synchronously reads the manifest, ranks entries by hit count and recent access, truncates segment text, and enforces `contextMaxEntries` and `contextMaxChars`.

The provider reads disk only; it performs no OCR, embedding, retrieval, or network request. A malformed manifest produces an empty string without blocking Prompt assembly. `list`, `status`, and metrics likewise project the current manifest without rendering or network work. Explicit maintenance migrates stale tiers in batches of at most `maintenanceBatchSize` entries. Maintenance is single-flight per namespace; duplicate calls report `already-running`, cancellation reaches renderer/OCR/embedding, and disposal cancels and drains owned work. Reports expose `remaining` and `complete` for later batches.

## 3. Key options

| Option | Default | Purpose |
|---|---:|---|
| `maintenanceBatchSize` | `8` | maximum stale or missing-image entries rerendered by one maintenance run |
| `ocrBaseUrl` | empty | OpenAI-compatible `/v1/chat/completions` endpoint; an explicit port controls auto-start |
| `requireOcr` | `false` | fail instead of silently degrading when OCR is unavailable |
| `autoStartOcrServer` | `false` | have the plugin ensure `llama-server` is online, deduplicated by endpoint |
| `ocrServerPath` / `ocrModelDir` | empty | executable and model directory for auto-start; environment overrides are supported |
| `ocrServerPort` | `18080` | fallback launch port when the URL has no explicit port |
| `ocrEmbeddingBaseUrl` | empty | embedding endpoint; falls back to `ocrBaseUrl` |
| `ocrEmbeddingAutoStart` | `false` | auto-start a separate embedding endpoint at plugin load |
| `ocrEmbeddingOnDemand` | `true` | start a separate embedding endpoint on first use |
| `ocrEmbeddingPort` | `18084` | fallback port for a separate embedding endpoint |
| `ocrEmbeddingUbatchSize` | `2048` | physical batch limit for embedding server startup |
| `ocrEmbeddingContextSize` | `2048` | context size for combined/separate embedding startup |
| `ocrEmbeddingIdleTimeoutMs` | `300000` | idle shutdown delay for on-demand separate embedding |
| `ocrMaxEntriesPerRetrieve` | `5` | maximum entries sent through OCR per retrieval |
| `opticalLocatorEnabled` | `false` | enable the trained optical locating path |
| `opticalLocatorThreshold` | `0.4` | `p(1)` selection threshold |
| `opticalLocatorTopK` | `5` | fallback when no segment crosses the threshold |
| `opticalLocatorStrict` | `true` | reject malformed labels |
| `dynamicDecayEnabled` | `false` | enable recent-hit-aware tier aging |
| `decayFrequencyWindowMs` | 7 days | smoothing window for hit frequency |
| `decayRecencyHalfLifeMs` | 14 days | half-life for recent-access weight |
| `decayHitWeight` | `1` | hit-frequency weight in the multiplier |
| `decayMaxMultiplier` | `4` | maximum effective-age multiplier |
| `autoInjectContext` | `true` | inject a bounded context each turn (`contextMode: index` for L1/optical metadata, `snapshot` for full-body snapshots) |
| `contextMaxEntries` | `5` | maximum entries in the snapshot |
| `contextMaxChars` | `4000` | maximum snapshot characters |
| `sharedStore` | `false` | reload the manifest before each operation |
| `embeddingRetrieval` | `false` | enable visual-embedding retrieval signals |

The remaining renderer options (`pythonPath`, `renderScript`, repetition controls), locator limits/timeouts, embedding API settings, and text-token baseline are defined in the `Config` object in `lib/index.js`.

When OCR and embeddings share an endpoint, the plugin uses one combined startup specification. A separate embedding endpoint can be started on demand and stopped after `ocrEmbeddingIdleTimeoutMs`. Only plugin-started processes with recorded PIDs are stopped during disposal; an already-running external service is left alone.

## 4. Locator training and deployment chain

The training scripts convert question/distractor samples into SoM images and K-bit binary labels, then apply a LoRA adapter to the DeepSeek-OCR decoder. The visual encoder remains frozen. Training supervises only the target label interval and uses the same `digit space ...` output grammar as inference.

For deployment, merge the adapter into the base model and convert it to a format supported by the target multimodal backend. Runtime requires an OpenAI-compatible `/v1/chat/completions` endpoint with the corresponding image input. Model conversion, quantization choices, service parameters, and validated end-to-end examples are documented in [DEPLOYMENT.md](DEPLOYMENT.md).

The repository includes data preparation, training, evaluation, and alignment-check scripts, but small-scale local training is not paper-table reproduction; full scale requires the paper's datasets and evaluation suites.

## 5. Reproduction matrix

### 5.1 DeepSeek-OCR (OCR1)

| Paper concept | Plugin implementation | Degree |
|---|---|---|
| Long text to optical 2D mapping | paragraph → square SoM image | engineering approximation |
| Visual tokens carry information | resolution-aligned tiers and endpoint-level token statistics | interface-level approximation |
| DeepEncoder internal compression | no internal tensors or layer-wise token export from the llama.cpp public interface | not reproduced |
| Official visual embeddings | persisted through a compatible embedding endpoint; disabled as the primary retrieval signal by default | interface-level |

### 5.2 OCR-Memory

| Method concept | Plugin implementation | Degree |
|---|---|---|
| SoM numbered segments | numbered boxes and persistent segment indexes | implemented |
| Locate | LoRA locator emits K-bit binary labels with strict grammar decoding | implemented |
| Transcribe | persistent verbatim text returned by segment index | implemented |
| Age-aware multi-resolution | `vivid → normal → fuzzy`, with age-based rerendering | implemented |
| Hit-frequency decay | bounded, optional, backward-compatible recent-hit policy | implemented, disabled by default |
| Active recall | low-resolution hit restores vivid | implemented |
| Threshold and Top-K | default threshold with no-hit fallback; union rules can be selected | implemented |
| Per-turn memory context | L1/optical metadata, full-body snapshots optional via `contextMode: snapshot` | implemented, enabled by default (index mode) |

## 6. Explicit boundaries

This repository does not claim full reproduction of:

- DeepEncoder internal compression, layer-wise visual-token counts, or internal tensor visualization;
- paper-scale training data and Mind2Web/AppWorld/RULER main-table evaluation;
- multimodal embeddings fully equivalent to the official internal DeepEncoder representation;
- universal compatibility across any specific hardware, driver, quantization format, or service supervisor.

These boundaries arise from public runtime interfaces, model formats, and available resources. They do not block the engineering implementation of SoM, locating, deterministic Fetch, age tiers, active recall, optional dynamic decay, or DSH context integration.

## 7. Related documents

- [README](../README.en.md): quick start;
- [DEPLOYMENT](DEPLOYMENT.md): backend deployment and platform validation;
- [STATUS](STATUS.md): current status;
- [BENCHMARK](BENCHMARK.md): isolated benchmark;
- [EXPLORATION](EXPLORATION.md): research and experiment log;
- [TEST_SPEC](TEST_SPEC.md) / [TEST_REPORT](TEST_REPORT.md): test specification and results; the current full regression is 88/88 with a healthy live backend.
- [Paper mapping](../docs/2510.18234-paper-vs-plugin-verifiable-concepts.md): paper-native mechanisms, engineering extensions, and acceptance boundaries.

