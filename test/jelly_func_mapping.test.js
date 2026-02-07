import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildFunctionIndexFromProject } from "../src/function_indexer.ts";
import { createFuncId } from "../src/ids.ts";
import { loadJellyCallGraphFromFile, normalizeJellyCallGraph } from "../src/jelly_callgraph.ts";
import { mapJellyFunctionNodesToFuncIds } from "../src/jelly_func_mapping.ts";
import { loadTsProject } from "../src/ts_project.ts";

const testDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(testDir, "..");

function loadFixtureProject() {
  const fixtureDir = join(projectRoot, "test", "fixtures", "basic");
  const tsconfigPath = join(fixtureDir, "tsconfig.json");
  const jellyPath = join(fixtureDir, "jelly_callgraph.json");

  const project = loadTsProject({ tsconfig: tsconfigPath });
  const idx = buildFunctionIndexFromProject(project);
  const jelly = loadJellyCallGraphFromFile(jellyPath);
  return { fixtureDir, project, idx, jelly };
}

test("mapJellyFunctionNodesToFuncIds: maps fixture nodes to FuncId spans (strict)", () => {
  const { idx, jelly } = loadFixtureProject();

  const res = mapJellyFunctionNodesToFuncIds(jelly, idx, { mode: "strict" });

  assert.equal(
    res.diagnostics.some((d) => d.level === "error"),
    false,
  );
  assert.equal(res.nodeIdToFuncId.size, jelly.nodes.length);

  for (const n of jelly.nodes) {
    assert.equal(res.nodeIdToFuncId.get(n.id), createFuncId(n.filePath, n.startOffset, n.endOffset));
  }
});

test("mapJellyFunctionNodesToFuncIds: throws in strict mode when a node cannot be mapped", () => {
  const { idx } = loadFixtureProject();

  const jelly = normalizeJellyCallGraph({
    schemaVersion: 1,
    nodes: [{ id: "missing", filePath: "src/missing.ts", startOffset: 0, endOffset: 1 }],
    edges: [],
  });

  assert.throws(() => mapJellyFunctionNodesToFuncIds(jelly, idx, { mode: "strict" }), /mapping failed/i);
});

test("mapJellyFunctionNodesToFuncIds: returns partial mapping + diagnostics in lenient mode", () => {
  const { idx } = loadFixtureProject();

  const jelly = normalizeJellyCallGraph({
    schemaVersion: 1,
    nodes: [{ id: "missing", filePath: "src/missing.ts", startOffset: 0, endOffset: 1 }],
    edges: [],
  });

  const res = mapJellyFunctionNodesToFuncIds(jelly, idx, { mode: "lenient" });
  assert.equal(res.nodeIdToFuncId.size, 0);
  assert.equal(
    res.diagnostics.some((d) => d.level === "error"),
    true,
  );
});

test("mapJellyFunctionNodesToFuncIds: lenient mode resolves prefix-mismatched paths via suffix matching", () => {
  const { idx } = loadFixtureProject();

  // The offsets match `src/a.ts`'s `id` function in the fixture.
  const jelly = normalizeJellyCallGraph({
    schemaVersion: 1,
    nodes: [{ id: "a_id", filePath: "some/prefix/src/a.ts", startOffset: 0, endOffset: 46 }],
    edges: [],
  });

  const res = mapJellyFunctionNodesToFuncIds(jelly, idx, { mode: "lenient" });
  assert.equal(res.nodeIdToFuncId.get("a_id"), createFuncId("src/a.ts", 0, 46));
  assert.equal(
    res.diagnostics.some((d) => d.level === "warn"),
    true,
  );
});

