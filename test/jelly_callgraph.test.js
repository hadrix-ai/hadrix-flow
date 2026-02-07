import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadJellyCallGraphFromFile, normalizeJellyCallGraph } from "../src/jelly_callgraph.ts";

test("loadJellyCallGraphFromFile loads and validates the fixture", () => {
  const fixturePath = fileURLToPath(new URL("./fixtures/basic/jelly_callgraph.json", import.meta.url));
  const g = loadJellyCallGraphFromFile(fixturePath);

  assert.equal(g.schemaVersion, 1);
  assert.equal(g.nodes.length, 6);
  assert.equal(g.edges.length, 5);

  const n = g.nodeById.get("a_id");
  assert.ok(n);
  assert.equal(n.filePath, "src/a.ts");
  assert.equal(n.startOffset, 0);
  assert.equal(n.endOffset, 46);

  // Kind is always present (defaults to "call" when omitted).
  for (const e of g.edges) assert.equal(e.kind, "call");
});

test("normalizeJellyCallGraph rejects unknown keys (top-level)", () => {
  assert.throws(
    () =>
      normalizeJellyCallGraph({
        schemaVersion: 1,
        nodes: [],
        edges: [],
        extra: 1,
      }),
    /unknown key/i,
  );
});

test("normalizeJellyCallGraph rejects duplicate node ids", () => {
  assert.throws(
    () =>
      normalizeJellyCallGraph({
        schemaVersion: 1,
        nodes: [
          { id: "n1", filePath: "src/a.ts", startOffset: 0, endOffset: 1 },
          { id: "n1", filePath: "src/a.ts", startOffset: 2, endOffset: 3 },
        ],
        edges: [],
      }),
    /duplicate id/i,
  );
});

test("normalizeJellyCallGraph rejects edges referencing missing nodes", () => {
  assert.throws(
    () =>
      normalizeJellyCallGraph({
        schemaVersion: 1,
        nodes: [{ id: "n1", filePath: "src/a.ts", startOffset: 0, endOffset: 1 }],
        edges: [
          {
            callerId: "n1",
            calleeId: "missing",
            callsite: { filePath: "src/a.ts", startOffset: 10, endOffset: 12 },
            kind: "call",
          },
        ],
      }),
    /unknown node id/i,
  );
});

test("normalizeJellyCallGraph rejects unknown keys (callsite)", () => {
  assert.throws(
    () =>
      normalizeJellyCallGraph({
        schemaVersion: 1,
        nodes: [{ id: "n1", filePath: "src/a.ts", startOffset: 0, endOffset: 1 }],
        edges: [
          {
            callerId: "n1",
            calleeId: "n1",
            callsite: { filePath: "src/a.ts", startOffset: 10, endOffset: 12, extra: true },
            kind: "call",
          },
        ],
      }),
    /unknown key/i,
  );
});

test("normalizeJellyCallGraph sorts nodes and dedupes edges", () => {
  const g = normalizeJellyCallGraph({
    schemaVersion: 1,
    nodes: [
      { id: "b", filePath: "src/b.ts", startOffset: 0, endOffset: 1 },
      { id: "a", filePath: "src/a.ts", startOffset: 0, endOffset: 1 },
    ],
    edges: [
      {
        callerId: "b",
        calleeId: "a",
        callsite: { filePath: "src/b.ts", startOffset: 10, endOffset: 20 },
      },
      {
        callerId: "b",
        calleeId: "a",
        callsite: { filePath: "src/b.ts", startOffset: 10, endOffset: 20 },
        kind: "call",
      },
    ],
  });

  assert.deepEqual(
    g.nodes.map((n) => n.id),
    ["a", "b"],
  );
  assert.equal(g.edges.length, 1);
  assert.equal(g.edges[0].kind, "call");
});

test("normalizeJellyCallGraph rejects non-POSIX repo-relative paths in strict mode", () => {
  assert.throws(
    () =>
      normalizeJellyCallGraph({
        schemaVersion: 1,
        nodes: [{ id: "n1", filePath: "src\\\\a.ts", startOffset: 0, endOffset: 1 }],
        edges: [],
      }),
    /separators/i,
  );
});

