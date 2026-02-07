import assert from "node:assert/strict";
import test from "node:test";

import { runInterprocPropagationV1 } from "../src/interproc_propagation.ts";
import { cmpFlowFact, flowFactKey } from "../src/flow_fact.ts";
import { createFuncId, createLocalVarId, createParamVarId, createStmtId } from "../src/ids.ts";
import { normalizeFuncSummary } from "../src/func_summary.ts";
import { normalizeFuncIr } from "../src/ir.ts";
import { normalizeMappedCallGraph } from "../src/mapped_callgraph.ts";
import { stableSort } from "../src/determinism.ts";

function normalizeSummary(ir, edges) {
  return normalizeFuncSummary(
    { schemaVersion: 1, funcId: ir.funcId, edges },
    {
      ir,
      baselineEdges: edges,
    },
  );
}

function factSet(facts) {
  return new Set(facts.map(flowFactKey));
}

test("runInterprocPropagationV1 lifts arg->param and return->assignment through a callsite", () => {
  const fA = createFuncId("src/a.ts", 0, 1);
  const fB = createFuncId("src/b.ts", 0, 1);

  const p0 = createParamVarId(0);
  const v0 = createLocalVarId(0);

  const csA0 = createStmtId(fA, 0);
  const sA1 = createStmtId(fA, 1);
  const sB0 = createStmtId(fB, 0);

  const irB = normalizeFuncIr({
    schemaVersion: 1,
    funcId: fB,
    params: [p0],
    locals: [],
    stmts: [{ kind: "return", stmtId: sB0, value: { kind: "var", id: p0 } }],
  });
  const sumB = normalizeSummary(irB, [{ from: { kind: "var", id: p0 }, to: { kind: "return" } }]);

  // a(p0) { const v0 = b(p0); return v0; }
  const irA = normalizeFuncIr({
    schemaVersion: 1,
    funcId: fA,
    params: [p0],
    locals: [v0],
    stmts: [
      {
        kind: "call",
        callsiteId: csA0,
        dst: v0,
        callee: { kind: "unknown" },
        args: [{ kind: "var", id: p0 }],
      },
      { kind: "return", stmtId: sA1, value: { kind: "var", id: v0 } },
    ],
  });
  const sumA = normalizeSummary(irA, [
    { from: { kind: "var", id: p0 }, to: { kind: "call_arg", callsiteId: csA0, index: 0 } },
    { from: { kind: "var", id: v0 }, to: { kind: "return" } },
  ]);

  const graph = normalizeMappedCallGraph({
    edges: [{ callerFuncId: fA, calleeFuncId: fB, callsiteId: csA0 }],
  });

  const res = runInterprocPropagationV1({
    graph,
    irByFuncId: new Map([
      [fA, irA],
      [fB, irB],
    ]),
    summaryByFuncId: new Map([
      [fA, sumA],
      [fB, sumB],
    ]),
  });

  const expected = stableSort(
    [
      {
        schemaVersion: 1,
        from: { kind: "var", funcId: fA, id: p0 },
        to: { kind: "call_arg", callsiteId: csA0, index: 0 },
      },
      {
        schemaVersion: 1,
        from: { kind: "var", funcId: fA, id: p0 },
        to: { kind: "return", funcId: fA },
      },
      {
        schemaVersion: 1,
        from: { kind: "var", funcId: fB, id: p0 },
        to: { kind: "return", funcId: fB },
      },
    ],
    cmpFlowFact,
  );

  assert.deepEqual(res.facts, expected);
});

test("runInterprocPropagationV1 propagates param influence through call returns into other call args", () => {
  const fA = createFuncId("src/a.ts", 0, 1);
  const fB = createFuncId("src/b.ts", 0, 1);
  const fC = createFuncId("src/c.ts", 0, 1);

  const p0 = createParamVarId(0);
  const v0 = createLocalVarId(0);

  const csA0 = createStmtId(fA, 0); // b(p0)
  const csA1 = createStmtId(fA, 1); // c(v0)
  const sB0 = createStmtId(fB, 0);
  const sC0 = createStmtId(fC, 0);

  const irB = normalizeFuncIr({
    schemaVersion: 1,
    funcId: fB,
    params: [p0],
    locals: [],
    stmts: [{ kind: "return", stmtId: sB0, value: { kind: "var", id: p0 } }],
  });
  const sumB = normalizeSummary(irB, [{ from: { kind: "var", id: p0 }, to: { kind: "return" } }]);

  const irC = normalizeFuncIr({
    schemaVersion: 1,
    funcId: fC,
    params: [p0],
    locals: [],
    stmts: [{ kind: "return", stmtId: sC0, value: null }],
  });
  const sumC = normalizeSummary(irC, []);

  // a(p0) { const v0 = b(p0); c(v0); }
  const irA = normalizeFuncIr({
    schemaVersion: 1,
    funcId: fA,
    params: [p0],
    locals: [v0],
    stmts: [
      {
        kind: "call",
        callsiteId: csA0,
        dst: v0,
        callee: { kind: "unknown" },
        args: [{ kind: "var", id: p0 }],
      },
      {
        kind: "call",
        callsiteId: csA1,
        dst: null,
        callee: { kind: "unknown" },
        args: [{ kind: "var", id: v0 }],
      },
    ],
  });
  const sumA = normalizeSummary(irA, [
    { from: { kind: "var", id: p0 }, to: { kind: "call_arg", callsiteId: csA0, index: 0 } },
    { from: { kind: "var", id: v0 }, to: { kind: "call_arg", callsiteId: csA1, index: 0 } },
  ]);

  const graph = normalizeMappedCallGraph({
    edges: [
      { callerFuncId: fA, calleeFuncId: fB, callsiteId: csA0 },
      { callerFuncId: fA, calleeFuncId: fC, callsiteId: csA1 },
    ],
  });

  const res = runInterprocPropagationV1({
    graph,
    irByFuncId: new Map([
      [fA, irA],
      [fB, irB],
      [fC, irC],
    ]),
    summaryByFuncId: new Map([
      [fA, sumA],
      [fB, sumB],
      [fC, sumC],
    ]),
  });

  const keys = factSet(res.facts);
  assert.ok(
    keys.has(
      flowFactKey({
        schemaVersion: 1,
        from: { kind: "var", funcId: fA, id: p0 },
        to: { kind: "call_arg", callsiteId: csA0, index: 0 },
      }),
    ),
  );
  assert.ok(
    keys.has(
      flowFactKey({
        schemaVersion: 1,
        from: { kind: "var", funcId: fA, id: p0 },
        to: { kind: "call_arg", callsiteId: csA1, index: 0 },
      }),
    ),
  );
});

