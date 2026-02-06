import assert from "node:assert/strict";
import test from "node:test";

import {
  cmpCallsiteId,
  cmpFuncId,
  cmpHeapId,
  cmpStmtId,
  cmpVarId,
  createFuncId,
  createHeapId,
  createLocalVarId,
  createParamVarId,
  createStmtId,
  funcIdToParts,
  heapIdToParts,
  parseCallsiteId,
  parseFuncId,
  parseHeapId,
  parseStmtId,
  parseVarId,
  stmtIdToParts,
  stringifyCallsiteId,
  stringifyFuncId,
  stringifyHeapId,
  stringifyStmtId,
  stringifyVarId,
  varIdToParts,
} from "../src/ids.ts";

test("FuncId: create/parse/stringify/parts", () => {
  const id = createFuncId("src/a.ts", 10, 20);
  assert.equal(stringifyFuncId(id), id);
  assert.deepEqual(funcIdToParts(id), { filePath: "src/a.ts", startOffset: 10, endOffset: 20 });

  const parsed = parseFuncId(id);
  assert.equal(parsed, id);

  assert.throws(() => parseFuncId("s:src%2Fa.ts:10:20:0"), /FuncId/);
  assert.throws(() => parseFuncId("f:src%2Fa.ts:10"), /FuncId/);
  assert.throws(() => parseFuncId("f:src%2Fa.ts:-1:20"), /canonical/);
  assert.throws(() => parseFuncId("f:src%2Fa.ts:01:20"), /canonical/);
  assert.throws(() => parseFuncId("f:src%2Fa.ts:20:10"), /endOffset.*>=/);
});

test("FuncId: rejects non-canonical URI encoding", () => {
  // `%61` decodes to `a`, but canonical encoding is plain `a`.
  assert.throws(() => parseFuncId("f:%61.ts:0:1"), /canonical/);
  // `%2f` should be `%2F` in canonical encoding.
  assert.throws(() => parseFuncId("f:src%2fa.ts:0:1"), /canonical/);
});

test("FuncId: comparator uses numeric offsets", () => {
  const a2 = createFuncId("a.ts", 2, 3);
  const a10 = createFuncId("a.ts", 10, 11);
  assert.equal(cmpFuncId(a2, a10) < 0, true);
});

test("StmtId/CallsiteId: create/parse/compare", () => {
  const f = createFuncId("src/a.ts", 100, 200);
  const s0 = createStmtId(f, 0);
  const s1 = createStmtId(f, 1);

  assert.equal(stringifyStmtId(s0), s0);
  assert.deepEqual(stmtIdToParts(s0), {
    filePath: "src/a.ts",
    startOffset: 100,
    endOffset: 200,
    statementIndex: 0,
  });
  assert.equal(parseStmtId(s0), s0);
  assert.equal(cmpStmtId(s0, s1) < 0, true);

  // CallsiteId is an alias of StmtId by architecture.
  const cs = parseCallsiteId(s1);
  assert.equal(stringifyCallsiteId(cs), s1);
  assert.equal(cmpCallsiteId(s0, cs) < 0, true);

  assert.throws(() => parseStmtId("f:src%2Fa.ts:100:200"), /StmtId/);
  assert.throws(() => parseStmtId("s:src%2Fa.ts:100:200:-1"), /canonical/);
  assert.throws(() => parseStmtId("s:src%2Fa.ts:100:200:01"), /canonical/);
});

test("VarId: parse/stringify/compare", () => {
  const p0 = createParamVarId(0);
  const p2 = createParamVarId(2);
  const p10 = createParamVarId(10);
  const v0 = createLocalVarId(0);

  assert.equal(stringifyVarId(p0), p0);
  assert.equal(parseVarId("p0"), p0);
  assert.deepEqual(varIdToParts(p10), { kind: "p", index: 10 });

  assert.equal(cmpVarId(p2, p10) < 0, true);
  assert.equal(cmpVarId(p0, v0) < 0, true);

  assert.throws(() => parseVarId("p01"), /Invalid VarId/);
  assert.throws(() => parseVarId("v-1"), /Invalid VarId/);
  assert.throws(() => parseVarId("x0"), /Invalid VarId/);
});

test("HeapId: create/parse/parts/compare", () => {
  const f = createFuncId("src/a.ts", 10, 20);
  const alloc = createStmtId(f, 3);

  const h1 = createHeapId(alloc, "*");
  const h2 = createHeapId(alloc, "x/y");

  assert.equal(stringifyHeapId(h1), h1);
  assert.equal(parseHeapId(h2), h2);
  assert.deepEqual(heapIdToParts(h2), {
    filePath: "src/a.ts",
    startOffset: 10,
    endOffset: 20,
    statementIndex: 3,
    propertyName: "x/y",
  });

  assert.equal(cmpHeapId(h1, h2) < 0, true);

  assert.throws(() => parseHeapId("h:src%2Fa.ts:10:20:3:"), /propertyName must be a non-empty/);
  assert.throws(() => parseHeapId("h:src%2Fa.ts:10:20:03:x"), /canonical/);
});

