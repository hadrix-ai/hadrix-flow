import assert from "node:assert/strict";
import test from "node:test";

import { runInterprocPropagationV1, runInterprocPropagationV2 } from "../src/interproc_propagation.ts";
import { cmpFlowFact, flowFactKey } from "../src/flow_fact.ts";
import { createFuncId, createHeapId, createLocalVarId, createParamVarId, createStmtId } from "../src/ids.ts";
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

const SYNTHETIC_HEAP_ANCHOR_BASE = 1_000_000_000;

test("runInterprocPropagationV2 lifts param->heap_write through a callsite", () => {
  const fA = createFuncId("src/a.ts", 0, 1);
  const fB = createFuncId("src/b.ts", 0, 1);

  const p0 = createParamVarId(0);
  const p1 = createParamVarId(1);

  const csA0 = createStmtId(fA, 0);

  const anchorB_p0 = createStmtId(fB, SYNTHETIC_HEAP_ANCHOR_BASE + 0);
  const hB = createHeapId(anchorB_p0, "x");

  const irB = normalizeFuncIr({
    schemaVersion: 1,
    funcId: fB,
    params: [p0, p1],
    locals: [],
    stmts: [],
  });
  const sumB = normalizeSummary(irB, [{ from: { kind: "var", id: p1 }, to: { kind: "heap_write", id: hB } }]);

  const irA = normalizeFuncIr({
    schemaVersion: 1,
    funcId: fA,
    params: [p0, p1],
    locals: [],
    stmts: [
      {
        kind: "call",
        callsiteId: csA0,
        dst: null,
        callee: { kind: "unknown" },
        args: [
          { kind: "var", id: p0 },
          { kind: "var", id: p1 },
        ],
      },
    ],
  });
  const sumA = normalizeSummary(irA, [
    { from: { kind: "var", id: p0 }, to: { kind: "call_arg", callsiteId: csA0, index: 0 } },
    { from: { kind: "var", id: p1 }, to: { kind: "call_arg", callsiteId: csA0, index: 1 } },
  ]);

  const graph = normalizeMappedCallGraph({
    edges: [{ callerFuncId: fA, calleeFuncId: fB, callsiteId: csA0 }],
  });

  const res = runInterprocPropagationV2({
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

  const anchorA_p0 = createStmtId(fA, SYNTHETIC_HEAP_ANCHOR_BASE + 0);
  const hA = createHeapId(anchorA_p0, "x");

  const keys = factSet(res.facts);
  assert.ok(
    keys.has(
      flowFactKey({
        schemaVersion: 1,
        from: { kind: "var", funcId: fA, id: p1 },
        to: { kind: "heap_write", id: hA },
      }),
    ),
  );
  assert.ok(
    keys.has(
      flowFactKey({
        schemaVersion: 1,
        from: { kind: "var", funcId: fB, id: p1 },
        to: { kind: "heap_write", id: hB },
      }),
    ),
  );
});

test("runInterprocPropagationV2 lifts heap_read->return through a callsite", () => {
  const fA = createFuncId("src/a.ts", 0, 1);
  const fB = createFuncId("src/b.ts", 0, 1);

  const p0 = createParamVarId(0);
  const v0 = createLocalVarId(0);

  const csA0 = createStmtId(fA, 0);
  const sA1 = createStmtId(fA, 1);

  const anchorB_p0 = createStmtId(fB, SYNTHETIC_HEAP_ANCHOR_BASE + 0);
  const hB = createHeapId(anchorB_p0, "x");

  const irB = normalizeFuncIr({
    schemaVersion: 1,
    funcId: fB,
    params: [p0],
    locals: [v0],
    stmts: [],
  });
  const sumB = normalizeSummary(irB, [
    { from: { kind: "heap_read", id: hB }, to: { kind: "var", id: v0 } },
    { from: { kind: "var", id: v0 }, to: { kind: "return" } },
  ]);

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

  const res = runInterprocPropagationV2({
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

  const anchorA_p0 = createStmtId(fA, SYNTHETIC_HEAP_ANCHOR_BASE + 0);
  const hA = createHeapId(anchorA_p0, "x");

  const keys = factSet(res.facts);
  assert.ok(
    keys.has(
      flowFactKey({
        schemaVersion: 1,
        from: { kind: "heap_read", id: hA },
        to: { kind: "return", funcId: fA },
      }),
    ),
  );
  assert.ok(
    keys.has(
      flowFactKey({
        schemaVersion: 1,
        from: { kind: "heap_read", id: hB },
        to: { kind: "return", funcId: fB },
      }),
    ),
  );
});

test("runInterprocPropagationV2 lifts heap_read->heap_write through a callsite", () => {
  const fA = createFuncId("src/a.ts", 0, 1);
  const fB = createFuncId("src/b.ts", 0, 1);

  const p0 = createParamVarId(0);
  const p1 = createParamVarId(1);
  const v0 = createLocalVarId(0);

  const csA0 = createStmtId(fA, 0);

  const hB_read = createHeapId(createStmtId(fB, SYNTHETIC_HEAP_ANCHOR_BASE + 1), "y");
  const hB_write = createHeapId(createStmtId(fB, SYNTHETIC_HEAP_ANCHOR_BASE + 0), "x");

  const irB = normalizeFuncIr({
    schemaVersion: 1,
    funcId: fB,
    params: [p0, p1],
    locals: [v0],
    stmts: [],
  });
  const sumB = normalizeSummary(irB, [
    { from: { kind: "heap_read", id: hB_read }, to: { kind: "var", id: v0 } },
    { from: { kind: "var", id: v0 }, to: { kind: "heap_write", id: hB_write } },
  ]);

  const irA = normalizeFuncIr({
    schemaVersion: 1,
    funcId: fA,
    params: [p0, p1],
    locals: [],
    stmts: [
      {
        kind: "call",
        callsiteId: csA0,
        dst: null,
        callee: { kind: "unknown" },
        args: [
          { kind: "var", id: p0 },
          { kind: "var", id: p1 },
        ],
      },
    ],
  });
  const sumA = normalizeSummary(irA, [
    { from: { kind: "var", id: p0 }, to: { kind: "call_arg", callsiteId: csA0, index: 0 } },
    { from: { kind: "var", id: p1 }, to: { kind: "call_arg", callsiteId: csA0, index: 1 } },
  ]);

  const graph = normalizeMappedCallGraph({
    edges: [{ callerFuncId: fA, calleeFuncId: fB, callsiteId: csA0 }],
  });

  const res = runInterprocPropagationV2({
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

  const hA_read = createHeapId(createStmtId(fA, SYNTHETIC_HEAP_ANCHOR_BASE + 1), "y");
  const hA_write = createHeapId(createStmtId(fA, SYNTHETIC_HEAP_ANCHOR_BASE + 0), "x");

  const keys = factSet(res.facts);
  assert.ok(
    keys.has(
      flowFactKey({
        schemaVersion: 1,
        from: { kind: "heap_read", id: hA_read },
        to: { kind: "heap_write", id: hA_write },
      }),
    ),
  );
});
