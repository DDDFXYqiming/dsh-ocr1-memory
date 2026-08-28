[Chinese](../docs/TEST_REPORT.md) | English

# dsh-ocr1-memory Test Report

> Goal: Continuously test and fix the plugin in an isolated temporary environment until it stably implements the memory system effects of DeepSeek-OCR1 (Contexts Optical Compression).
> This document is continuously updated. All tests use isolated temporary directories and do not contaminate `~/.dsh/ocr1-memory`.

## Test Environment

| Item | Value |
|---|---|
| Plugin directory | `<Agent_Extensions>\dsh-plugins\dsh-ocr1-memory` |
| Actual OCR backend | `http://127.0.0.1:18080/v1` (llama-server + DeepSeek-OCR Q4_K_M + mmproj q8_0) |
| Actual Embedding backend | Shares `http://127.0.0.1:18080/v1` with OCR (combined `--embeddings --pooling mean`) |
| Sampling parameters | `temperature=0`, `repeat_penalty=1.2`, `no_repeat_ngram_size=30` |
| Rendering | Python + Pillow + CJK fonts (Microsoft YaHei/SimHei) |
| Isolation method | Each test uses an independent `mkdtemp` directory, which is automatically deleted after the test |

## Current Passing Status

| Suite | Result |
|---|---|
| `npm test` (codified) | 70/70 passed |
| Core and context unit tests | 14/14 passed |
| Complex isolation tests (T1–T24) | 24/24 passed |
| OCR HTTP / rendering cache tests | 2/2 passed |
| Embedding tests (E1–E5) | 5/5 passed |
| Locator tests (L1–L8) | 8/8 passed |
| Governance layer and cancellation signal tests | 7/7 passed |
| Rendering geometry tests (RG1–RG2) | 2/2 passed |
| OCR server lifecycle tests | 2/2 passed |
| Robustness tests (M1–M6) | 6/6 passed |
| Actual OCR / Embedding isolation tests | PASS (T6/T15/T16/T21/T23/T24/E4, requires llama-server) |

## Unit Test Coverage

- `splitSegments`: blank-line segmentation, consecutive ids, oversized paragraph splitting
- `scoreSegment`: match, no match, empty text
- `tierIndexFor`: vivid/normal/fuzzy age boundaries
- Dynamic decay: disabled by default, recent frequency, smooth expiration, multiplier cap, and injected clock
- context snapshots: heat-based sorting, character limit, fault tolerance for empty/corrupted manifest
- store + retrieve: verbatim return, OCR text writing
- active recall: fuzzy → vivid
- OCR-driven recall: recall still occurs when the original text does not match but OCR does
- OCR HTTP client: OpenAI-compatible `/v1/chat/completions` integration
- Rendering cache: image reuse for the same segment collection + resolution

## Complex Isolation Test Coverage

| ID | Scenario | Result |
|---|---|---|
| T1 | Time travel: fuzzy → match → vivid | PASS |
| T2 | Upgrade only the 1 matched memory among 30 fuzzy memories | PASS |
| T3 | Multi-topic memory retrieval without cross-interference | PASS |
| T4 | Accurately match the target segment among 50 segments of large text | PASS (after fix) |
| T5 | Chinese/English/Japanese/Emoji/special symbols | PASS |
| T6 | Actual DeepSeek-OCR image reading remains stable across 3 consecutive runs | PASS |
| T7 | OCR backend unavailable: strict mode errors / lenient mode degrades | PASS |
| T8 | JSON remains intact after 20 concurrent store operations | PASS |

## Issues Found and Fixed

### 1. Retrieval Score Contamination (Exposed by T4)

**Symptom**: When querying `unique-key-37`, all irrelevant segments containing `unique`/`key` were elevated into topK by the aggregate score of the entire memory, pushing target segment 37 out.

**Cause**: `retrieveSegments` used `Math.max(segScore, est.score * 0.5)` for every literal-matching segment, where `est.score` was the aggregate score of the entire memory, causing all segments containing generic terms to receive artificially high scores.

**Fix**:
- Literal-matching segments now directly use the segment-level score `segScore`;
- The OCR aggregate score is used only for “OCR fallback recall when the original text has no match” and no longer contaminates ordinary segment scores.

**Regression**: T4 passed; core and context unit tests 14/14.

### 2. Resolution Tiers Were Not Aligned with Official OCR1 Modes

**Change**: `DEFAULT_TIERS` was adjusted from `1024/768/512` to:

```
vivid  1280 → 400 tokens (corresponding to OCR1 Large)
normal 1024 → 256 tokens (corresponding to OCR1 Base)
fuzzy  640  → 100 tokens (corresponding to OCR1 Small)
```

**Reason**: This more closely matches the native resolution modes in the DeepSeek-OCR paper.

## Embedding Test Coverage

| ID | Scenario | Result |
|---|---|---|
| E1 | `measureImageEmbedding` requests through a media marker and returns embedding / direct visual token count | PASS |
| E2 | Memory store saves the actual multimodal embedding and `visualTokensDirect` | PASS |
| E3 | Falls back to pixel embedding and records `embeddingError` when the embedding backend fails | PASS |
| E4 | Actual DeepSeek-OCR embeddings backend generates a 1280-dimensional visual embedding | PASS |
| E5 | With embedding retrieval enabled: the memory with the closer vector ranks first | PASS |

Actual E4 measurement: `prompt_tokens=785` (marker-only), empty-text baseline `prompt_tokens=1`, direct visual tokens=784, embedding dimension=1280.

## Actual OCR Isolation Test Record

```
ISOLATED_REAL_TEST_PASS
storeDir=temporary directory (deleted)

Input text:
Orbit API requires login and a token.

OCR readback (excerpt):
"### Question Content
**Orbit API requires login and a token.**
..."

Retrieval result:
[entryId=..., segmentId=1, score=1.00, tier=vivid]
content: "Orbit API requires login and a token."
```

## Second Round of Complex Isolation Tests

| ID | Scenario | Result |
|---|---|---|
| T9 | Path traversal safety: source injection with `../` and absolute paths | PASS |
| T10 | Safely rebuild an empty database after `memories.json` corruption | PASS |
| T11 | Long-run stability across 500 rounds of store/retrieve/forget | PASS |
| T12 | 10-way concurrent active recall matching the same target | PASS (after fix) |
| T13 | Resolution modes aligned with OCR1: 1280/1024/640 | PASS |
| T14 | Compression ratio metric: textTokens / visualTokens | PASS |
| T15 | Actual OCR records `usage.prompt_tokens` | PASS |
| T16 | Actual OCR approximate visual token count / approximate compression ratio | PASS |
| T17 | update conflict resolution: the old value is overwritten by the new value | PASS |
| T18 | Selective forgetting: retrieval no longer finds the deleted item | PASS |
| T19 | Cross-session persistence: retrieval still works after rebuilding the store | PASS |
| T20 | Measured visual token usage calibrated with a text-only baseline | PASS |
| T21 | text-only prompt_tokens calibration request | PASS |
| T22 | store with the same source automatically updates to the latest value | PASS |
| T23 | optical memory stores visual token metadata | PASS |
| T24 | Rendered image generation and visual embedding storage (64-dimensional pixel embedding when no embeddings backend is available) | PASS |

## Robustness Test Coverage (M1–M6)

| ID | Scenario | Result |
|---|---|---|
| M1 | Multi-Agent shared store: two store instances see each other’s new memories through reload | PASS |
| M2 | Atomic save: no `.tmp` residue after multiple writes | PASS |
| M3 | Automatically rerender and recover after an image file is lost | PASS |
| M4 | Fall back to a fresh render when the rendering cache is corrupted (cache path replaced by a directory) | PASS |
| M5 | Oversized multi-paragraph input (>200KB) is segmented, stored, and retrieves the target | PASS |
| M6 | No data loss after splitting an oversized single paragraph (approximately 250KB) | PASS |

## Issues Found and Fixed (Second Round)

### Concurrent active recall Rendering Race (Exposed by T12)

**Symptom**: When multiple concurrent retrieve operations matched the same fuzzy memory, rendering cache writes reported `EBUSY: resource busy or locked`.

**Cause**: Multiple asynchronous rendering operations wrote/copied to the same output path simultaneously.

**Fix**:
- Added `renderLocks` inside `createMemoryStore`, so concurrent rendering for the same `outputPath` executes only once;
- Cache writes were changed to best-effort, so failures do not block the main flow.

**Regression**: T12 passed; core and context unit tests 14/14.

## Issues Found and Fixed (Third Round: DSH-Level R5/R6 Validation)

### DSH Tool Output schema Strictness (Exposed by R5)

**Symptom**: When the headless Agent called `ocr1_mem_store` / `ocr1_mem_list`, it reported "invalid output" because the returned object contained fields not declared in the schema (`updated` / `ocrText` / `visualMemory`).

**Fix**:
- Added `updated: boolean` to the `ocr1_mem_store` output schema;
- `ocr1_mem_list` now returns only schema-declared fields in execute;
- Removed null optional fields from `ocr1_mem_metrics` to avoid rejection by the strict schema.

**Regression**: DSH-level R5 ran again without invalid output; result PASS.

## Automatic OCR Service Startup Validation

**Manual fault-recovery validation**:

1. Stop llama-server;
2. Run `node scripts/ensure-ocr-server.mjs 18080`;
3. Result: `OCR server started: http://127.0.0.1:18080/v1`;
4. Then all `npm test` tests passed.

**Fix record**:
- Initially, when spawning through a PowerShell script, `stdio:'ignore'` and backslash paths prevented the service from starting;
- It worked stably after changing to spawn `llama-server.exe` directly.

## Comparison Benchmark: dsh-ocr1-memory vs dsh-memory

- Design document: `BENCHMARK.md`
- Execution script: `scripts/compare-memory.mjs`
- Isolated environment: two temporary stores + mutually exclusive plugin disabling via `--patch`
- Result: R1–R6 were fully rerun using the corrected `scripts/compare-memory.mjs`; dsh-ocr1-memory passed all tests, and dsh-memory also passed all tests in this run (R5 had previously failed during manual validation because it remained readable after archiving, indicating unstable behavior). No case was observed where dsh-ocr1-memory lagged behind dsh-memory.

## Future Plans

- [x] Codify the complex test script as `test/complex.test.mjs` and include it in `npm test`
- [x] Automatically start the OCR service (`lib/ocr-server.js` + `autoStartOcrServer`)
- [x] Comparison benchmark script `scripts/compare-memory.mjs`
- [x] Multi-Agent shared store (`sharedStore` + reload + atomic save)
- [x] Image-missing/cache-corruption recovery tests
- [x] Oversized-input boundary tests (>200KB multi-paragraph + oversized single paragraph)
- [ ] Oversized input (10MB) and memory pressure
- [x] LoRA locator training/evaluation scripts and merged deployment chain: see `DEPLOYMENT.md`
- [x] Direct visual token count: measured through an embeddings endpoint marker-only request (`visualMemory.visualTokensDirect`)
- [x] Dynamic decay based on match frequency (disabled by default, preserving old-database behavior)
- [x] Optional `systemPrompt.context()` memory-summary injection (disabled by default)
- [ ] Paper-scale training and complete main-table evaluation
- [ ] Internal per-layer DeepEncoder token/embedding export

## Test Conclusions and Scope of Applicability

### 1. Conclusion

Under the current operating conditions on this machine, the memory system’s core closed loop works correctly:

```text
store → SoM image and original-text persistence → tier refresh → retrieval → segment Fetch → verbatim return
```

The scope of evidence is as follows:

| Capability | Conclusion | Evidence |
|---|---|---|
| Text storage, segmentation, persistence, update, and forgetting | Confirmed | Core tests, T8/T10/T17–T19/T22, M1–M2 |
| SoM rendering, resolution tier, aging, and active recall | Confirmed | T1/T2/T13/T14, RG1–RG2, M3–M4 |
| Actual OCR image reading | Confirmed with the current configuration | T6/T15/T16/T21/T23/T24 |
| Visual embedding | Confirmed with the current configuration | E1–E5; E4 used the actual backend to return a 1280-dimensional vector |
| Optical location protocol and verbatim Fetch | Confirmed | L1–L8; the previous DSH isolated closed loop R1–R6 passed |
| Dynamic decay and context snapshots | Confirmed | Core/context tests; both are disabled by default |
| DSH plugin loading | Confirmed | Host injection passed; runtime status returned `OK` |

`npm test` currently has **70/70 passed**, and `npm run build`, `npm run test:smoke`, and the Markdown link check also passed. Tests use isolated temporary stores; this does not mean that every model, quantization format, backend, or production dataset requires no additional acceptance testing.

### 2. Conclusion for Operation Without a Discrete GPU

The memory system itself does not require a local discrete GPU:

- The DSH plugin’s Node.js logic, JSON persistence, tier management, context snapshots, and Python/Pillow rendering can all be handled by the CPU;
- OCR, Locate, and visual embedding are external services. The currently validated operating configuration is Windows **CPU-only llama.cpp**; OCR and embedding share one CPU service and do not depend on the RX 7800 XT discrete GPU;
- If no OCR backend is configured and `requireOcr=false`, the text-memory path still works; corresponding services are needed only when OCR, Locate, or visual embedding is required;
- LoRA training is a separate development process. A discrete GPU was used during local training, but ordinary operation does not require retraining, so it is not a runtime dependency.

An integrated GPU is not required. If llama.cpp with a Vulkan backend is used, the integrated GPU can serve as an optional acceleration device. However, the actual operating evidence in this report covers the CPU-only path; the current plugin’s complete OCR/embedding/location chain has not yet been separately accepted on the integrated GPU. To ensure that the discrete GPU is not used, point `OCR_SERVER_PATH`/`ocrServerPath` to a CPU-only `llama-server`; generic PATH resolution does not select the GPU or integrated GPU for you.

This only means that the **OCR1 memory service** does not depend on a discrete GPU; whether other primary models used by DSH occupy the discrete GPU is a separate path unrelated to this plugin.
