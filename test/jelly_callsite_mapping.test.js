import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildCallsiteIndexFromProject } from "../src/callsite_indexer.ts";
import { buildFunctionIndexFromProject } from "../src/function_indexer.ts";
import { loadJellyCallGraphFromFile, normalizeJellyCallGraph } from "../src/jelly_callgraph.ts";
import { mapJellyCallEdgesToCallsiteIds } from "../src/jelly_callsite_mapping.ts";
import { mapJellyFunctionNodesToFuncIds } from "../src/jelly_func_mapping.ts";
import { loadTsProject } from "../src/ts_project.ts";

const testDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(testDir, "..");

function loadFixtureProject() {
  const fixtureDir = join(projectRoot, "test", "fixtures", "basic");
  const tsconfigPath = join(fixtureDir, "tsconfig.json");
  const jellyPath = join(fixtureDir, "jelly_callgraph.json");

  const project = loadTsProject({ tsconfig: tsconfigPath });
  const fnIdx = buildFunctionIndexFromProject(project);
  const csIdx = buildCallsiteIndexFromProject(project);
  const jelly = loadJellyCallGraphFromFile(jellyPath);
  return { fixtureDir, project, fnIdx, csIdx, jelly };
}

test("mapJellyCallEdgesToCallsiteIds: maps fixture edges to CallsiteId spans (strict)", () => {
  const { fnIdx, csIdx, jelly } = loadFixtureProject();

  const fnMap = mapJellyFunctionNodesToFuncIds(jelly, fnIdx, { mode: "strict" });
  const res = mapJellyCallEdgesToCallsiteIds(jelly, csIdx, { mode: "strict", nodeIdToFuncId: fnMap.nodeIdToFuncId });

  assert.equal(
    res.diagnostics.some((d) => d.level === "error"),
    false,
  );
  assert.equal(res.callsiteIdByEdgeIndex.length, jelly.edges.length);
  assert.equal(res.callsiteIdByEdgeIndex.some((id) => id === null), false);

  for (let i = 0; i < jelly.edges.length; i++) {
    const e = jelly.edges[i];
    assert.ok(e);
    const expected = csIdx.getBySpan(e.callsite.filePath, e.callsite.startOffset, e.callsite.endOffset);
    assert.ok(expected);
    assert.equal(res.callsiteIdByEdgeIndex[i], expected.id);
  }
});

test("mapJellyCallEdgesToCallsiteIds: throws in strict mode when an edge cannot be mapped", () => {
  const { csIdx } = loadFixtureProject();

  const jelly = normalizeJellyCallGraph({
    schemaVersion: 1,
    nodes: [
      { id: "caller", filePath: "src/b.ts", startOffset: 54, endOffset: 193 },
      { id: "callee", filePath: "src/a.ts", startOffset: 0, endOffset: 46 },
    ],
    edges: [
      {
        callerId: "caller",
        calleeId: "callee",
        callsite: { filePath: "src/b.ts", startOffset: 0, endOffset: 1 },
        kind: "call",
      },
    ],
  });

  assert.throws(() => mapJellyCallEdgesToCallsiteIds(jelly, csIdx, { mode: "strict" }), /mapping failed/i);
});

test("mapJellyCallEdgesToCallsiteIds: lenient mode resolves prefix-mismatched callsite paths via suffix matching", () => {
  const { csIdx } = loadFixtureProject();

  const jelly = normalizeJellyCallGraph({
    schemaVersion: 1,
    nodes: [
      { id: "caller", filePath: "src/b.ts", startOffset: 54, endOffset: 193 },
      { id: "callee", filePath: "src/a.ts", startOffset: 172, endOffset: 250 },
    ],
    edges: [
      {
        callerId: "caller",
        calleeId: "callee",
        callsite: { filePath: "some/prefix/src/b.ts", startOffset: 116, endOffset: 127 },
        kind: "call",
      },
    ],
  });

  const res = mapJellyCallEdgesToCallsiteIds(jelly, csIdx, { mode: "lenient" });
  const expected = csIdx.getBySpan("src/b.ts", 116, 127);
  assert.ok(expected);
  assert.equal(res.callsiteIdByEdgeIndex[0], expected.id);
  assert.equal(
    res.diagnostics.some((d) => d.level === "warn"),
    true,
  );
});
