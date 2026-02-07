import { stableSort } from "./determinism.ts";
import { cmpCallsiteId, cmpFuncId, funcIdToParts, stmtIdToParts } from "./ids.ts";
import type { CallsiteId, FuncId } from "./ids.ts";

export type MappedCallEdge = Readonly<{
  callerFuncId: FuncId;
  calleeFuncId: FuncId;
  callsiteId: CallsiteId;
}>;

export type MappedCallGraphInput = Readonly<{
  // Optional: include isolated functions not present in edges.
  nodes?: readonly FuncId[];
  edges: readonly MappedCallEdge[];
}>;

export type MappedCallGraph = Readonly<{
  // Canonical ordering is defined by normalizeMappedCallGraph.
  nodes: readonly FuncId[];
  // Set semantics; canonical ordering is defined by normalizeMappedCallGraph.
  edges: readonly MappedCallEdge[];

  // Convenience indices.
  outgoingByCaller: ReadonlyMap<FuncId, readonly MappedCallEdge[]>;
  incomingByCallee: ReadonlyMap<FuncId, readonly MappedCallEdge[]>;

  // Caller/callee adjacency (unique, stable-sorted FuncIds).
  calleesByCaller: ReadonlyMap<FuncId, readonly FuncId[]>;
  callersByCallee: ReadonlyMap<FuncId, readonly FuncId[]>;
}>;

function edgeKey(e: MappedCallEdge): string {
  // NUL-delimited so keys can't collide.
  return `${e.callerFuncId}\0${e.calleeFuncId}\0${e.callsiteId}`;
}

function cmpMappedCallEdge(a: MappedCallEdge, b: MappedCallEdge): number {
  return (
    cmpFuncId(a.callerFuncId, b.callerFuncId) ||
    cmpFuncId(a.calleeFuncId, b.calleeFuncId) ||
    cmpCallsiteId(a.callsiteId, b.callsiteId)
  );
}

function cmpMappedCallEdgeByCallee(a: MappedCallEdge, b: MappedCallEdge): number {
  return (
    cmpFuncId(a.calleeFuncId, b.calleeFuncId) ||
    cmpFuncId(a.callerFuncId, b.callerFuncId) ||
    cmpCallsiteId(a.callsiteId, b.callsiteId)
  );
}

function assertCallsiteBelongsToCaller(callsiteId: CallsiteId, callerFuncId: FuncId): void {
  const sp = stmtIdToParts(callsiteId);
  const fp = funcIdToParts(callerFuncId);
  if (sp.filePath !== fp.filePath || sp.startOffset !== fp.startOffset || sp.endOffset !== fp.endOffset) {
    throw new Error(
      `MappedCallEdge.callsiteId must belong to callerFuncId; callsiteId=${callsiteId} callerFuncId=${callerFuncId}`,
    );
  }
}

export function normalizeMappedCallGraph(input: MappedCallGraphInput): MappedCallGraph {
  // Validate edges up-front so later phases can safely assume invariants.
  for (const e of input.edges) assertCallsiteBelongsToCaller(e.callsiteId, e.callerFuncId);

  const nodeSet = new Set<FuncId>();
  if (input.nodes) for (const n of input.nodes) nodeSet.add(n);
  for (const e of input.edges) {
    nodeSet.add(e.callerFuncId);
    nodeSet.add(e.calleeFuncId);
  }

  const nodes = stableSort(Array.from(nodeSet), cmpFuncId);

  // Canonicalize edge ordering and de-dupe deterministically.
  const sortedEdges = stableSort(input.edges, cmpMappedCallEdge);
  const edges: MappedCallEdge[] = [];
  const seenEdgeKeys = new Set<string>();
  for (const e of sortedEdges) {
    const k = edgeKey(e);
    if (seenEdgeKeys.has(k)) continue;
    seenEdgeKeys.add(k);
    edges.push(e);
  }

  const outgoingByCaller = new Map<FuncId, MappedCallEdge[]>();
  for (const e of edges) {
    const arr = outgoingByCaller.get(e.callerFuncId);
    if (arr) arr.push(e);
    else outgoingByCaller.set(e.callerFuncId, [e]);
  }

  const incomingByCallee = new Map<FuncId, MappedCallEdge[]>();
  // Edges are globally sorted by caller; sort again so per-callee arrays are stable-sorted by caller/callsite.
  const edgesByCallee = stableSort(edges, cmpMappedCallEdgeByCallee);
  for (const e of edgesByCallee) {
    const arr = incomingByCallee.get(e.calleeFuncId);
    if (arr) arr.push(e);
    else incomingByCallee.set(e.calleeFuncId, [e]);
  }

  const calleesByCaller = new Map<FuncId, FuncId[]>();
  for (const [caller, outs] of outgoingByCaller) {
    const uniq = new Set<FuncId>();
    for (const e of outs) uniq.add(e.calleeFuncId);
    calleesByCaller.set(caller, stableSort(Array.from(uniq), cmpFuncId));
  }

  const callersByCallee = new Map<FuncId, FuncId[]>();
  for (const [callee, ins] of incomingByCallee) {
    const uniq = new Set<FuncId>();
    for (const e of ins) uniq.add(e.callerFuncId);
    callersByCallee.set(callee, stableSort(Array.from(uniq), cmpFuncId));
  }

  return {
    nodes,
    edges,
    outgoingByCaller,
    incomingByCallee,
    calleesByCaller,
    callersByCallee,
  };
}

