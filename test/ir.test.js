import assert from "node:assert/strict";
import test from "node:test";

import { createFuncId, createLocalVarId, createParamVarId, createStmtId } from "../src/ids.ts";
import { normalizeFuncIr, serializeNormalizedFuncIr } from "../src/ir.ts";

test("normalizeFuncIr canonicalizes ordering and defaults optional fields", () => {
  const funcId = createFuncId("src/a.ts", 10, 20);
  const s0 = createStmtId(funcId, 0);
  const s1 = createStmtId(funcId, 1);
  const s2 = createStmtId(funcId, 2);

  const p0 = createParamVarId(0);
  const v0 = createLocalVarId(0);
  const v1 = createLocalVarId(1);

  const raw = {
    schemaVersion: 1,
    funcId,
    params: [p0],
    // Deliberately out-of-order.
    locals: [v1, v0],
    // Deliberately out-of-order.
    stmts: [
      { kind: "return", stmtId: s2 },
      { kind: "call", callsiteId: s1, callee: { kind: "unknown" }, args: [] },
      { kind: "assign", stmtId: s0, dst: v0, src: { kind: "var", id: p0 } },
    ],
  };

  const norm = normalizeFuncIr(raw);
  assert.deepEqual(norm.locals, [v0, v1]);
  assert.deepEqual(
    norm.stmts.map((s) => s.kind),
    ["assign", "call", "return"],
  );

  const call = norm.stmts[1];
  assert.equal(call.kind, "call");
  assert.equal(call.dst, null);

  const ret = norm.stmts[2];
  assert.equal(ret.kind, "return");
  assert.equal(ret.value, null);

  const json1 = serializeNormalizedFuncIr(norm);
  const json2 = serializeNormalizedFuncIr(normalizeFuncIr(raw));
  assert.equal(json1, json2);
});

test("normalizeFuncIr rejects unknown keys and mismatched IDs", () => {
  const funcId = createFuncId("src/a.ts", 0, 1);
  const s0 = createStmtId(funcId, 0);
  const p0 = createParamVarId(0);
  const v0 = createLocalVarId(0);

  assert.throws(
    () =>
      normalizeFuncIr({
        schemaVersion: 1,
        funcId,
        params: [p0],
        locals: [v0],
        stmts: [{ kind: "assign", stmtId: s0, dst: v0, src: { kind: "var", id: p0 }, extra: 1 }],
      }),
    /unknown key/i,
  );

  const otherFuncId = createFuncId("src/b.ts", 0, 1);
  const otherStmtId = createStmtId(otherFuncId, 0);
  assert.throws(
    () =>
      normalizeFuncIr({
        schemaVersion: 1,
        funcId,
        params: [p0],
        locals: [v0],
        stmts: [{ kind: "assign", stmtId: otherStmtId, dst: v0, src: { kind: "var", id: p0 } }],
      }),
    /must belong to funcId/i,
  );
});

test("normalizeFuncIr requires var IDs to be declared", () => {
  const funcId = createFuncId("src/a.ts", 0, 1);
  const s0 = createStmtId(funcId, 0);
  const p0 = createParamVarId(0);
  const v0 = createLocalVarId(0);
  const v1 = createLocalVarId(1);

  assert.throws(
    () =>
      normalizeFuncIr({
        schemaVersion: 1,
        funcId,
        params: [p0],
        locals: [v0],
        stmts: [{ kind: "assign", stmtId: s0, dst: v1, src: { kind: "var", id: p0 } }],
      }),
    /undeclared VarId/i,
  );
});

