[简体中文](README.md) | English

# @dsh-external/dsh-ocr1-memory

**Optical memory extension for DeepSeek Harness (DSH) based on DeepSeek-OCR Contexts Optical Compression (OCR1).**

Implements the cutting-edge "Contexts Optical Compression" (OCR1) architecture from the DeepSeek-OCR research paper into practical agent engineering. Text memories are partitioned into coherent paragraphs, formatted, and rendered as visual images tagged with Set-of-Mark (SoM) indicators. By encoding verbose context into compact visual tokens, it achieves dramatic context reduction alongside dynamic decay and active recall mechanisms that guarantee lossless verbatim retrieval.

---

## Architectural Highlights

* **Optical Context Compression**: Transcends standard text buffers and vector databases by rendering memory paragraphs into dense visual layouts. Leverages multimodal visual tokens to encapsulate long-horizon history at vastly lower token footprints.
* **Resolution Tier Decay & Active Recall**:
  * **Three Progressive Decay Tiers**: Historical memory images gracefully degrade across `vivid (full res)` → `normal (standard)` → `fuzzy (low footprint)` based on access age.
  * **Active Recall Restoration**: Query hits on decayed entries automatically trigger Active Recall, restoring the asset to high-resolution before subsequent inspection.
* **SoM Labeling & Optical Locator**:
  * Employs numbered visual bounding markers compatible with an optional on-device optical locator (powered by GGUF/llama-server).
  * The model outputs concise K-bit `0/1` visual classifications to filter candidate segments, culminating in zero-loss verbatim text retrieval.
* **Real-Time Efficiency Metrics**: Includes the `ocr1_mem_metrics` tool to benchmark raw text tokens against visual tokens, reporting actual optical compression multipliers.
* **Enterprise Memory Governance**: Shares the unified three-tier memory governance framework (L1 index compaction, history snapshots, and cross-namespace promotions).

---

## Processing Flow

```
[Verbatim Text] ──> [Partition & Layout] ──> [Render SoM Images] ──> [Resolution Tier Decay]
                                                                                │
                                                                                ▼
[Lossless Original Text] <── [Source Text Retrieval] <── [Locator / OCR Read] <── [Query Trigger (Active Recall)]
```

---

## Tool Overview

| Tool Name | Core Role | Implementation |
| :--- | :--- | :--- |
| `ocr1_mem_store` | Partitions, renders SoM images, and registers optical memory | Rendering & indexing pipeline |
| `ocr1_mem_retrieve` | Hybrid optical/text retrieval with Active Recall restoration | Optical recall engine |
| `ocr1_mem_metrics` | Measures text tokens, visual tokens, and compression ratios | Evaluation telemetry |
| `ocr1_mem_update` | Rewrites memory content and resets decay aging | Incremental re-rendering |
| `ocr1_mem_calibrate`| Calibrates tokenizer baseline for accurate compression ratios | Baseline benchmarking |
| `ocr1_mem_forget` | Erases specified memory entries and on-disk visual assets | Complete asset purge |
| `memory_read` / `write` | Unified governance endpoints across layered memory systems | Governance parity |

---

## Installation & Setup

```bash
# Install via DSH Plugin Manager
dsh plugin --profile web add github:DDDFXYqiming/dsh-ocr1-memory
```

For local development:
```bash
git clone https://github.com/DDDFXYqiming/dsh-ocr1-memory.git
cd dsh-ocr1-memory
npm install && npm run build
dsh plugin --profile web add .
```

---

## Configuration

Adjust optical engine endpoints in your profile's `cordis.patch.yml`:

```yaml
- id: dsh-ocr1-memory
  config:
    memoryDir: '~/.dsh/memory'         # Storage path for memory and rendered assets
    ocrModel: 'deepseek-ai/DeepSeek-OCR' # OCR model identifier
    requireOcr: false                  # Halt execution if OCR is offline (no silent fallbacks)
    maintenanceBatchSize: 8            # Maximum batch count for scheduled optical sweeps

    # Optional local llama-server process lifecycle
    autoStartOcrServer: false          # Allow plugin to supervise OCR server process
    ocrServerPort: 18080               # Listening port
    ocrServerPath: ''                  # llama-server binary path
    ocrModelDir: ''                    # Directory containing GGUF weights

    # Optional optical locator
    opticalLocatorEnabled: false       # Enable rapid visual classification filtering
    opticalLocatorThreshold: 0.4       # Confidence score threshold
    opticalLocatorTopK: 5              # Top-K candidate pool
```

---

## License

This project is open-sourced under the [MIT License](LICENSE).
