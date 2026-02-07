import assert from "node:assert/strict";
import test from "node:test";

import { runCheapStaticPassV2 } from "../src/cheap_static_pass.ts";
import { normalizeFuncSummary } from "../src/func_summary.ts";
import { createFuncId, createHeapId, createLocalVarId, createParamVarId, createStmtId } from "../src/ids.ts";
import { normalizeFuncIr } from "../src/ir.ts";

test("normalizeFuncSummary: canonicalizes ordering and dedupes edges (and enforces baseline coverage)", () => {
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
      {
        kind: "call",
        callsiteId: s1,
        dst: null,
        callee: { kind: "unknown" },
        args: [{ kind: "var", id: v0 }, { kind: "lit", value: "x" }],
      },
      { kind: "return", stmtId: s2, value: { kind: "var", id: v0 } },
    ],
  });

  const baseline = runCheapStaticPassV2(ir);

  const raw = {
    schemaVersion: 1,
    funcId,
    edges: [
      { from: { kind: "var", id: v0 }, to: { kind: "return" } },
      { from: { kind: "var", id: p0 }, to: { kind: "var", id: v0 } },
      { from: { kind: "var", id: v0 }, to: { kind: "call_arg", callsiteId: s1, index: 0 } },
      { from: { kind: "var", id: v0 }, to: { kind: "return" } }, // duplicate edge
    ],
  };

  const norm = normalizeFuncSummary(raw, { ir, baselineEdges: baseline.edges });

  assert.deepEqual(norm.edges, [
    { from: { kind: "var", id: p0 }, to: { kind: "var", id: v0 } },
    { from: { kind: "var", id: v0 }, to: { kind: "call_arg", callsiteId: s1, index: 0 } },
    { from: { kind: "var", id: v0 }, to: { kind: "return" } },
  ]);
});

test("normalizeFuncSummary: rejects missing baseline edges", () => {
  const funcId = createFuncId("src/a.ts", 0, 10);
  const s0 = createStmtId(funcId, 0);
  const s1 = createStmtId(funcId, 1);

  const p0 = createParamVarId(0);
  const v0 = createLocalVarId(0);

  const ir = normalizeFuncIr({
    schemaVersion: 1,
    funcId,
    params: [p0],
    locals: [v0],
    stmts: [
      {
        kind: "call",
        callsiteId: s0,
        dst: null,
        callee: { kind: "unknown" },
        args: [{ kind: "var", id: p0 }],
      },
      { kind: "return", stmtId: s1, value: { kind: "var", id: v0 } },
    ],
  });

  const baseline = runCheapStaticPassV2(ir);

  assert.throws(
    () =>
      normalizeFuncSummary(
        {
          schemaVersion: 1,
          funcId,
          // Missing baseline var->call_arg edge.
          edges: [{ from: { kind: "var", id: v0 }, to: { kind: "return" } }],
        },
        { ir, baselineEdges: baseline.edges },
      ),
    /missing .*baseline edge/i,
  );
});

test("normalizeFuncSummary: rejects undeclared VarId", () => {
  const funcId = createFuncId("src/a.ts", 0, 1);
  const p0 = createParamVarId(0);
  const v0 = createLocalVarId(0);
  const v1 = createLocalVarId(1);

  const ir = normalizeFuncIr({ schemaVersion: 1, funcId, params: [p0], locals: [v0], stmts: [] });

  assert.throws(
    () =>
      normalizeFuncSummary(
        { schemaVersion: 1, funcId, edges: [{ from: { kind: "var", id: v1 }, to: { kind: "return" } }] },
        { ir, baselineEdges: [] },
      ),
    /undeclared VarId/i,
  );
});

test("normalizeFuncSummary: rejects invalid edge direction (return as from)", () => {
  const funcId = createFuncId("src/a.ts", 0, 1);
  const p0 = createParamVarId(0);
  const v0 = createLocalVarId(0);

  const ir = normalizeFuncIr({ schemaVersion: 1, funcId, params: [p0], locals: [v0], stmts: [] });

  assert.throws(
    () =>
      normalizeFuncSummary(
        { schemaVersion: 1, funcId, edges: [{ from: { kind: "return" }, to: { kind: "var", id: v0 } }] },
        { ir, baselineEdges: [] },
      ),
    /from-position/i,
  );
});

test("normalizeFuncSummary: rejects undeclared CallsiteId", () => {
  const funcId = createFuncId("src/a.ts", 0, 10);
  const s0 = createStmtId(funcId, 0);
  const s1 = createStmtId(funcId, 1);

  const p0 = createParamVarId(0);

  const ir = normalizeFuncIr({
    schemaVersion: 1,
    funcId,
    params: [p0],
    locals: [],
    stmts: [{ kind: "call", callsiteId: s0, dst: null, callee: { kind: "unknown" }, args: [] }],
  });

  assert.throws(
    () =>
      normalizeFuncSummary(
        {
          schemaVersion: 1,
          funcId,
          edges: [{ from: { kind: "var", id: p0 }, to: { kind: "call_arg", callsiteId: s1, index: 0 } }],
        },
        { ir, baselineEdges: [] },
      ),
    /undeclared CallsiteId/i,
  );
});

test("normalizeFuncSummary: rejects call_arg index out of range", () => {
  const funcId = createFuncId("src/a.ts", 0, 10);
  const s0 = createStmtId(funcId, 0);

  const p0 = createParamVarId(0);

  const ir = normalizeFuncIr({
    schemaVersion: 1,
    funcId,
    params: [p0],
    locals: [],
    stmts: [
      { kind: "call", callsiteId: s0, dst: null, callee: { kind: "unknown" }, args: [{ kind: "var", id: p0 }] },
    ],
  });

  assert.throws(
    () =>
      normalizeFuncSummary(
        {
          schemaVersion: 1,
          funcId,
          edges: [{ from: { kind: "var", id: p0 }, to: { kind: "call_arg", callsiteId: s0, index: 1 } }],
        },
        { ir, baselineEdges: [] },
      ),
    /out of range/i,
  );
});

test("normalizeFuncSummary: rejects HeapId not present in baseline decls", () => {
  const funcId = createFuncId("src/a.ts", 0, 10);
  const s0 = createStmtId(funcId, 0);

  const p0 = createParamVarId(0);
  const v0 = createLocalVarId(0);
  const h0 = createHeapId(s0, "x");

  const ir = normalizeFuncIr({ schemaVersion: 1, funcId, params: [p0], locals: [v0], stmts: [] });

  assert.throws(
    () =>
      normalizeFuncSummary(
        {
          schemaVersion: 1,
          funcId,
          edges: [{ from: { kind: "heap_read", id: h0 }, to: { kind: "var", id: v0 } }],
        },
        { ir, baselineEdges: [] },
      ),
    /undeclared HeapId/i,
  );
});

test("normalizeFuncSummary: enforces maxEdges bound", () => {
  const funcId = createFuncId("src/a.ts", 0, 1);
  const p0 = createParamVarId(0);
  const v0 = createLocalVarId(0);
  const v1 = createLocalVarId(1);
  const v2 = createLocalVarId(2);

  const ir = normalizeFuncIr({ schemaVersion: 1, funcId, params: [p0], locals: [v0, v1, v2], stmts: [] });

  assert.throws(
    () =>
      normalizeFuncSummary(
        {
          schemaVersion: 1,
          funcId,
          edges: [
            { from: { kind: "var", id: p0 }, to: { kind: "var", id: v0 } },
            { from: { kind: "var", id: p0 }, to: { kind: "var", id: v1 } },
            { from: { kind: "var", id: p0 }, to: { kind: "var", id: v2 } },
          ],
        },
        { ir, baselineEdges: [], bounds: { maxEdges: 2 } },
      ),
    /maxEdges/i,
  );
});

test("normalizeFuncSummary: enforces maxFanout bound", () => {
  const funcId = createFuncId("src/a.ts", 0, 1);
  const p0 = createParamVarId(0);
  const v0 = createLocalVarId(0);
  const v1 = createLocalVarId(1);

  const ir = normalizeFuncIr({ schemaVersion: 1, funcId, params: [p0], locals: [v0, v1], stmts: [] });

  assert.throws(
    () =>
      normalizeFuncSummary(
        {
          schemaVersion: 1,
          funcId,
          edges: [
            { from: { kind: "var", id: p0 }, to: { kind: "var", id: v0 } },
            { from: { kind: "var", id: p0 }, to: { kind: "var", id: v1 } },
          ],
        },
        { ir, baselineEdges: [], bounds: { maxFanout: 1 } },
      ),
    /maxFanout/i,
  );
});

test("normalizeFuncSummary: rejects unknown keys and node kinds", () => {
  const funcId = createFuncId("src/a.ts", 0, 1);
  const p0 = createParamVarId(0);
  const v0 = createLocalVarId(0);

  const ir = normalizeFuncIr({ schemaVersion: 1, funcId, params: [p0], locals: [v0], stmts: [] });

  assert.throws(
    () => normalizeFuncSummary({ schemaVersion: 1, funcId, edges: [], extra: 1 }, { ir, baselineEdges: [] }),
    /unknown key/i,
  );

  assert.throws(
    () =>
      normalizeFuncSummary(
        {
          schemaVersion: 1,
          funcId,
          edges: [{ from: { kind: "wat", id: "p0" }, to: { kind: "return" } }],
        },
        { ir, baselineEdges: [] },
      ),
    /supported FuncSummaryNode kind/i,
  );
});

