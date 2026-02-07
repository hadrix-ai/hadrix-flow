import { stableSort } from "./determinism.ts";
import { cmpFuncId } from "./ids.ts";
import type { FuncId } from "./ids.ts";
import type { MappedCallGraph } from "./mapped_callgraph.ts";

export type FixpointOptions = Readonly<{
  // Initial worklist. Defaults to all nodes in canonical order.
  initial?: readonly FuncId[];

  // (Re)compute state for a single node. Returns true if node-local state changed.
  step: (funcId: FuncId) => boolean;

  // Dependents to re-schedule when `step` returns true. Defaults to `graph.callersByCallee`.
  dependents?: (funcId: FuncId) => readonly FuncId[];

  // Safety rail against non-convergent step functions.
  maxSteps?: number;
}>;

export type FixpointResult = Readonly<{
  steps: number;
  changedSteps: number;
}>;

// Deterministic worklist fixpoint:
// - Worklist ordering is canonical by FuncId.
// - Dependents are scheduled in canonical order.
export function runDeterministicFixpoint(graph: MappedCallGraph, opts: FixpointOptions): FixpointResult {
  if (opts.maxSteps !== undefined) {
    if (!Number.isSafeInteger(opts.maxSteps) || opts.maxSteps <= 0) {
      throw new Error(`FixpointOptions.maxSteps must be a positive safe integer; got ${opts.maxSteps}`);
    }
  }

  const nodeSet = new Set<FuncId>(graph.nodes);
  const initial = opts.initial
    ? stableSort(Array.from(new Set(opts.initial)), cmpFuncId)
    : // `graph.nodes` is already stable-sorted.
      graph.nodes;

  for (const n of initial) {
    if (!nodeSet.has(n)) throw new Error(`Fixpoint initial node is not in graph: ${n}`);
  }

  const queue: FuncId[] = [...initial];
  const inQueue = new Set<FuncId>(queue);
  let head = 0;

  let steps = 0;
  let changedSteps = 0;

  while (head < queue.length) {
    const n = queue[head++]!;
    inQueue.delete(n);

    steps++;
    if (opts.maxSteps !== undefined && steps > opts.maxSteps) {
      throw new Error(`Fixpoint exceeded maxSteps=${opts.maxSteps}`);
    }

    const changed = opts.step(n);
    if (!changed) continue;
    changedSteps++;

    const depsRaw = opts.dependents ? opts.dependents(n) : (graph.callersByCallee.get(n) ?? []);
    const deps = stableSort(depsRaw, cmpFuncId);
    for (const d of deps) {
      if (!nodeSet.has(d)) throw new Error(`Fixpoint dependent node is not in graph: ${d}`);
      if (inQueue.has(d)) continue;
      inQueue.add(d);
      queue.push(d);
    }
  }

  return { steps, changedSteps };
}

