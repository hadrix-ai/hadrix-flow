import { cmpNumber, cmpString, stableSort } from "./determinism.ts";
import { cmpFuncId, createHeapId, createStmtId, heapIdToParts, varIdToParts } from "./ids.ts";
import type { CallsiteId, FuncId, HeapId, StmtId, VarId } from "./ids.ts";
import { runDeterministicFixpoint } from "./fixpoint.ts";
import type { FixpointResult } from "./fixpoint.ts";
import { FLOW_FACT_SCHEMA_VERSION, cmpFlowFact, flowFactKey } from "./flow_fact.ts";
import type { NormalizedFlowFact } from "./flow_fact.ts";
import type { NormalizedFuncSummary } from "./func_summary.ts";
import type { IrRValue, NormalizedFuncIR } from "./ir.ts";
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

function heapReadNode(id: HeapId): LocalNodeKey {
  return `hr\0${id}`;
}

function heapWriteNode(id: HeapId): LocalNodeKey {
  return `hw\0${id}`;
}

function isHeapReadNode(k: LocalNodeKey): boolean {
  return k.startsWith("hr\0");
}

function decodeHeapReadNode(k: LocalNodeKey): HeapId {
  if (!isHeapReadNode(k)) throw new Error(`Invalid heap_read local node key: ${JSON.stringify(k)}`);
  return k.slice("hr\0".length) as HeapId;
}

function isHeapWriteNode(k: LocalNodeKey): boolean {
  return k.startsWith("hw\0");
}

function decodeHeapWriteNode(k: LocalNodeKey): HeapId {
  if (!isHeapWriteNode(k)) throw new Error(`Invalid heap_write local node key: ${JSON.stringify(k)}`);
  return k.slice("hw\0".length) as HeapId;
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

function buildBaseAdjV2(summary: NormalizedFuncSummary): BaseAdj {
  const out = new Map<LocalNodeKey, LocalNodeKey[]>();

  for (const e of summary.edges) {
    let from: LocalNodeKey | null = null;
    if (e.from.kind === "var") from = varNode(e.from.id);
    else if (e.from.kind === "heap_read") from = heapReadNode(e.from.id);
    else continue;

    let to: LocalNodeKey | null = null;
    if (e.to.kind === "var") to = varNode(e.to.id);
    else if (e.to.kind === "call_arg") to = callArgNode(e.to.callsiteId, e.to.index);
    else if (e.to.kind === "return") to = RETURN_NODE;
    else if (e.to.kind === "heap_write") to = heapWriteNode(e.to.id);
    else continue;

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

// Interproc propagation v2: extends v1 with heap lifting across callsites.
//
// Lifted effects (callee -> caller):
// - call_arg(i) -> heap_write(bucket(arg(j), prop)) for callee param i -> heap_write(bucket(param j, prop))
// - heap_read(bucket(arg(j), prop)) -> dst for callee heap_read(bucket(param j, prop)) -> return
// - heap_read(bucket(arg(i), p)) -> heap_write(bucket(arg(j), q)) for callee heap_read(bucket(param i, p)) -> heap_write(bucket(param j, q))

const SYNTHETIC_HEAP_ANCHOR_BASE = 1_000_000_000;
const SYNTHETIC_HEAP_ANCHOR_LOCAL_OFFSET = 500_000_000;

function syntheticHeapAnchorId(funcId: FuncId, id: VarId): StmtId {
  const parts = varIdToParts(id);
  const offset = parts.kind === "p" ? parts.index : SYNTHETIC_HEAP_ANCHOR_LOCAL_OFFSET + parts.index;
  return createStmtId(funcId, SYNTHETIC_HEAP_ANCHOR_BASE + offset);
}

function heapAnchorForVar(anchorByVar: ReadonlyMap<VarId, StmtId>, funcId: FuncId, id: VarId): StmtId {
  return anchorByVar.get(id) ?? syntheticHeapAnchorId(funcId, id);
}

function rvalueToVarId(v: IrRValue): VarId | null {
  return v.kind === "var" ? v.id : null;
}

function computeHeapAnchorByVar(ir: NormalizedFuncIR): ReadonlyMap<VarId, StmtId> {
  const out = new Map<VarId, StmtId>();
  for (const id of ir.params) out.set(id, syntheticHeapAnchorId(ir.funcId, id));
  for (const id of ir.locals) out.set(id, syntheticHeapAnchorId(ir.funcId, id));

  for (const st of ir.stmts) {
    if (st.kind === "assign") {
      const src = rvalueToVarId(st.src);
      if (src) out.set(st.dst, heapAnchorForVar(out, ir.funcId, src));
      else out.set(st.dst, st.stmtId);
      continue;
    }

    if (st.kind === "call") {
      if (st.dst) out.set(st.dst, st.callsiteId);
      continue;
    }

    if (st.kind === "await") {
      out.set(st.dst, st.stmtId);
      continue;
    }

    if (st.kind === "alloc") {
      out.set(st.dst, st.stmtId);
      continue;
    }

    if (st.kind === "member_read") {
      out.set(st.dst, st.stmtId);
      continue;
    }

    if (st.kind === "select" || st.kind === "short_circuit") {
      out.set(st.dst, st.stmtId);
      continue;
    }
  }

  return out;
}

function heapIdToSyntheticParamIndex(id: HeapId): number | null {
  const parts = heapIdToParts(id);
  const i = parts.statementIndex;
  if (
    i >= SYNTHETIC_HEAP_ANCHOR_BASE &&
    i < SYNTHETIC_HEAP_ANCHOR_BASE + SYNTHETIC_HEAP_ANCHOR_LOCAL_OFFSET
  ) {
    return i - SYNTHETIC_HEAP_ANCHOR_BASE;
  }
  return null;
}

type LiftableParamHeapWriteEffect = Readonly<{
  valueParamIndex: number;
  objectParamIndex: number;
  propertyName: string;
}>;

type LiftableHeapReadReturnEffect = Readonly<{
  objectParamIndex: number;
  propertyName: string;
}>;

type LiftableHeapReadHeapWriteEffect = Readonly<{
  readObjectParamIndex: number;
  readPropertyName: string;
  writeObjectParamIndex: number;
  writePropertyName: string;
}>;

type CallsiteInfoV2 = Readonly<{
  dst: VarId | null;
  argCount: number;
  argVars: readonly (VarId | null)[];
}>;

type FuncInputV2 = Readonly<{
  funcId: FuncId;
  ir: NormalizedFuncIR;
  baseAdj: BaseAdj;
  callsites: ReadonlyMap<CallsiteId, CallsiteInfoV2>;
  heapAnchorByVar: ReadonlyMap<VarId, StmtId>;
}>;

type FuncStateV2 = Readonly<{
  facts: readonly NormalizedFlowFact[];
  factKeys: readonly string[];
  paramReturnIndices: readonly number[];
  paramHeapWriteEffects: readonly LiftableParamHeapWriteEffect[];
  heapReadReturnEffects: readonly LiftableHeapReadReturnEffect[];
  heapReadHeapWriteEffects: readonly LiftableHeapReadHeapWriteEffect[];
}>;

function mapHeapBucketToCaller(
  func: FuncInputV2,
  callsite: CallsiteInfoV2,
  argIndex: number,
  propertyName: string,
): HeapId | null {
  if (argIndex < 0 || argIndex >= callsite.argCount) return null;
  const argVar = callsite.argVars[argIndex];
  if (!argVar) return null;
  const anchor = heapAnchorForVar(func.heapAnchorByVar, func.funcId, argVar);
  return createHeapId(anchor, propertyName);
}

function cmpLiftableParamHeapWriteEffect(a: LiftableParamHeapWriteEffect, b: LiftableParamHeapWriteEffect): number {
  return (
    cmpNumber(a.valueParamIndex, b.valueParamIndex) ||
    cmpNumber(a.objectParamIndex, b.objectParamIndex) ||
    cmpString(a.propertyName, b.propertyName)
  );
}

function cmpLiftableHeapReadReturnEffect(a: LiftableHeapReadReturnEffect, b: LiftableHeapReadReturnEffect): number {
  return cmpNumber(a.objectParamIndex, b.objectParamIndex) || cmpString(a.propertyName, b.propertyName);
}

function cmpLiftableHeapReadHeapWriteEffect(a: LiftableHeapReadHeapWriteEffect, b: LiftableHeapReadHeapWriteEffect): number {
  return (
    cmpNumber(a.readObjectParamIndex, b.readObjectParamIndex) ||
    cmpString(a.readPropertyName, b.readPropertyName) ||
    cmpNumber(a.writeObjectParamIndex, b.writeObjectParamIndex) ||
    cmpString(a.writePropertyName, b.writePropertyName)
  );
}

function computeFuncStateV2(
  func: FuncInputV2,
  opts: Readonly<{
    calleesByCallsite: ReadonlyMap<CallsiteId, readonly FuncId[]>;
    stateByFuncId: ReadonlyMap<FuncId, FuncStateV2>;
  }>,
): FuncStateV2 {
  const extraAdj = new Map<LocalNodeKey, LocalNodeKey[]>();

  for (const [callsiteId, info] of func.callsites) {
    const callees = opts.calleesByCallsite.get(callsiteId) ?? [];

    // Return lifting (v1 behavior).
    if (info.dst) {
      const idxSet = new Set<number>();
      for (const calleeFuncId of callees) {
        const s = opts.stateByFuncId.get(calleeFuncId);
        if (!s) continue;
        for (const idx of s.paramReturnIndices) {
          if (idx >= info.argCount) continue;
          idxSet.add(idx);
        }
      }

      const idxs = stableSort(Array.from(idxSet), cmpNumber);
      for (const idx of idxs) {
        const from = callArgNode(callsiteId, idx);
        const to = varNode(info.dst);
        const arr = extraAdj.get(from);
        if (arr) arr.push(to);
        else extraAdj.set(from, [to]);
      }
    }

    // Param -> heap_write lifting.
    {
      const uniq = new Set<string>();
      const effects: LiftableParamHeapWriteEffect[] = [];

      for (const calleeFuncId of callees) {
        const s = opts.stateByFuncId.get(calleeFuncId);
        if (!s) continue;
        for (const e of s.paramHeapWriteEffects) {
          if (e.valueParamIndex >= info.argCount) continue;
          if (e.objectParamIndex >= info.argCount) continue;
          const k = `${e.valueParamIndex}\0${e.objectParamIndex}\0${e.propertyName}`;
          if (uniq.has(k)) continue;
          uniq.add(k);
          effects.push(e);
        }
      }

      const sorted = stableSort(effects, cmpLiftableParamHeapWriteEffect);
      for (const e of sorted) {
        const heapId = mapHeapBucketToCaller(func, info, e.objectParamIndex, e.propertyName);
        if (!heapId) continue;
        const from = callArgNode(callsiteId, e.valueParamIndex);
        const to = heapWriteNode(heapId);
        const arr = extraAdj.get(from);
        if (arr) arr.push(to);
        else extraAdj.set(from, [to]);
      }
    }

    // heap_read -> return lifting.
    if (info.dst) {
      const uniq = new Set<string>();
      const effects: LiftableHeapReadReturnEffect[] = [];

      for (const calleeFuncId of callees) {
        const s = opts.stateByFuncId.get(calleeFuncId);
        if (!s) continue;
        for (const e of s.heapReadReturnEffects) {
          if (e.objectParamIndex >= info.argCount) continue;
          const k = `${e.objectParamIndex}\0${e.propertyName}`;
          if (uniq.has(k)) continue;
          uniq.add(k);
          effects.push(e);
        }
      }

      const sorted = stableSort(effects, cmpLiftableHeapReadReturnEffect);
      for (const e of sorted) {
        const heapId = mapHeapBucketToCaller(func, info, e.objectParamIndex, e.propertyName);
        if (!heapId) continue;
        const from = heapReadNode(heapId);
        const to = varNode(info.dst);
        const arr = extraAdj.get(from);
        if (arr) arr.push(to);
        else extraAdj.set(from, [to]);
      }
    }

    // heap_read -> heap_write lifting.
    {
      const uniq = new Set<string>();
      const effects: LiftableHeapReadHeapWriteEffect[] = [];

      for (const calleeFuncId of callees) {
        const s = opts.stateByFuncId.get(calleeFuncId);
        if (!s) continue;
        for (const e of s.heapReadHeapWriteEffects) {
          if (e.readObjectParamIndex >= info.argCount) continue;
          if (e.writeObjectParamIndex >= info.argCount) continue;
          const k = `${e.readObjectParamIndex}\0${e.readPropertyName}\0${e.writeObjectParamIndex}\0${e.writePropertyName}`;
          if (uniq.has(k)) continue;
          uniq.add(k);
          effects.push(e);
        }
      }

      const sorted = stableSort(effects, cmpLiftableHeapReadHeapWriteEffect);
      for (const e of sorted) {
        const readHeapId = mapHeapBucketToCaller(func, info, e.readObjectParamIndex, e.readPropertyName);
        const writeHeapId = mapHeapBucketToCaller(func, info, e.writeObjectParamIndex, e.writePropertyName);
        if (!readHeapId || !writeHeapId) continue;
        const from = heapReadNode(readHeapId);
        const to = heapWriteNode(writeHeapId);
        const arr = extraAdj.get(from);
        if (arr) arr.push(to);
        else extraAdj.set(from, [to]);
      }
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
      } else if (isHeapWriteNode(cur)) {
        const heapId = decodeHeapWriteNode(cur);
        const fact: NormalizedFlowFact = {
          schemaVersion: FLOW_FACT_SCHEMA_VERSION,
          from: { kind: "var", funcId: func.funcId, id: paramId },
          to: { kind: "heap_write", id: heapId },
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

  const heapReadSources = new Set<LocalNodeKey>();
  for (const k of func.baseAdj.keys()) if (isHeapReadNode(k)) heapReadSources.add(k);
  for (const k of extraAdj.keys()) if (isHeapReadNode(k)) heapReadSources.add(k);
  const heapReadSourceList = stableSort(Array.from(heapReadSources), cmpString);

  for (const heapReadKey of heapReadSourceList) {
    const heapId = decodeHeapReadNode(heapReadKey);

    const visited = new Set<LocalNodeKey>([heapReadKey]);
    const queue: LocalNodeKey[] = [heapReadKey];

    while (queue.length > 0) {
      const cur = queue.shift()!;

      if (cur === RETURN_NODE) {
        const fact: NormalizedFlowFact = {
          schemaVersion: FLOW_FACT_SCHEMA_VERSION,
          from: { kind: "heap_read", id: heapId },
          to: { kind: "return", funcId: func.funcId },
        };
        factsByKey.set(flowFactKey(fact), fact);
      } else if (isCallArgNode(cur)) {
        const { callsiteId, index } = decodeCallArgNode(cur);
        const fact: NormalizedFlowFact = {
          schemaVersion: FLOW_FACT_SCHEMA_VERSION,
          from: { kind: "heap_read", id: heapId },
          to: { kind: "call_arg", callsiteId, index },
        };
        factsByKey.set(flowFactKey(fact), fact);
      } else if (isHeapWriteNode(cur)) {
        const toHeapId = decodeHeapWriteNode(cur);
        const fact: NormalizedFlowFact = {
          schemaVersion: FLOW_FACT_SCHEMA_VERSION,
          from: { kind: "heap_read", id: heapId },
          to: { kind: "heap_write", id: toHeapId },
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

  const paramHeapWriteEffectsByKey = new Map<string, LiftableParamHeapWriteEffect>();
  const heapReadReturnEffectsByKey = new Map<string, LiftableHeapReadReturnEffect>();
  const heapReadHeapWriteEffectsByKey = new Map<string, LiftableHeapReadHeapWriteEffect>();

  for (const f of facts) {
    if (f.from.kind === "var" && f.to.kind === "heap_write") {
      const fromParts = varIdToParts(f.from.id);
      if (fromParts.kind !== "p") continue;
      const objectParamIndex = heapIdToSyntheticParamIndex(f.to.id);
      if (objectParamIndex === null || objectParamIndex >= func.ir.params.length) continue;
      const propertyName = heapIdToParts(f.to.id).propertyName;
      const eff: LiftableParamHeapWriteEffect = {
        valueParamIndex: fromParts.index,
        objectParamIndex,
        propertyName,
      };
      paramHeapWriteEffectsByKey.set(`${eff.valueParamIndex}\0${eff.objectParamIndex}\0${eff.propertyName}`, eff);
      continue;
    }

    if (f.from.kind === "heap_read" && f.to.kind === "return") {
      const objectParamIndex = heapIdToSyntheticParamIndex(f.from.id);
      if (objectParamIndex === null || objectParamIndex >= func.ir.params.length) continue;
      const propertyName = heapIdToParts(f.from.id).propertyName;
      const eff: LiftableHeapReadReturnEffect = { objectParamIndex, propertyName };
      heapReadReturnEffectsByKey.set(`${eff.objectParamIndex}\0${eff.propertyName}`, eff);
      continue;
    }

    if (f.from.kind === "heap_read" && f.to.kind === "heap_write") {
      const readObjectParamIndex = heapIdToSyntheticParamIndex(f.from.id);
      const writeObjectParamIndex = heapIdToSyntheticParamIndex(f.to.id);
      if (readObjectParamIndex === null || writeObjectParamIndex === null) continue;
      if (readObjectParamIndex >= func.ir.params.length) continue;
      if (writeObjectParamIndex >= func.ir.params.length) continue;
      const readPropertyName = heapIdToParts(f.from.id).propertyName;
      const writePropertyName = heapIdToParts(f.to.id).propertyName;
      const eff: LiftableHeapReadHeapWriteEffect = {
        readObjectParamIndex,
        readPropertyName,
        writeObjectParamIndex,
        writePropertyName,
      };
      heapReadHeapWriteEffectsByKey.set(
        `${eff.readObjectParamIndex}\0${eff.readPropertyName}\0${eff.writeObjectParamIndex}\0${eff.writePropertyName}`,
        eff,
      );
    }
  }

  const paramHeapWriteEffects = stableSort([...paramHeapWriteEffectsByKey.values()], cmpLiftableParamHeapWriteEffect);
  const heapReadReturnEffects = stableSort([...heapReadReturnEffectsByKey.values()], cmpLiftableHeapReadReturnEffect);
  const heapReadHeapWriteEffects = stableSort(
    [...heapReadHeapWriteEffectsByKey.values()],
    cmpLiftableHeapReadHeapWriteEffect,
  );

  return {
    facts,
    factKeys,
    paramReturnIndices,
    paramHeapWriteEffects,
    heapReadReturnEffects,
    heapReadHeapWriteEffects,
  };
}

export type InterprocPropagationV2Inputs = InterprocPropagationV1Inputs;
export type InterprocPropagationV2Result = InterprocPropagationV1Result;

export function runInterprocPropagationV2(
  inputs: InterprocPropagationV2Inputs,
  opts?: Readonly<{ maxSteps?: number }>,
): InterprocPropagationV2Result {
  const funcInputs = new Map<FuncId, FuncInputV2>();
  for (const funcId of inputs.graph.nodes) {
    const ir = inputs.irByFuncId.get(funcId);
    const summary = inputs.summaryByFuncId.get(funcId);
    if (!ir) throw new Error(`Missing IR for function in call graph: ${funcId}`);
    if (!summary) throw new Error(`Missing summary for function in call graph: ${funcId}`);

    const callsites = new Map<CallsiteId, CallsiteInfoV2>();
    for (const st of ir.stmts) {
      if (st.kind !== "call") continue;
      const argVars = st.args.map((a) => (a.kind === "var" ? a.id : null));
      callsites.set(st.callsiteId, { dst: st.dst, argCount: st.args.length, argVars });
    }

    funcInputs.set(funcId, {
      funcId,
      ir,
      baseAdj: buildBaseAdjV2(summary),
      callsites,
      heapAnchorByVar: computeHeapAnchorByVar(ir),
    });
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

  const stateByFuncId = new Map<FuncId, FuncStateV2>();

  const fixpoint = runDeterministicFixpoint(inputs.graph, {
    maxSteps: opts?.maxSteps,
    step: (funcId) => {
      const func = funcInputs.get(funcId);
      if (!func) throw new Error(`Internal error: missing FuncInput for ${funcId}`);
      const calleesByCallsite = calleesByCallsiteByCaller.get(funcId) ?? new Map();

      const next = computeFuncStateV2(func, { calleesByCallsite, stateByFuncId });
      const prev = stateByFuncId.get(funcId);
      if (prev && arraysEqual(prev.factKeys, next.factKeys)) return false;
      stateByFuncId.set(funcId, next);
      return true;
    },
  });

  const factsByFuncId = new Map<FuncId, readonly NormalizedFlowFact[]>();
  const allFacts: NormalizedFlowFact[] = [];
  for (const funcId of inputs.graph.nodes) {
    const s = stateByFuncId.get(funcId) ?? {
      facts: [],
      factKeys: [],
      paramReturnIndices: [],
      paramHeapWriteEffects: [],
      heapReadReturnEffects: [],
      heapReadHeapWriteEffects: [],
    };
    factsByFuncId.set(funcId, s.facts);
    allFacts.push(...s.facts);
  }

  // Global canonical ordering and de-dupe (set semantics).
  const unique = new Map<string, NormalizedFlowFact>();
  for (const f of allFacts) unique.set(flowFactKey(f), f);
  const facts = stableSort([...unique.values()], cmpFlowFact);

  return { fixpoint, facts, factsByFuncId };
}
