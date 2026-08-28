[Chinese](../docs/TEST_SPEC.md) | English

# Agent Memory System Test Specification (Research and Mapping)

> Objective: identify available "simple, general-purpose agent memory test specifications" and map the current isolated dsh-ocr1-memory vs dsh-memory comparison to those specifications.

## 1. Research Conclusions

Agent memory benchmarks/specifications commonly used by the community include:

| Benchmark/Specification | Core Capabilities | Metrics |
|---|---|---|
| **MemoryAgentBench** (arXiv:2507.05257) | Accurate Retrieval, Test-Time Learning, Long-Range Understanding, Conflict Resolution | Substring Exact Match, Recall, classification accuracy, Latest-fact Exact Match |
| **LongMemEval** | Single-session user/assistant/preference recall, Knowledge update, Temporal reasoning, Multi-session recall | Accuracy, Latency, Token consumption |
| **LoCoMo** | Single-hop, Multi-hop, Open-domain, Temporal memory recall | BLEU/F1, LLM judge, Latency |
| **BEAM / AMB** | Ultra-long context, preference/instruction following, information extraction, knowledge updates, multi-session reasoning, conflict resolution, cost/latency | Accuracy, Token consumption, Latency |

In simplified form, **a practical, general-purpose minimum test set** usually includes:

1. **Accurate Retrieval**: store a fact and query it; the original key content must be returned.
2. **Test-time Learning**: store a user rule/preference and subsequently answer according to that rule.
3. **Long-range Understanding / Long-list Retrieval**: store multiple facts and retrieve the target entry accurately without interference.
4. **Conflict Resolution / Update**: after a new value supersedes an old value for the same subject, the latest value should be returned.
5. **Selective Forgetting**: after deletion/archival, an entry should no longer be returned by ordinary retrieval.
6. **Multi-session Persistence**: content written in the first session can be read in a second independent session.

## 2. Mapping of the Current Comparison Tests

The R1–R6 tasks in `scripts/compare-memory.mjs` and `BENCHMARK.md` map as follows:

| Task | Corresponding General Specification | Pass Criterion |
|---|---|---|
| R1 Accurate Retrieval | MemoryAgentBench AR / LongMemEval single-session recall | The returned content contains all key tokens |
| R2 Test-time Learning | MemoryAgentBench TTL / LongMemEval preference recall | The returned content contains the key parts of the rule |
| R3 Long-range Understanding | MemoryAgentBench LRU / LoCoMo multi-hop | The 17th entry is accurately retrieved from 20 entries |
| R4 Conflict Resolution | MemoryAgentBench CR / LongMemEval knowledge update | The latest value, `B`, is returned |
| R5 Selective Forgetting | MemoryAgentBench selective forgetting / LongMemEval knowledge deletion | Retrieval returns NOT_FOUND after deletion |
| R6 Multi-session Persistence | LongMemEval multi-session recall | The second independent session retrieves the content written by the first |

## 3. Isolated Environment Requirements

- Use the same stock official DSH installation and headless profile;
- Profile A: enable only `dsh-ocr1-memory`;
- Profile B: enable only `dsh-memory`;
- Each profile uses a temporary store/memoryDir created with `mkdtemp`, which is cleaned up after the run;
- Do not modify the default `~/.dsh/ocr1-memory` or `~/.dsh/memory`;
- Do not kill processes: the script defaults to `COMPARE_TIMEOUT_MS=0` (no timeout kill); use a background task for observation when necessary.

## 4. Current Results Summary

| Task | dsh-ocr1-memory | dsh-memory |
|---|---|---|
| R1 | PASS | PASS |
| R2 | PASS | PASS |
| R3 | PASS | PASS |
| R4 | PASS | PASS |
| R5 | PASS | PASS in this script run; a previous manual verification failed (the entry remained readable through `memory_read` after archival), indicating unstable behavior |
| R6 | PASS | PASS |

Conclusion: no case was found in which dsh-ocr1-memory underperformed dsh-memory; dsh-memory's R5 result is unstable because it depends on whether the Agent chooses physical deletion or archival.

## 5. Reference Links

- MemoryAgentBench: https://arxiv.org/abs/2507.05257
- LongMemEval: https://arxiv.org/abs/2410.10813
- LoCoMo: https://arxiv.org/abs/2402.17753
- AMB / Agent Memory Benchmark: https://github.com/vectorize-io/agent-memory-benchmark
- Mem0 State of AI Agent Memory: https://mem0.ai/blog/state-of-ai-agent-memory-2026
