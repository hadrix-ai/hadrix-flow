# Hadrix Flow — Architecture
Flow fact generation for JS/TS (infrastructure, not a vulnerability scanner)

Status: Draft (hybrid-first; derived from `DISCUSSION.md`) • Last updated: 2026-02-05

---

## 1) Purpose

Hadrix Flow is a **JS/TS-only** static analysis system that emits **possible dataflow facts** (not “findings”).

Primary use case:
- Provide accurate-enough **dataflow hints** to drive high-precision detection of issues like **SQL injection** and **command injection** in a downstream security scanner.

Key constraints:
- **Single engineer** friendly
- **No Semgrep rules / Semgrep Cloud**
- **Call graph is provided** by `cs-au-dk/Jelly`
- **LGPL constraints respected** by invoking external engines as subprocesses (no linking)

Key goals:
- Produce **interprocedural** “possible-flow” edges (exact paths are optional)
- Emit structured **flow facts** usable as infrastructure for downstream tools

Non-goals:
- Determining exploitability / reachability / “is this a vuln”
- Perfect precision or full language soundness
- Owning the full vulnerability policy surface (sources/sinks/sanitizers); that belongs in a versioned “policy pack” consumed by the scanner

---

## 2) High-Level Architecture (Recommended)

The recommended architecture is **Hybrid SAST + LLM** (default mode):
- **Deterministic** parsing, IDs, interprocedural propagation, and outputs
- **LLM is constrained** to *intra-procedural* summary extraction only, under strict schemas + validation
- A downstream scanner combines these facts with a **policy pack** (sources/sinks/sanitizers) and a **verifier** to achieve high true-positive rates

```mermaid
flowchart LR
  subgraph HF[Hadrix Flow (fact engine)]
    A[JS/TS Source] --> B[TS Parser + Symbol/Span Index]
    C[Jelly Call Graph] --> D[Func/Callsite Resolver]
    B --> E[Per-Function IR Builder]
    D --> E

    E --> F[Cheap Static Pass]
    F --> H[LLM Summary Extractor (intra-proc only)]
    H --> J[Validation + Normalization]
    J --> K[Summary Cache]

    K --> L[Interprocedural Propagation (Fixpoint)]
    C --> L
    L --> M[Flow Facts Store]
    L --> N[Optional Call-Chain Witnesses]
  end

  subgraph SC[Security Scanner (consumer)]
    P[Policy Pack: sources/sinks/sanitizers] --> Q[Source→Sink Candidate Query]
    M --> Q
    Q --> V[Verifier (deterministic + optional LLM-on-slice)]
    V --> R[Issues / Findings]
  end
```

---

## 3) Core Concepts & IDs

All downstream phases depend on stable identifiers.

### Function identity
`FuncId = (filePath, startOffset, endOffset)`
- Used to align TypeScript AST functions with Jelly call graph nodes
- Stable across runs as long as code spans are stable

### Statement / callsite identity
`StmtId = FuncId + statementIndex` (or start/end offsets)
`CallsiteId = StmtId` for call expressions

### Local variables and parameters
`VarId` are **function-scoped** IDs assigned deterministically:
- `p0..pN` for parameters
- `v0..vM` for locals/temporaries

### Heap buckets (coarse)
Heap is modeled as buckets, not precise objects:
- `HeapId = (allocationSiteId, propertyName)`
- Use `"*"` for dynamic/unknown keys

---

## 4) Pipeline Stages

### 4.1 Deterministic frontend (always on)
Responsibilities:
- Parse JS/TS using the TypeScript compiler API
- Build scope/symbol tables and span mappings
- Index functions and generate `FuncId`
- Ingest Jelly call graph and map nodes/callsites to `FuncId` / `CallsiteId`

Outputs:
- Function index (`FuncId` ↔ AST node)
- Call graph edges keyed by `FuncId` / `CallsiteId`

### 4.2 IR construction (bounded, schema-friendly)
Build a *linearized* IR per function (avoid raw source where possible):
- assignments (`x = y`, `x = f(...)`)
- calls (`f(a,b)`)
- returns (`return expr`)
- member reads/writes (`x = obj.p`, `obj.p = y`)
- await / promise-like constructs (`await x`)
- short-circuiting / ternary constructs represented explicitly

Design principle: IR should be stable, compact, and easy to validate.

### 4.3 Cheap static pass (always on)
Extract “obvious” dependency edges without an LLM:
- `x = y` → `y → x`
- `return y` → `y → return`
- `f(a,b)` → `a → callArg(0)`, `b → callArg(1)`
- `obj.p = y` → `y → heapWrite(bucket)`
- `x = obj.p` → `heapRead(bucket) → x`

This pass provides:
- A baseline signal
- Guardrails for LLM validation
- Useful results even when LLM is disabled

### 4.4 Intra-procedural summaries (hybrid-first)

Use the LLM to *extract* structured summary facts from the IR:
- LLM sees only:
  - IR
  - declared IDs (`p*`, `v*`, `h*`, `s*`)
  - allowed edge types
- LLM outputs a strict schema describing dependency edges and summary flags

LLM must not:
- invent IDs, control flow, or new heap buckets
- decide reachability or “findings”
- emit line-level paths

Optional fallback:
- A deterministic intra-procedural analyzer can exist as a baseline/regression tool, but hybrid is the primary path.

### 4.5 Validation and normalization (required for hybrid)
Validation rules (minimum):
- Reject unknown IDs or unknown edge types
- Reject edges that violate type constraints (e.g., `return → param`)
- Enforce edge count / fanout bounds to prevent “edge explosions”
- Ensure mandatory baseline edges from the cheap pass are present (or explainable)

Retry strategy:
- If validation fails, re-prompt with the errors and request a corrected output
- Record the final accepted summary + any warnings for debugging

### 4.6 Summary cache (required)
Cache key:
- Hash of the normalized IR (+ analysis configuration version)

Cache value:
- Validated, normalized function summary facts

Caching is essential for:
- cost control
- incremental analysis
- stabilizing outputs across runs

### 4.7 Interprocedural propagation (deterministic fixpoint)
Inputs:
- Jelly call graph
- per-function summaries

Propagation:
- Map callee summary facts through callsites:
  - actual arguments ↔ formal parameters
  - return values ↔ assignment targets
  - heap bucket effects merged with global bucket IDs
- Iterate to a fixpoint (optionally with limited context sensitivity)

Optional witnesses:
- Call-chain witnesses are feasible (function-to-function chains)
- Line-level path witnesses require extra bookkeeping and are deferred

---

## 5) Output Model (Flow Facts)

Outputs are **facts**, not findings. Typical fact categories:
- `PARAM_TO_RETURN`: `p_i → return`
- `PARAM_TO_CALLARG`: `p_i → callArg(callsite, j)`
- `PARAM_TO_HEAPWRITE`: `p_i → heapWrite(h_k)`
- `HEAPREAD_TO_RETURN`: `heapRead(h_k) → return`

Recommended properties:
- All facts reference stable IDs (`FuncId`, `CallsiteId`, `HeapId`)
- Machine-readable format (JSONL or SQLite)
- Deterministic ordering for diffability

---

## 6) How These Facts Enable Injection Detection

Hadrix Flow’s job is to produce a reusable, queryable “flow graph”. To reach CodeQL-like *detection quality* for a narrow set of issues (e.g., SQLi/command injection), the consumer typically adds:

1) **Policy pack (versioned)**
- A continuously updated catalog of:
  - **sources** (req params, headers, cookies, env, message queues, etc.)
  - **sinks** (DB/query APIs, `child_process.exec*`, `spawn` with `shell:true`, templating, etc.)
  - **sanitizers/safe APIs** (parameterized queries, query builders, escaping/allowlists, safe wrappers)
- Kept separate from the engine to avoid coupling release cadences and ownership.

2) **Candidate query (high recall)**
- Deterministically compute `source → … → sink` candidates using flow facts + call-chain witnesses.
- Apply policy constraints (e.g., sanitizer blocks, safe APIs short-circuit).

3) **Verifier (high precision)**
- For each candidate, extract a small evidence bundle (call chain + per-function explain data) and run:
  - deterministic checks (API-level safety conditions, known-safe query builders, `shell:true` guards), and/or
  - an optional LLM-on-slice verifier (schema-constrained, cached) to confirm “is this actually user-controlled at the sink?”

This split is what keeps the engine small and deterministic while still supporting high-precision security findings.

---

## 7) Module Boundaries (Suggested)

This is a suggested code organization to match the architecture:
- `frontend/`: TS parsing, symbol/span index, `FuncId` generation
- `callgraph/`: Jelly ingestion, callsite ↔ callee mapping
- `ir/`: per-function IR and normalization
- `intraproc/`: cheap static pass + (optional) deterministic analyzer
- `llm/`: prompting, schema, validation, retry logic (hybrid mode)
- `cache/`: content-addressed summary cache
- `interproc/`: fixpoint propagation and fact emission
- `facts/`: output schemas + writers (JSONL/SQLite)
- `explain/`: per-function explain bundles (IR + edges + validation notes)

Key design principle: **Interprocedural propagation must not depend on the LLM.**

---

## 8) Determinism, Debuggability, and Safety

Determinism levers:
- Stable IDs and canonical IR normalization
- Cached summaries keyed by IR hash
- Strict schemas + validation for any LLM-derived output

Debuggability:
- Emit per-function “explain” bundles: IR, extracted edges, validation warnings
- Make it easy to diff summaries across versions

Safety boundaries:
- LLM is never allowed to emit final “findings”
- LLM is constrained to intra-proc extraction; interproc remains deterministic

---

## 9) Roadmap (Optional Enhancements)

- Context sensitivity knobs (call-string depth, type-based partitioning)
- Better heap bucketing (prototype chains, arrays, index signatures)
- Async/callback modeling improvements (promises, event handlers)
- Exact line-level witnesses (path reconstruction) if required by downstream users
- Benchmark/eval harness with labeled fixtures to track precision/recall across policy-pack versions
- Candidate slice extraction format optimized for verifier consumption (deterministic + cacheable)
