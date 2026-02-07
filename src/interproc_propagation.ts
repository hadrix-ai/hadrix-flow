import { cmpNumber, stableSort } from "./determinism.ts";
import { cmpFuncId, varIdToParts } from "./ids.ts";
import type { CallsiteId, FuncId, VarId } from "./ids.ts";
import { runDeterministicFixpoint } from "./fixpoint.ts";
import type { FixpointResult } from "./fixpoint.ts";
import { FLOW_FACT_SCHEMA_VERSION, cmpFlowFact, flowFactKey } from "./flow_fact.ts";
import type { NormalizedFlowFact } from "./flow_fact.ts";
import type { NormalizedFuncSummary } from "./func_summary.ts";
import type { NormalizedFuncIR } from "./ir.ts";
import type { MappedCallGraph } from "./mapped_callgraph.ts";

type LocalNodeKey = string;

const RETURN_NODE: LocalNodeKey = "r";

function varNode(id: VarId): LocalNodeKey {
  return `v\0${id}`;
}

function callArgNode(callsiteId: CallsiteId, index: number): LocalNodeKey {
  return `a\0${callsiteId}\0${index}`;
}

function isCallArgNode(k: LocalNodeKey): boolean {
  return k.startsWith("a\0");
}

function decodeCallArgNode(k: LocalNodeKey): Readonly<{ callsiteId: CallsiteId; index: number }> {
  const parts = k.split("\0");
  if (parts.length !== 3 || parts[0] !== "a") throw new Error(`Invalid call_arg local node key: ${JSON.stringify(k)}`);
  const callsiteId = parts[1]! as CallsiteId;
  const index = Number(parts[2]);
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new Error(`Invalid call_arg local node index: ${JSON.stringify(k)}`);
  }
  return { callsiteId, index };
}

type BaseAdj = ReadonlyMap<LocalNodeKey, readonly LocalNodeKey[]>;

function buildBaseAdj(summary: NormalizedFuncSummary): BaseAdj {
  const out = new Map<LocalNodeKey, LocalNodeKey[]>();

  for (const e of summary.edges) {
    if (e.from.kind !== "var") continue; // v1 ignores heap_read sources.

    const from = varNode(e.from.id);
    let to: LocalNodeKey | null = null;

    if (e.to.kind === "var") to = varNode(e.to.id);
    else if (e.to.kind === "call_arg") to = callArgNode(e.to.callsiteId, e.to.index);
    else if (e.to.kind === "return") to = RETURN_NODE;
    else continue; // v1 ignores heap_write targets.

    const arr = out.get(from);
    if (arr) arr.push(to);
    else out.set(from, [to]);
  }

  return out;
}

type CallsiteInfo = Readonly<{
  dst: VarId | null;
  argCount: number;
}>;

type FuncInput = Readonly<{
  funcId: FuncId;
  ir: NormalizedFuncIR;
  baseAdj: BaseAdj;
  callsites: ReadonlyMap<CallsiteId, CallsiteInfo>;
}>;

type FuncState = Readonly<{
  facts: readonly NormalizedFlowFact[];
  factKeys: readonly string[];
  paramReturnIndices: readonly number[];
}>;

export type InterprocPropagationV1Inputs = Readonly<{
  graph: MappedCallGraph;
  irByFuncId: ReadonlyMap<FuncId, NormalizedFuncIR>;
  summaryByFuncId: ReadonlyMap<FuncId, NormalizedFuncSummary>;
}>;

export type InterprocPropagationV1Result = Readonly<{
  fixpoint: FixpointResult;
  facts: readonly NormalizedFlowFact[];
  factsByFuncId: ReadonlyMap<FuncId, readonly NormalizedFlowFact[]>;
}>;

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function computeFuncState(
  func: FuncInput,
  opts: Readonly<{
    calleesByCallsite: ReadonlyMap<CallsiteId, readonly FuncId[]>;
    stateByFuncId: ReadonlyMap<FuncId, FuncState>;
  }>,
): FuncState {
  // Build call-return edges based on callee param->return dependencies.
  const extraAdj = new Map<LocalNodeKey, LocalNodeKey[]>();

  for (const [callsiteId, info] of func.callsites) {
    if (!info.dst) continue;

    const callees = opts.calleesByCallsite.get(callsiteId) ?? [];

    const idxSet = new Set<number>();
    for (const calleeFuncId of callees) {
      const s = opts.stateByFuncId.get(calleeFuncId);
      if (!s) continue;
      for (const idx of s.paramReturnIndices) {
        if (idx >= info.argCount) continue;
        idxSet.add(idx);
      }
    }

    if (idxSet.size === 0) continue;
    const idxs = stableSort(Array.from(idxSet), cmpNumber);

    for (const idx of idxs) {
      const from = callArgNode(callsiteId, idx);
      const to = varNode(info.dst);
      const arr = extraAdj.get(from);
      if (arr) arr.push(to);
      else extraAdj.set(from, [to]);
    }
  }

  const getNeighbors = (n: LocalNodeKey): readonly LocalNodeKey[] => {
    const a = func.baseAdj.get(n);
    const b = extraAdj.get(n);
    if (!a) return b ?? [];
    if (!b) return a;
    return [...a, ...b];
  };

  const factsByKey = new Map<string, NormalizedFlowFact>();
  const paramReturnIdxSet = new Set<number>();

  for (const paramId of func.ir.params) {
    const parts = varIdToParts(paramId);
    if (parts.kind !== "p") throw new Error(`IR.params must contain only p* VarIds; got ${paramId}`);
    const fromNode = varNode(paramId);

    const visited = new Set<LocalNodeKey>([fromNode]);
    const queue: LocalNodeKey[] = [fromNode];

    while (queue.length > 0) {
      const cur = queue.shift()!;

      if (cur === RETURN_NODE) {
        const fact: NormalizedFlowFact = {
          schemaVersion: FLOW_FACT_SCHEMA_VERSION,
          from: { kind: "var", funcId: func.funcId, id: paramId },
          to: { kind: "return", funcId: func.funcId },
        };
        factsByKey.set(flowFactKey(fact), fact);
        paramReturnIdxSet.add(parts.index);
      } else if (isCallArgNode(cur)) {
        const { callsiteId, index } = decodeCallArgNode(cur);
        const fact: NormalizedFlowFact = {
          schemaVersion: FLOW_FACT_SCHEMA_VERSION,
          from: { kind: "var", funcId: func.funcId, id: paramId },
          to: { kind: "call_arg", callsiteId, index },
        };
        factsByKey.set(flowFactKey(fact), fact);
      }

      for (const next of getNeighbors(cur)) {
        if (visited.has(next)) continue;
        visited.add(next);
        queue.push(next);
      }
    }
  }

  const facts = stableSort([...factsByKey.values()], cmpFlowFact);
  const factKeys = facts.map(flowFactKey);
  const paramReturnIndices = stableSort(Array.from(paramReturnIdxSet), cmpNumber);

  return { facts, factKeys, paramReturnIndices };
}

export function runInterprocPropagationV1(
  inputs: InterprocPropagationV1Inputs,
  opts?: Readonly<{ maxSteps?: number }>,
): InterprocPropagationV1Result {
  const funcInputs = new Map<FuncId, FuncInput>();
  for (const funcId of inputs.graph.nodes) {
    const ir = inputs.irByFuncId.get(funcId);
    const summary = inputs.summaryByFuncId.get(funcId);
    if (!ir) throw new Error(`Missing IR for function in call graph: ${funcId}`);
    if (!summary) throw new Error(`Missing summary for function in call graph: ${funcId}`);

    const callsites = new Map<CallsiteId, CallsiteInfo>();
    for (const st of ir.stmts) {
      if (st.kind !== "call") continue;
      callsites.set(st.callsiteId, { dst: st.dst, argCount: st.args.length });
    }

    funcInputs.set(funcId, { funcId, ir, baseAdj: buildBaseAdj(summary), callsites });
  }

  // CallerFuncId -> CallsiteId -> CalleeFuncIds (set semantics; stable order).
  const calleesByCallsiteByCaller = new Map<FuncId, Map<CallsiteId, readonly FuncId[]>>();
  for (const callerFuncId of inputs.graph.nodes) {
    const outs = inputs.graph.outgoingByCaller.get(callerFuncId) ?? [];
    const byCallsite = new Map<CallsiteId, FuncId[]>();
    for (const e of outs) {
      const arr = byCallsite.get(e.callsiteId);
      if (arr) arr.push(e.calleeFuncId);
      else byCallsite.set(e.callsiteId, [e.calleeFuncId]);
    }

    const stable = new Map<CallsiteId, readonly FuncId[]>();
    for (const [callsiteId, callees] of byCallsite) {
      // De-dupe deterministically.
      const uniq = new Set<FuncId>(callees);
      stable.set(callsiteId, stableSort(Array.from(uniq), cmpFuncId));
    }

    calleesByCallsiteByCaller.set(callerFuncId, stable);
  }

  const stateByFuncId = new Map<FuncId, FuncState>();

  const fixpoint = runDeterministicFixpoint(inputs.graph, {
    maxSteps: opts?.maxSteps,
    step: (funcId) => {
      const func = funcInputs.get(funcId);
      if (!func) throw new Error(`Internal error: missing FuncInput for ${funcId}`);
      const calleesByCallsite = calleesByCallsiteByCaller.get(funcId) ?? new Map();

      const next = computeFuncState(func, { calleesByCallsite, stateByFuncId });
      const prev = stateByFuncId.get(funcId);
      if (prev && arraysEqual(prev.factKeys, next.factKeys)) return false;
      stateByFuncId.set(funcId, next);
      return true;
    },
  });

  const factsByFuncId = new Map<FuncId, readonly NormalizedFlowFact[]>();
  const allFacts: NormalizedFlowFact[] = [];
  for (const funcId of inputs.graph.nodes) {
    const s = stateByFuncId.get(funcId) ?? { facts: [], factKeys: [], paramReturnIndices: [] };
    factsByFuncId.set(funcId, s.facts);
    allFacts.push(...s.facts);
  }

  // Global canonical ordering and de-dupe (set semantics).
  const unique = new Map<string, NormalizedFlowFact>();
  for (const f of allFacts) unique.set(flowFactKey(f), f);
  const facts = stableSort([...unique.values()], cmpFlowFact);

  return { fixpoint, facts, factsByFuncId };
}
