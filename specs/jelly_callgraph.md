# Jelly Call Graph Input (Supported Subset)

This document specifies the **supported input format** for a Jelly-produced call graph as consumed by Hadrix Flow.

We intentionally support a **small, deterministic subset** needed for:
- mapping Jelly function nodes to `FuncId` via `(filePath, startOffset, endOffset)`
- mapping Jelly call edges to `CallsiteId` via callsite spans

Canonical fixture: `test/fixtures/basic/jelly_callgraph.json`.

## File Format

The call graph input is a single UTF-8 JSON file:

```ts
type JellyCallGraphV1 = Readonly<{
  schemaVersion: 1;
  nodes: readonly JellyFunctionNodeV1[];
  edges: readonly JellyCallEdgeV1[];
}>;

type JellyFunctionNodeV1 = Readonly<{
  // Unique within this file. Opaque to Hadrix Flow.
  id: string;
  // Optional display name (diagnostics only).
  name?: string;

  // Repo-relative, POSIX-separated path (for example: "src/a.ts").
  filePath: string;

  // Offsets into the file text in TypeScript coordinates:
  // - `startOffset` matches `node.getStart(sourceFile, false)` (leading trivia excluded)
  // - `endOffset` matches `node.getEnd()`
  // Offsets are UTF-16 code unit indices into `sourceFile.text`.
  startOffset: number;
  endOffset: number;
}>;

type JellyCallEdgeV1 = Readonly<{
  callerId: string; // references JellyFunctionNodeV1.id
  calleeId: string; // references JellyFunctionNodeV1.id

  // Span of the call expression at the callsite.
  callsite: Readonly<{
    filePath: string; // repo-relative, POSIX-separated
    startOffset: number;
    endOffset: number;
  }>;

  // Optional edge kind; defaults to "call" if omitted.
  kind?: "call" | "construct";
}>;
```

## Validation Rules (v1)

In strict mode, Hadrix Flow will validate:
- `schemaVersion` is exactly `1`.
- top-level keys are exactly `schemaVersion`, `nodes`, `edges` (no unknown keys).
- `nodes[*].id` are unique.
- `nodes[*].filePath` and `edges[*].callsite.filePath` are non-empty, repo-relative, and use `/` separators.
- all offsets are non-negative safe integers, and `endOffset >= startOffset`.
- every `edges[*].callerId` / `calleeId` references an existing node id.
- no unknown keys in `nodes[*]`, `edges[*]`, or `edges[*].callsite`.

In lenient mode (planned), path normalization may attempt to:
- strip a repo-root prefix
- convert `\\` to `/`

## Notes

- This format is designed to be deterministic and easy to validate.
- Hadrix Flow does not depend on any other Jelly metadata (types, dynamic targets, etc.) in v0.1.

