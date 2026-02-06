# IMPLEMENTATION_PLAN.md

## Goal
Ship Hadrix Flow v0.1: a deterministic JS/TS flow-fact generator that ingests a Jelly call graph, produces intra-procedural summaries (cheap static pass first; optional hybrid LLM later), runs deterministic interprocedural propagation to a fixpoint, and emits machine-readable flow facts (not vulnerability “findings”).

Canonical spec: `ARCHITECTURE.md` (+ `specs/mvp.md`).

## Non-negotiables
- Deterministic core pipeline: stable IDs, canonical ordering, content-addressed caching
- Facts only: emit possible-flow facts (no vulnerability “findings” language)
- LLM (if added) is intra-procedural only and schema-validated; interprocedural propagation remains deterministic

## Scope Notes (v0.1)
- JS/TS only (TypeScript compiler API)
- Offline by default: no network calls in the default pipeline
- Call graph is ingested from a Jelly output file; no linking to Jelly (LGPL boundary)
- Output format: JSONL facts (SQLite deferred)

## Tasks (highest priority first; each checkbox should be doable in ONE build iteration)
- [x] Scaffold Node/TS CLI repo: `package.json`, `tsconfig.json`, `src/` skeleton, and a `hadrix-flow --help` CLI stub.
- [x] Add validation wiring: `npm test` + `npm run typecheck` scripts (choose a test runner) and a single smoke test.
- [x] Add determinism helpers: stable comparators/sorts, canonical JSON stringify, and a hashing helper (with unit tests).
- [x] Define core IDs: `FuncId`, `StmtId`, `CallsiteId`, `VarId`, `HeapId` with deterministic parse/stringify/compare (with unit tests).
- [x] Add a tiny TS fixture repo under `test/fixtures/basic/` (own `tsconfig.json`, a few functions/calls; no external deps).
- [x] Implement `analyze` command skeleton that loads a TS `Program` and emits an empty-but-valid facts JSONL file (deterministic ordering).
- [x] Implement TS project loader: resolve `--repo` and/or `--tsconfig`, normalize to repo-relative file paths, and produce a stable source-file list.
- [x] Implement function indexer: collect function-like nodes, assign stable `FuncId=(filePath,startOffset,endOffset)`, and expose lookup by span.
- [ ] Implement statement indexer: per-function linear statement list with stable `StmtId=FuncId+statementIndex` rules (documented in code/tests).
- [ ] Implement callsite indexer: enumerate call expressions per function, assign `CallsiteId` (aligned to `StmtId`), and record callsite spans.
- [ ] Define per-function IR schema + normalizer + stable IR serialization (unit tests; no builder yet).
- [ ] Implement stable IR hashing (hash of normalized IR + analysis config version) and a unit test for stability.
- [ ] Implement IR builder v1: assignments, returns, and direct calls into IR (unit tests on fixture).
- [ ] Implement IR builder v2: member reads/writes, optional chaining, and `await` lowering into IR (unit tests).
- [ ] Implement IR builder v3: ternary + short-circuit lowering into explicit IR constructs (unit tests).
- [ ] Implement cheap static pass v1: baseline dependency edges for `x=y`, `return y`, and call arguments (unit tests).
- [ ] Define heap bucketing rules and implement cheap static pass v2: member read/write edges via `HeapId=(allocationSiteId, propertyName|"*")` (unit tests).
- [ ] Define `FuncSummary` schema + validator + normalizer: reject unknown IDs/types, enforce type constraints, apply fanout/edge-count bounds, and require baseline-edge coverage.
- [ ] Implement on-disk summary cache (content-addressed by normalized IR hash + analysis config version) and cache read/write unit tests.
- [ ] Implement intra-proc summary pipeline (cheap-pass-only) that produces validated summaries and stores/loads them via the cache.
- [ ] Define `FlowFact` JSONL schema + deterministic JSONL writer (stable ordering + canonical serialization) with unit tests.
- [ ] Add `specs/jelly_callgraph.md` documenting the supported Jelly input format plus a minimal fixture call graph file for tests.
- [ ] Implement Jelly call graph ingestion + strict validation into an internal call graph model (tests use the fixture).
- [ ] Implement mapping: Jelly function nodes -> `FuncId` (path normalization + span matching) with clear diagnostics and strict/lenient mode.
- [ ] Implement mapping: Jelly call edges/callsites -> `CallsiteId` using callsite spans (diagnostics + unit tests).
- [ ] Implement deterministic fixpoint driver over the mapped call graph (unit tests with a tiny synthetic graph).
- [ ] Implement interproc propagation v1: arg->param and return->assignment lifting through callsites; emit param/return/callarg flow facts (unit tests).
- [ ] Implement interproc propagation v2: heap read/write effect lifting; emit heap-related flow facts (unit tests).
- [ ] Wire `hadrix-flow analyze --repo <path> --jelly <file> --out <facts.jsonl>` end-to-end on the fixture repo (facts only; no witnesses yet).
- [ ] Add determinism regression: run `analyze` twice (warm cache) and assert byte-identical facts output.
- [ ] Add optional `--witness <witness.jsonl>` to emit function-level call-chain witnesses (deterministic ordering).
- [ ] Add optional `--explain <dir>` to emit per-function explain bundles (IR + edges + validation notes; stable filenames).
- [ ] Add optional hybrid LLM intra-proc extractor interface (behind a flag; schema-validated with retry; mocked in tests; still offline-by-default).

## Done Criteria (v0.1)
- `hadrix-flow analyze` runs on a small TS fixture and emits stable JSONL flow facts.
- Deterministic reruns produce identical outputs (given same inputs and cache state).
- Core pipeline works without an LLM; if LLM mode exists, it is strictly optional and schema-validated.
- Output vocabulary stays in “flow facts” (no vulnerability “findings”).
