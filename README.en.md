[简体中文](README.md) | English

# @dsh-external/dsh-ocr1-memory

A DSH optical memory system built on the ideas of **DeepSeek-OCR: Contexts Optical Compression** (arXiv:2510.18234).

Memories are no longer stored as plain text — they are **rendered into images (SoM-numbered segments) and kept that way**; older memories are progressively **downscaled by age (the older, the blurrier)**; when a low-resolution memory is retrieved, **active recall restores it to high resolution**; and the final result returns the **original verbatim segment** (Locate-and-Transcribe), avoiding generative hallucination.

## Capabilities

| Tool | Description |
|---|---|
| `ocr1_mem_status` | Status: store directory / OCR backend / entry count / render dependencies / tiers |
| `ocr1_mem_store` | Text → automatic segmentation → render SoM images → store into the memory bank |
| `ocr1_mem_update` | Update an existing memory, replacing it with new content and resetting it to vivid (conflict resolution) |
| `ocr1_mem_retrieve` | Retrieve by query: OCR reads images back + segment recall; low-res hits automatically trigger active recall |
| `ocr1_mem_list` | List memory entries (id / source / segment count / tier / hit count) |
| `ocr1_mem_metrics` | View compression metrics: text token count / visual token count / measured prompt_tokens |
| `ocr1_mem_calibrate` | Calibrate the OCR text baseline prompt_tokens for more accurate visual token estimation |
| `ocr1_mem_forget` | Delete a memory by id |
| `ocr1_mem_render_test` | Self-test for the rendering pipeline |
| `ocr1_mem_embed_test` | Self-test for visual embedding: returns a real 1280-dim DeepSeek-OCR embedding and the direct visual token count |

## Design (mapped to the OCR1 paper)

| OCR1 concept | Implementation in this plugin |
|---|---|
| Long text → optical 2D mapping | Text is automatically segmented by paragraph and rendered into images |
| Information carried by visual tokens | Resolution modes follow the official OCR1 design: `vivid 1280(≈400) → normal 1024(≈256) → fuzzy 640(≈100)`; interface-level visual token counts are recorded |
| Memories blur over time | Decay by `createdAt` age; older memories drop to lower resolution |
| Human vivid-to-fuzzy memory | The older a memory, the lower its resolution, while the semantic gist is preserved |
| Memory refresh | A low-res hit → active recall restores high resolution, with a decay exemption for a period of time |
| Avoiding hallucination | Locate-and-Transcribe style: returns the original verbatim segment; current locating is done via text scoring + OCR evidence, not the model directly outputting SoM numbers |
| OCR-driven recall | Even if the original tokens don't match, when DeepSeek-OCR reads keywords from an image → the memory is still recalled on OCR evidence and the original text is fetched |
| Visual embedding | Stores real DeepSeek-OCR 1280-dim visual vectors (`visualMemory.embedding`); at retrieval time the similarity between the query embedding and memory embeddings is the primary signal, combined with text segment locating |
| Render caching | AgentOCR-style segment hash cache; identical segment sets at the same resolution reuse images directly |

## Configuration

Override in the profile's cordis.patch.yml (bare entries):

```yaml
- id: dsh-ocr1-memory
  config:
    storeDir: ''                 # default <home>/.dsh/ocr1-memory
    ocrBaseUrl: ''               # DeepSeek-OCR vLLM/OpenAI-compatible endpoint; leave empty to skip OCR read-back
    ocrApiKey: ''
    ocrModel: 'deepseek-ai/DeepSeek-OCR'
    pythonPath: 'python'
    renderScript: '<plugin dir>/scripts/render_memory.py'
    requireOcr: false            # when true, OCR unavailability raises an error directly
    useMockRenderer: false       # when true, skips Python rendering (testing only)
    autoStartOcrServer: false    # when true, automatically ensures llama-server is online after the plugin loads
    ocrServerPath: ''            # path to llama-server.exe; leave empty for the default
    ocrModelDir: ''              # DeepSeek-OCR GGUF directory; leave empty for the default
    ocrServerPort: 18080         # OCR server port
    ocrEmbeddingBaseUrl: ''      # usually the same as ocrBaseUrl (combined mode); falls back to ocrBaseUrl automatically if empty
    ocrEmbeddingApiKey: ''
    ocrEmbeddingModel: ''        # falls back to ocrModel if empty
    ocrEmbeddingTimeoutMs: 120000
    ocrEmbeddingEmptyPromptTokens: 1  # prompt_tokens baseline for an empty-text embedding
    ocrEmbeddingAutoStart: false       # only needs to be true when embeddings use a separate server
    ocrEmbeddingPort: 18084            # standalone embedding server port (unused in combined mode)
    ocrEmbeddingUbatchSize: 2048       # must be >= the visual token count of a single image (default 512 rejects large images)
    ocrEmbeddingServerPath: ''         # path to llama-server.exe used for embeddings
    ocrEmbeddingModelDir: ''           # GGUF directory used for embeddings
    ocrEmbeddingOnDemand: true         # only effective when embeddings use a separate server; in combined mode port 18080 is reused directly
    ocrEmbeddingIdleTimeoutMs: 300000  # how long (ms) the embedding server idles before auto-shutdown
    ocrEmbeddingContextSize: 2048      # embedding server context (no long generation needed; 2048 is enough)
    sharedStore: false                 # when true, memories.json is re-read before every operation, supporting multiple Agents sharing one store
    embeddingRetrieval: true           # when true, 1280-dim visual embedding similarity is the primary retrieval signal (with ocrEmbeddingBaseUrl)
    ocrMaxEntriesPerRetrieve: 5        # when text retrieval falls short of topK, the max number of memories to OCR read back (prevents large stores from stalling retrieval)
```

## Installation

```bash
# Install from GitHub (recommended)
dsh plugin --profile web add github:DDDFXYqiming/dsh-ocr1-memory

# headless (self-test)
dsh plugin --profile headless add github:DDDFXYqiming/dsh-ocr1-memory
```

For local development, you can also use the repository directory directly:

```bash
dsh plugin --profile web add <this directory>
```

Runtime injection (no restart needed, for development):

```text
dev_inject_plugin <this directory>
```

## Hooking up a real DeepSeek-OCR

This plugin abstracts the OCR backend behind an OpenAI-compatible `/v1/chat/completions` (vLLM already supports DeepSeek-OCR).

```bash
# Example: serve DeepSeek-OCR with vLLM
python -m vllm.entrypoints.openai.api_server \
  --model deepseek-ai/DeepSeek-OCR \
  --max-model-len 16384
```

Then set `ocrBaseUrl` to `http://127.0.0.1:8000/v1` and retrieval will actually go through the optical read-back path.

Local AMD route (llama.cpp):

```bash
# One-shot startup / ensure the DeepSeek-OCR llama-server is online
node scripts/ensure-ocr-server.mjs 18080
# or manually
powershell -File scripts/start-ocr-server.ps1
```

Default backend address: `http://127.0.0.1:18080/v1`, with the model defaulting to `deepseek-ocr-Q4_K_M.gguf` (`DeepSeek-OCR-Q8_0.gguf` can also be set via `ocrModelDir`/script arguments).

### Real visual embeddings (DeepSeek-OCR embeddings endpoint)

llama.cpp's `/v1/embeddings` supports multimodal input (`prompt_string` + `multimodal_data`). The current `llama-server` build **provides both `/v1/chat/completions` and `/v1/embeddings`** under `--embeddings --pooling mean`, so a single server can handle both OCR and visual embeddings:

```bash
# Option 1: use start-ocr-server.ps1 (combined mode is enabled by default)
powershell -File scripts/start-ocr-server.ps1 -Port 18080

# Option 2: manual startup (-ub must exceed the visual token count of a single image; the default 512 rejects large images)
llama-server.exe --host 127.0.0.1 --port 18080 --embeddings --pooling mean \
  -m <model_dir>\deepseek-ocr-Q4_K_M.gguf \
  --mmproj <model_dir>\mmproj-deepseek-ocr-q8_0.gguf \
  --alias deepseek-ocr -c 8192 -np 1 -n 1024 -b 2048 -ub 2048
```

Then set `ocrEmbeddingBaseUrl` to the same `http://127.0.0.1:18080/v1` as `ocrBaseUrl` (it also falls back to `ocrBaseUrl` automatically if unset). The plugin stores a **real 1280-dim visual embedding** for every memory and reports the "direct visual token count" (a media-marker-only request, `prompt_tokens - empty-text baseline`).

## Gaps versus the DeepSeek OCR1 paper

The current implementation is an **engineering approximation of OCR1's ideas**, not a complete replication of the paper's internal mechanisms:

1. **DeepEncoder's internal compression is not replicated**
   - Paper: DeepEncoder actually compresses document images into a small number of visual tokens, then hands them to DeepSeek-3B for decoding.
   - Current: uses llama.cpp's OCR/embeddings interfaces for optical read-back and visual vector storage; visual token counts come from interface statistics, not DeepEncoder's internal tensor outputs.

2. **Locate-and-Transcribe is an engineering approximation**
   - Paper/OCR-Memory: the model directly outputs the SoM number (Locate), then the original text is fetched (Transcribe).
   - Current: locating relies on text token overlap scoring + OCR evidence; the original verbatim segment is returned to avoid generative hallucination, but it is not "the model outputting a number".
   - The LoRA fine-tuning part — making the model output SoM numbers — is intentionally **out of scope** per the project goals.

3. **Visual embedding is already the primary retrieval signal (engineering implementation)**
   - `visualMemory.embedding` already stores real 1280-dim visual vectors;
   - At retrieval time, memories are first ranked by cosine similarity between the query embedding and memory embeddings, then text segment locating runs within the hit memories;
   - This is closer to the paper's "retrieve with visual representations" direction than pure text scoring, but still not DeepEncoder's internal compression.

4. **Visual token counts are interface-level direct measurements**
   - `visualTokensDirect` is obtained via a marker-only request to the embeddings endpoint;
   - Not DeepEncoder's internal layer-by-layer explicit outputs.

## Currently running services and conditions for further progress

- Services actually required right now:
  - `18080`: the DeepSeek-OCR combined server, providing both `/v1/chat/completions` (OCR read-back) and `/v1/embeddings` (1280-dim visual embedding / embedding retrieval).
- The standalone `18084` is no longer needed; the exploratory leftovers on `18081/18082/18083` have all been shut down.
- Verified boundaries for further progress:
  - Getting DeepSeek-OCR to output SoM numbers directly without fine-tuning: unreliable on the current llama.cpp backend (outputs unrelated text), so the paper's original Locate requires LoRA to advance.
  - DeepEncoder's internal compression pipeline / internal layer-by-layer visual token counts: not obtainable through llama.cpp's public interfaces.
  - Multimodal embeddings depend on llama.cpp extensions; on an AMD environment without NVIDIA/vLLM there is no way to switch to the official DeepEncoder outputs.
- Conditions that would enable further progress:
  - If LoRA fine-tuning is allowed: the "model outputs SoM numbers" Locate capability can be added.
  - With an NVIDIA/vLLM environment available: DeepEncoder's internal compression, internal visual token outputs, and official multimodal embeddings can be aligned further.

## Development and testing

```bash
npm run build        # node --check
npm test             # 47 tests (including complex isolation tests + real OCR/embedding + robustness, if the backend is online)
npm run test:smoke   # local end-to-end smoke test (real Python rendering + mock OCR)
node scripts/compare-memory.mjs  # compare dsh-ocr1-memory vs dsh-memory (isolated temp environments)
dsh --profile headless --dump-config   # verify the plugin tier is assembled
```

## Test and comparison results

- `npm test`: **47/47 passing**.
- Robustness: multi-Agent shared store, recovery from missing images / corrupted cache, and extra-long input boundaries all pass.
- Comparison benchmark (`scripts/compare-memory.mjs`, isolated headless + official stock DSH):
  - dsh-ocr1-memory: all of R1–R6 PASS.
  - dsh-memory: all of R1–R6 PASS this run; but R5 previously FAILed in manual verification (`memory_archive`d entries were still readable via `memory_read`), with unstable behavior.
  - Conclusion: dsh-ocr1-memory never fell behind dsh-memory.

## Roadmap

- [ ] LoRA fine-tune the DeepSeek-OCR decoder for SoM retrieval (the OCR-Memory approach), turning retrieval into "the model outputs a number" instead of text scoring
- [x] AgentOCR-style segment optical caching (hash-based segment caching to reduce rendering cost; `.render-cache` reuse implemented)
- [x] Compression metrics and OCR text baseline calibration (`ocr1_mem_metrics` / `ocr1_mem_calibrate`)
- [x] Explicit memory updates (`ocr1_mem_update`, conflict resolution)
- [x] Automatically ensure the OCR server is online (`autoStartOcrServer`)
- [x] Isolated benchmark against dsh-memory (R1–R6 fully re-run with the corrected script; dsh-ocr1-memory all PASS)
- [x] Real DeepSeek-OCR visual embedding storage (1280-dim, `visualMemory.embedding`)
- [x] Direct visual token measurement (embeddings endpoint marker-only request, `visualMemory.visualTokensDirect`)
- [x] Multi-Agent shared store (`sharedStore` + reload + atomic save)
- [x] Automatic recovery from missing images / corrupted render cache
- [x] Extra-long input boundary tests
- [ ] Hit-frequency-driven dynamic decay strategy
- [ ] Auto-inject `/context` so Agents see a memory summary each turn

## References

- DeepSeek-OCR (OCR1): <https://arxiv.org/abs/2510.18234> · <https://github.com/deepseek-ai/DeepSeek-OCR>
- OCR-Memory (method blueprint, not open-sourced): <https://arxiv.org/abs/2604.26622>
- AgentOCR (engineering reference, open-sourced): <https://github.com/langfengQ/AgentOCR>
