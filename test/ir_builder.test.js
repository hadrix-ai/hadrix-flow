import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import { buildFuncIrV1, buildFuncIrV2 } from "../src/ir_builder.ts";
import { createLocalVarId, createParamVarId } from "../src/ids.ts";
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

function findAwaitStmtIdByText(entry, awaitText) {
  const st = entry.statements.find(
    (s) => ts.isAwaitExpression(s.node) && entry.func.sourceFile.text.slice(s.startOffset, s.endOffset) === awaitText,
  );
  assert.ok(st, `Expected to find await statement for: ${awaitText}`);
  return st.id;
}

function findStmtIdByText(entry, kindName, predicate, stmtText) {
  const st = entry.statements.find(
    (s) => predicate(s.node) && entry.func.sourceFile.text.slice(s.startOffset, s.endOffset).trim() === stmtText,
  );
  assert.ok(st, `Expected to find ${kindName} statement for: ${stmtText}`);
  return st.id;
}

test("buildFuncIrV1: builds return(var) for id()", () => {
  const stIdx = loadFixtureStatements();
  const entry = findFuncEntryBySnippet(stIdx, "function id<");

  const ir = buildFuncIrV1(entry.func, entry.statements);
  assert.deepEqual(ir.params, [createParamVarId(0)]);
  assert.deepEqual(ir.locals, []);

  const rets = ir.stmts.filter((s) => s.kind === "return");
  assert.equal(rets.length, 1);
  assert.deepEqual(rets[0].value, { kind: "var", id: createParamVarId(0) });
});

test("buildFuncIrV1: builds assign+return for addPrefix()", () => {
  const stIdx = loadFixtureStatements();
  const entry = findFuncEntryBySnippet(stIdx, "function addPrefix");

  const ir = buildFuncIrV1(entry.func, entry.statements);
  assert.deepEqual(ir.params, [createParamVarId(0), createParamVarId(1)]);
  assert.deepEqual(ir.locals, [createLocalVarId(0)]);

  const assigns = ir.stmts.filter((s) => s.kind === "assign");
  assert.equal(assigns.length, 1);
  assert.equal(assigns[0].dst, createLocalVarId(0));
  assert.deepEqual(assigns[0].src, { kind: "unknown" });

  const rets = ir.stmts.filter((s) => s.kind === "return");
  assert.equal(rets.length, 1);
  assert.deepEqual(rets[0].value, { kind: "var", id: createLocalVarId(0) });
});

test("buildFuncIrV1: builds calls with dst locals + return temp for pipeline()", () => {
  const stIdx = loadFixtureStatements();
  const entry = findFuncEntryBySnippet(stIdx, "function pipeline");

  const wrapId = findCallsiteIdByText(entry, "wrap(input)");
  const readValueId = findCallsiteIdByText(entry, "readValue(w)");
  const addPrefixId = findCallsiteIdByText(entry, 'addPrefix("p:", inner)');

  const ir = buildFuncIrV1(entry.func, entry.statements);
  assert.deepEqual(ir.params, [createParamVarId(0)]);
  assert.deepEqual(ir.locals, [createLocalVarId(0), createLocalVarId(1), createLocalVarId(2)]);

  const wrapCall = ir.stmts.find((s) => s.kind === "call" && s.callsiteId === wrapId);
  assert.ok(wrapCall);
  assert.equal(wrapCall.dst, createLocalVarId(0));
  assert.deepEqual(wrapCall.callee, { kind: "unknown" });
  assert.deepEqual(wrapCall.args, [{ kind: "var", id: createParamVarId(0) }]);

  const readValueCall = ir.stmts.find((s) => s.kind === "call" && s.callsiteId === readValueId);
  assert.ok(readValueCall);
  assert.equal(readValueCall.dst, createLocalVarId(1));
  assert.deepEqual(readValueCall.callee, { kind: "unknown" });
  assert.deepEqual(readValueCall.args, [{ kind: "var", id: createLocalVarId(0) }]);

  const addPrefixCall = ir.stmts.find((s) => s.kind === "call" && s.callsiteId === addPrefixId);
  assert.ok(addPrefixCall);
  assert.equal(addPrefixCall.dst, createLocalVarId(2));
  assert.deepEqual(addPrefixCall.callee, { kind: "unknown" });
  assert.deepEqual(addPrefixCall.args, [{ kind: "lit", value: "p:" }, { kind: "var", id: createLocalVarId(1) }]);

  const ret = ir.stmts.find((s) => s.kind === "return" && s.value && s.value.kind === "var" && s.value.id === createLocalVarId(2));
  assert.ok(ret);
});

test("buildFuncIrV2: preserves v1 output shape for pipeline()", () => {
  const stIdx = loadFixtureStatements();
  const entry = findFuncEntryBySnippet(stIdx, "function pipeline");

  const v1 = buildFuncIrV1(entry.func, entry.statements);
  const v2 = buildFuncIrV2(entry.func, entry.statements);
  assert.deepEqual(v2, v1);
});

test("buildFuncIrV2: lowers await into an await statement for asyncFlow()", () => {
  const stIdx = loadFixtureStatements();
  const entry = findFuncEntryBySnippet(stIdx, "async function asyncFlow");
  const awaitId = findAwaitStmtIdByText(entry, "await p");

  const ir = buildFuncIrV2(entry.func, entry.statements);
  assert.deepEqual(ir.params, [createParamVarId(0)]);
  assert.deepEqual(ir.locals, [createLocalVarId(0), createLocalVarId(1)]);

  const aw = ir.stmts.find((s) => s.kind === "await" && s.stmtId === awaitId);
  assert.ok(aw);
  assert.equal(aw.dst, createLocalVarId(1));
  assert.deepEqual(aw.src, { kind: "var", id: createLocalVarId(0) });

  const ret = ir.stmts.find(
    (s) => s.kind === "return" && s.value && s.value.kind === "var" && s.value.id === createLocalVarId(1),
  );
  assert.ok(ret);
});

test("buildFuncIrV2: lowers member writes for Box.set()", () => {
  const stIdx = loadFixtureStatements();
  const entry = findFuncEntryBySnippet(stIdx, "set(v: string): void");
  const writeId = findStmtIdByText(entry, "expression", ts.isExpressionStatement, "this.value = v;");

  const ir = buildFuncIrV2(entry.func, entry.statements);
  assert.deepEqual(ir.params, [createParamVarId(0)]);
  assert.deepEqual(ir.locals, [createLocalVarId(0)]);

  const write = ir.stmts.find((s) => s.kind === "member_write" && s.stmtId === writeId);
  assert.ok(write);
  assert.equal(write.object, createLocalVarId(0));
  assert.deepEqual(write.property, { kind: "named", name: "value" });
  assert.deepEqual(write.value, { kind: "var", id: createParamVarId(0) });
  assert.equal(write.optional, false);
});

test("buildFuncIrV2: lowers optional chaining member reads for optionalFlow()", () => {
  const stIdx = loadFixtureStatements();
  const entry = findFuncEntryBySnippet(stIdx, "function optionalFlow");
  const declId = findStmtIdByText(entry, "variable", ts.isVariableStatement, 'const v = obj?.value ?? "default";');

  const ir = buildFuncIrV2(entry.func, entry.statements);
  assert.deepEqual(ir.params, [createParamVarId(0)]);
  assert.deepEqual(ir.locals, [createLocalVarId(0)]);

  const read = ir.stmts.find((s) => s.kind === "member_read" && s.stmtId === declId);
  assert.ok(read);
  assert.equal(read.dst, createLocalVarId(0));
  assert.equal(read.object, createParamVarId(0));
  assert.deepEqual(read.property, { kind: "named", name: "value" });
  assert.equal(read.optional, true);

  const assign = ir.stmts.find((s) => s.kind === "assign" && s.stmtId === declId);
  assert.equal(assign, undefined);
});
