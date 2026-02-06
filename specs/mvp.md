# Hadrix Flow v0.1 MVP

This MVP is a deterministic, offline-by-default tool that emits **flow facts** for JS/TS codebases.

## Inputs
- Source root (directory) and/or a `tsconfig.json`
- Jelly call graph output file (format documented/implemented by the project)

## Outputs
- JSONL flow facts (deterministic ordering, stable IDs)
- Optional call-chain witnesses (function-level)
- Optional per-function explain bundles (IR + edges + validation warnings)

## CLI (proposed)
- `hadrix-flow analyze --repo <path> --jelly <file> --out <facts.jsonl> [--witness <witness.jsonl>] [--explain <dir>]`

## Requirements
- Deterministic reruns: same inputs ⇒ identical outputs (cache included)
- Core pipeline does not depend on the LLM; LLM mode is optional and schema-validated
- Emits flow facts only (no vulnerability “findings”)

