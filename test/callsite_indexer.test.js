import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import { buildCallsiteIndexFromProject } from "../src/callsite_indexer.ts";
import { cmpCallsiteId } from "../src/ids.ts";
import { buildStatementIndexFromProject } from "../src/statement_indexer.ts";
import { loadTsProject } from "../src/ts_project.ts";

const testDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(testDir, "..");

function isStrictlySortedCallsiteIds(ids) {
  for (let i = 1; i < ids.length; i++) {
    if (!(cmpCallsiteId(ids[i - 1], ids[i]) < 0)) return false;
  }
  return true;
}

test("buildCallsiteIndexFromProject: indexes call expressions with CallsiteId aligned to StmtId + span lookups", () => {
  const fixtureDir = join(projectRoot, "test", "fixtures", "basic");
  const tsconfigPath = join(fixtureDir, "tsconfig.json");

  const project = loadTsProject({ tsconfig: tsconfigPath });
  const stIdx = buildStatementIndexFromProject(project);
  const csIdx = buildCallsiteIndexFromProject(project);

  // Per-function entries align 1:1 with the statement index (and function index) ordering.
  assert.equal(csIdx.perFunction.length, stIdx.perFunction.length);
  for (let i = 0; i < csIdx.perFunction.length; i++) {
    assert.equal(csIdx.perFunction[i].func.id, stIdx.perFunction[i].func.id);
  }

  // Global list is strictly sorted by CallsiteId by construction.
  assert.equal(isStrictlySortedCallsiteIds(csIdx.callsites.map((c) => c.id)), true);

  for (const { func, callsites } of csIdx.perFunction) {
    assert.equal(csIdx.getByFuncId(func.id), callsites);

    for (const cs of callsites) {
      assert.equal(cs.funcId, func.id);
      assert.equal(cs.filePath, func.filePath);
      assert.equal(ts.isCallExpression(cs.node), true);

      const st = stIdx.getById(cs.id);
      assert.ok(st);
      assert.equal(ts.isCallExpression(st.node), true);
      assert.equal(st.startOffset, cs.startOffset);
      assert.equal(st.endOffset, cs.endOffset);
      assert.equal(csIdx.getById(cs.id), cs);
      assert.equal(csIdx.getBySpan(cs.filePath, cs.startOffset, cs.endOffset), cs);
    }
  }

  const findFunctionBySnippet = (needle) =>
    csIdx.perFunction.find(({ func }) => func.sourceFile.text.slice(func.startOffset, func.endOffset).includes(needle));

  const pipeline = findFunctionBySnippet("function pipeline");
  assert.ok(pipeline);
  {
    const texts = pipeline.callsites.map((cs) => pipeline.func.sourceFile.text.slice(cs.startOffset, cs.endOffset));
    assert.equal(texts.includes("wrap(input)"), true);
    assert.equal(texts.includes("readValue(w)"), true);
    assert.equal(texts.includes('addPrefix("p:", inner)'), true);
  }

  const classFlow = findFunctionBySnippet("function classFlow");
  assert.ok(classFlow);
  {
    const texts = classFlow.callsites.map((cs) => classFlow.func.sourceFile.text.slice(cs.startOffset, cs.endOffset));
    assert.equal(texts.includes('b.set(x + "!")'), true);
    assert.equal(texts.includes("b.get()"), true);
    // `new Box(x)` is a `NewExpression` (allocation site), not a callsite.
    assert.equal(texts.includes("new Box(x)"), false);
  }
});

