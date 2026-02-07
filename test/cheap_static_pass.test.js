import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import { runCheapStaticPassV1, runCheapStaticPassV2 } from "../src/cheap_static_pass.ts";
import { createFuncId, createHeapId, createLocalVarId, createParamVarId, createStmtId, varIdToParts } from "../src/ids.ts";
import { buildFuncIrV1, buildFuncIrV2 } from "../src/ir_builder.ts";
import { normalizeFuncIr } from "../src/ir.ts";
import { buildStatementIndexFromProject } from "../src/statement_indexer.ts";
import { loadTsProject } from "../src/ts_project.ts";

const testDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(testDir, "..");

function loadFixtureStatements() {
  const fixtureDir = join(projectRoot, "test", "fixtures", "basic");
  const tsconfigPath = join(fixtureDir, "tsconfig.json");
  const project = loadTsProject({ tsconfig: tsconfigPath });
  return buildStatementIndexFromProject(project);
}

function findFuncEntryBySnippet(stIdx, needle) {
  const entry = stIdx.perFunction.find(({ func }) =>
    func.sourceFile.text.slice(func.startOffset, func.endOffset).includes(needle),
  );
  assert.ok(entry, `Expected to find function containing snippet: ${needle}`);
  return entry;
}

function findCallsiteIdByText(entry, callText) {
  const st = entry.statements.find(
    (s) => ts.isCallExpression(s.node) && entry.func.sourceFile.text.slice(s.startOffset, s.endOffset) === callText,
  );
  assert.ok(st, `Expected to find callsite statement for: ${callText}`);
  return st.id;
}

test("runCheapStaticPassV1: collects assign + return edges (and dedupes)", () => {
  const funcId = createFuncId("src/a.ts", 0, 10);
  const s0 = createStmtId(funcId, 0);
  const s1 = createStmtId(funcId, 1);
  const s2 = createStmtId(funcId, 2);

  const p0 = createParamVarId(0);
  const v0 = createLocalVarId(0);

  const ir = normalizeFuncIr({
    schemaVersion: 1,
    funcId,
    params: [p0],
    locals: [v0],
    stmts: [
      { kind: "assign", stmtId: s0, dst: v0, src: { kind: "var", id: p0 } },
      { kind: "assign", stmtId: s1, dst: v0, src: { kind: "var", id: p0 } }, // duplicate edge
      { kind: "return", stmtId: s2, value: { kind: "var", id: v0 } },
    ],
  });

  const out = runCheapStaticPassV1(ir);
  assert.deepEqual(out.edges, [
    { from: { kind: "var", id: p0 }, to: { kind: "var", id: v0 } },
    { from: { kind: "var", id: v0 }, to: { kind: "return" } },
  ]);
});

test("runCheapStaticPassV1: collects call argument edges for pipeline()", () => {
  const stIdx = loadFixtureStatements();
  const entry = findFuncEntryBySnippet(stIdx, "function pipeline");

  const wrapId = findCallsiteIdByText(entry, "wrap(input)");
  const readValueId = findCallsiteIdByText(entry, "readValue(w)");
  const addPrefixId = findCallsiteIdByText(entry, 'addPrefix("p:", inner)');

  const ir = buildFuncIrV1(entry.func, entry.statements);
  const out = runCheapStaticPassV1(ir);

  assert.deepEqual(out.edges, [
    { from: { kind: "var", id: createParamVarId(0) }, to: { kind: "call_arg", callsiteId: wrapId, index: 0 } },
    { from: { kind: "var", id: createLocalVarId(0) }, to: { kind: "call_arg", callsiteId: readValueId, index: 0 } },
    { from: { kind: "var", id: createLocalVarId(1) }, to: { kind: "call_arg", callsiteId: addPrefixId, index: 1 } },
    { from: { kind: "var", id: createLocalVarId(2) }, to: { kind: "return" } },
  ]);
});

const SYNTHETIC_HEAP_ANCHOR_BASE = 1_000_000_000;
const SYNTHETIC_HEAP_ANCHOR_LOCAL_OFFSET = 500_000_000;

function synthAnchor(funcId, id) {
  const parts = varIdToParts(id);
  const offset = parts.kind === "p" ? parts.index : SYNTHETIC_HEAP_ANCHOR_LOCAL_OFFSET + parts.index;
  return createStmtId(funcId, SYNTHETIC_HEAP_ANCHOR_BASE + offset);
}

test("runCheapStaticPassV2: emits heap_read edge for optionalFlow()", () => {
  const stIdx = loadFixtureStatements();
  const entry = findFuncEntryBySnippet(stIdx, "function optionalFlow");

  const ir = buildFuncIrV2(entry.func, entry.statements);
  const out = runCheapStaticPassV2(ir);

  const anchor = synthAnchor(ir.funcId, createParamVarId(0));
  const h = createHeapId(anchor, "value");

  assert.deepEqual(out.edges, [
    { from: { kind: "var", id: createLocalVarId(0) }, to: { kind: "return" } },
    { from: { kind: "heap_read", id: h }, to: { kind: "var", id: createLocalVarId(0) } },
  ]);
});

test("runCheapStaticPassV2: buckets by allocation site and uses * for dynamic keys", () => {
  const funcId = createFuncId("src/a.ts", 0, 10);
  const s0 = createStmtId(funcId, 0);
  const s1 = createStmtId(funcId, 1);
  const s2 = createStmtId(funcId, 2);
  const s3 = createStmtId(funcId, 3);
  const s4 = createStmtId(funcId, 4);

  const p0 = createParamVarId(0);
  const v0 = createLocalVarId(0);
  const v1 = createLocalVarId(1);
  const v2 = createLocalVarId(2);

  const ir = normalizeFuncIr({
    schemaVersion: 1,
    funcId,
    params: [p0],
    locals: [v0, v1, v2],
    stmts: [
      // v0 is treated as a fresh object identity anchored at s0.
      { kind: "assign", stmtId: s0, dst: v0, src: { kind: "unknown" } },
      // v1 aliases v0, so it should share the same heap anchor (s0).
      { kind: "assign", stmtId: s1, dst: v1, src: { kind: "var", id: v0 } },
      // Dynamic property becomes propertyName="*".
      { kind: "member_write", stmtId: s2, object: v1, property: { kind: "dynamic" }, value: { kind: "var", id: p0 }, optional: false },
      { kind: "member_read", stmtId: s3, dst: v2, object: v1, property: { kind: "named", name: "prop" }, optional: false },
      { kind: "return", stmtId: s4, value: { kind: "var", id: v2 } },
    ],
  });

  const out = runCheapStaticPassV2(ir);

  assert.deepEqual(out.edges, [
    { from: { kind: "var", id: p0 }, to: { kind: "heap_write", id: createHeapId(s0, "*") } },
    { from: { kind: "var", id: v0 }, to: { kind: "var", id: v1 } },
    { from: { kind: "var", id: v2 }, to: { kind: "return" } },
    { from: { kind: "heap_read", id: createHeapId(s0, "prop") }, to: { kind: "var", id: v2 } },
  ]);
});
