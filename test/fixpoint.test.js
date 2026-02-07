import assert from "node:assert/strict";
import test from "node:test";

import { stableSort } from "../src/determinism.ts";
import { cmpFuncId, createFuncId, createStmtId } from "../src/ids.ts";
import { runDeterministicFixpoint } from "../src/fixpoint.ts";
import { normalizeMappedCallGraph } from "../src/mapped_callgraph.ts";

function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

test("normalizeMappedCallGraph rejects callsiteIds that don't belong to the caller FuncId", () => {
  const fa = createFuncId("src/a.ts", 0, 1);
  const fb = createFuncId("src/b.ts", 0, 1);

  assert.throws(
    () =>
      normalizeMappedCallGraph({
        edges: [{ callerFuncId: fa, calleeFuncId: fb, callsiteId: createStmtId(fb, 0) }],
      }),
    /callsiteId.*belong/i,
  );
});

test("runDeterministicFixpoint computes a reachable-set fixpoint deterministically", () => {
  const fA = createFuncId("src/a.ts", 0, 1);
  const fB = createFuncId("src/b.ts", 0, 1);
  const fC = createFuncId("src/c.ts", 0, 1);

  const eAB = { callerFuncId: fA, calleeFuncId: fB, callsiteId: createStmtId(fA, 0) };
  const eBC = { callerFuncId: fB, calleeFuncId: fC, callsiteId: createStmtId(fB, 0) };
  const eBA = { callerFuncId: fB, calleeFuncId: fA, callsiteId: createStmtId(fB, 1) };

  // Intentionally scramble input ordering; normalization should canonicalize.
  const graph1 = normalizeMappedCallGraph({
    nodes: [fC, fA, fB],
    edges: [eBA, eAB, eBC],
  });
  const graph2 = normalizeMappedCallGraph({
    nodes: [fB, fC, fA],
    edges: [eBC, eAB, eBA],
  });

  function run(graph) {
    const reachable = new Map(graph.nodes.map((n) => [n, []]));
    const trace = [];

    const res = runDeterministicFixpoint(graph, {
      // Unsorted on purpose; driver must canonicalize.
      initial: [fB, fA, fC],
      step: (funcId) => {
        trace.push(funcId);

        const old = reachable.get(funcId) ?? [];

        const nextSet = new Set();
        for (const callee of graph.calleesByCaller.get(funcId) ?? []) {
          nextSet.add(callee);
          for (const r of reachable.get(callee) ?? []) nextSet.add(r);
        }

        const next = stableSort(Array.from(nextSet), cmpFuncId);
        if (arraysEqual(old, next)) return false;
        reachable.set(funcId, next);
        return true;
      },
    });

    return { reachable, trace, res };
  }

  const r1 = run(graph1);
  const r2 = run(graph2);

  // Worklist order is stable and independent of input ordering.
  assert.deepEqual(r1.trace, [fA, fB, fC, fA, fB]);
  assert.deepEqual(r2.trace, r1.trace);

  assert.equal(r1.res.steps, 5);
  assert.equal(r1.res.changedSteps, 3);
  assert.deepEqual(r2.res, r1.res);

  assert.deepEqual(r1.reachable.get(fC), []);
  assert.deepEqual(r1.reachable.get(fB), [fA, fB, fC]);
  assert.deepEqual(r1.reachable.get(fA), [fA, fB, fC]);
  assert.deepEqual(r2.reachable.get(fA), r1.reachable.get(fA));
  assert.deepEqual(r2.reachable.get(fB), r1.reachable.get(fB));
  assert.deepEqual(r2.reachable.get(fC), r1.reachable.get(fC));
});

