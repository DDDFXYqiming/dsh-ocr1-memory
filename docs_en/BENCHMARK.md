[Chinese](../docs/BENCHMARK.md) | English

# Agent Memory Benchmark: dsh-ocr1-memory vs dsh-memory

## Basis

This benchmark references memory benchmarks commonly used by the community:

- **MemoryAgentBench** (ICLR 2026): four core capabilities
  - accurate retrieval
  - test-time learning / rule acquisition
  - long-range understanding
  - selective forgetting / conflict resolution
- **LongMemEval**: single-session recall, preference recall, knowledge update, temporal reasoning, multi-session recall
- **AMB**: emphasizes agentic tasks + token cost / latency

## Comparison Objective

In isolated environments using the same stock official DSH installation and headless profile:

- Profile A: enables only `dsh-ocr1-memory`
- Profile B: enables only `dsh-memory`
- Each uses an independent temporary store directory, which is cleaned up after the run
- Task prompts are identical, but each profile may use its own memory tools

## Test Tasks

### R1: Accurate Retrieval
- Store one explicit fact, for example: `The Orbit API token expires after 10 minutes`
- Query that fact
- Pass criterion: the returned content contains `Orbit API` and `10 minutes`

### R2: Test-time Learning
- Store a user rule/preference, for example: `The user requires all replies to be in Chinese`
- Query that rule later
- Pass criterion: the returned content contains the key parts of the rule

### R3: Long-range Understanding
- Store 20 different facts and query the 17th fact
- Pass criterion: the 17th fact is retrieved, and no other fact is incorrectly reported as the answer

### R4: Conflict Resolution / Update
- First store: `The server address is A`
- Then store: `The server address has changed to B`
- Query the current server address
- Pass criterion: the latest value, `B`, is returned, or at minimum both the old and new entries are exposed so that the upper layer can decide

### R5: Selective Forgetting
- Store temporary information
- Remove it with a forget/delete/archive tool
- A subsequent retrieval should return NOT_FOUND

### R6: Multi-session Persistence
- Store a fact in the first independent DSH invocation
- Retrieve that fact in a second independent DSH invocation that shares the same temporary store
- Pass criterion: the second invocation retrieves the content stored by the first

## Scoring Metrics

| Metric | Description |
|---|---|
| Exact Hit | The returned content contains all key tokens |
| Partial Hit | The returned content contains some key tokens |
| Miss | Nothing is returned, or the returned content is irrelevant |
| Latency | Seconds from task start to response |
| Store Pollution | Whether the default `~/.dsh/...` was written to (should always be false) |

## Isolation Method

- Each profile uses a temporary `--patch` overlay to:
  - disable the other memory plugin
  - point storeDir/memoryDir to a temporary directory created with `mkdtemp`
- Delete the temporary directory after testing
- Do not modify `~/.dsh/ocr1-memory` or `~/.dsh/memory`

## Example Execution Commands

```bash
# Profile A (dsh-ocr1-memory only)
dsh --profile headless \
  --patch disable-memory.yml \
  --patch ocr1-temp-store.yml \
  "<task prompt>"

# Profile B (dsh-memory only)
dsh --profile headless \
  --patch disable-ocr1.yml \
  --patch memory-temp-store.yml \
  "<task prompt>"
```

## Measured Results (Isolated Temporary Environment)

Execution script: `scripts/compare-memory.mjs`

| Task | dsh-ocr1-memory | dsh-memory |
|---|---|---|
| R1 Accurate Retrieval | ✅ PASS (2/2), 27.8s | ✅ PASS (2/2), 14.5s |
| R2 Test-time Learning | ✅ PASS (1/1), 10.9s | ✅ PASS (1/1), 19.3s |
| R3 Long-range Understanding | ✅ PASS (1/1), 333.9s | ✅ PASS (1/1), 42.6s |
| R4 Conflict Resolution | ✅ PASS (1/1), 35.6s | ✅ PASS (1/1), 27.0s |
| R5 Selective Forgetting | ✅ PASS (retrieval returned NOT_FOUND after `ocr1_mem_forget`) | ✅ PASS (in this script run); ⚠️ a previous manual verification failed (the entry remained readable after `memory_archive`) |
| R6 Multi-session Persistence | ✅ PASS (two independent DSH invocations shared a store; the second retrieved “The user likes drinking coffee”) | ✅ PASS (two independent DSH invocations shared memoryDir; the second retrieved the entry) |

Conclusions:
- dsh-ocr1-memory passed R1–R6;
- dsh-memory also passed R1–R6 in this complete script run, but its R5 result is unstable: when the Agent chooses `memory_archive`, the entry remains readable through `memory_read`; it passes only when physical deletion is chosen;
- The current tests found no case in which dsh-ocr1-memory underperformed dsh-memory;
- Regarding latency, dsh-ocr1-memory was significantly slower on R3 among R1/R2/R3 because optical retrieval performs OCR on each of the 20 memories; performance was mixed on the remaining tasks;
- Note: both systems returned `B` for R4; dsh-ocr1-memory now provides the explicit `ocr1_mem_update`, making conflict resolution more reliable.

## Extended R5/R6 Status

- R5 (Selective Forgetting) and R6 (Multi-session Persistence) have been added to the design of `scripts/compare-memory.mjs`.
- A complete DSH-level comparison has been performed in an isolated headless environment, using background execution without killing the process:
  - During manual R5/R6 verification, dsh-ocr1-memory used the complete OCR + embedding configuration (equivalent to `COMPARE_WITH_EMBEDDING=1`);
  - R5: dsh-ocr1-memory passed; dsh-memory passed in this script run, but a previous manual verification failed because an archived entry remained readable through `memory_read`, indicating unstable behavior.
  - R6: both systems passed.
- `scripts/compare-memory.mjs` enables OCR readback by default but disables per-entry embedding so that storage-heavy tasks such as R3 with 20 entries do not become excessively slow; set `COMPARE_WITH_EMBEDDING=1` to enable complete embedding.
- Core-layer tests also cover:
  - T18: Selective Forgetting (an entry cannot be retrieved after deletion)
  - T19: Multi-session Persistence (an entry remains retrievable after rebuilding the store)

## Expectations

- If dsh-ocr1-memory performs significantly worse than dsh-memory on most tasks, further optimization is required.
- Known risk: dsh-ocr1-memory explicitly supports update/conflict handling, but it still requires validation in more complex scenarios.
