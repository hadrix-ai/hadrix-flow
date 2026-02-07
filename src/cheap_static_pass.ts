import { cmpNumber, stableSort } from "./determinism.ts";
import { cmpCallsiteId, cmpHeapId, cmpVarId, createHeapId, createStmtId, varIdToParts } from "./ids.ts";
import type { CallsiteId, FuncId, HeapId, StmtId, VarId } from "./ids.ts";
import type { IrPropertyKey, IrRValue, NormalizedFuncIR } from "./ir.ts";

// Cheap static pass v1:
// - x = y          => y -> x
// - return y       => y -> return
// - f(..., y, ...) => y -> callArg(callsiteId, index)
//
// This pass is intentionally conservative and only emits edges when the source is a VarId.

export type CheapDepNode =
  | Readonly<{ kind: "var"; id: VarId }>
  | Readonly<{ kind: "call_arg"; callsiteId: CallsiteId; index: number }>
  | Readonly<{ kind: "heap_read"; id: HeapId }>
  | Readonly<{ kind: "heap_write"; id: HeapId }>
  | Readonly<{ kind: "return" }>;

export type CheapDepEdge = Readonly<{
  from: CheapDepNode;
  to: CheapDepNode;
}>;

export type CheapStaticPassV1Result = Readonly<{
  funcId: FuncId;
  edges: readonly CheapDepEdge[];
}>;

function nodeKey(n: CheapDepNode): string {
  if (n.kind === "var") return `v:${n.id}`;
  if (n.kind === "call_arg") return `a:${n.callsiteId}:${n.index}`;
  if (n.kind === "heap_read") return `hr:${n.id}`;
  if (n.kind === "heap_write") return `hw:${n.id}`;
  return "r";
}

function edgeKey(e: CheapDepEdge): string {
  return `${nodeKey(e.from)}->${nodeKey(e.to)}`;
}

const NODE_KIND_ORDER: Readonly<Record<CheapDepNode["kind"], number>> = {
  var: 0,
  call_arg: 1,
  heap_read: 2,
  heap_write: 3,
  return: 4,
};

export function cmpCheapDepNode(a: CheapDepNode, b: CheapDepNode): number {
  const ka = NODE_KIND_ORDER[a.kind];
  const kb = NODE_KIND_ORDER[b.kind];
  if (ka !== kb) return cmpNumber(ka, kb);

  if (a.kind === "var" && b.kind === "var") return cmpVarId(a.id, b.id);

  if (a.kind === "call_arg" && b.kind === "call_arg") {
    return cmpCallsiteId(a.callsiteId, b.callsiteId) || cmpNumber(a.index, b.index);
  }

  if (a.kind === "heap_read" && b.kind === "heap_read") return cmpHeapId(a.id, b.id);
  if (a.kind === "heap_write" && b.kind === "heap_write") return cmpHeapId(a.id, b.id);

  return 0;
}

export function cmpCheapDepEdge(a: CheapDepEdge, b: CheapDepEdge): number {
  return cmpCheapDepNode(a.from, b.from) || cmpCheapDepNode(a.to, b.to);
}

function rvalueToVarId(v: IrRValue): VarId | null {
  return v.kind === "var" ? v.id : null;
}

export function runCheapStaticPassV1(ir: NormalizedFuncIR): CheapStaticPassV1Result {
  const edges: CheapDepEdge[] = [];

  for (const st of ir.stmts) {
    if (st.kind === "assign") {
      const src = rvalueToVarId(st.src);
      if (!src) continue;
      edges.push({ from: { kind: "var", id: src }, to: { kind: "var", id: st.dst } });
      continue;
    }

    if (st.kind === "return") {
      if (!st.value) continue;
      const src = rvalueToVarId(st.value);
      if (!src) continue;
      edges.push({ from: { kind: "var", id: src }, to: { kind: "return" } });
      continue;
    }

    if (st.kind === "call") {
      for (let i = 0; i < st.args.length; i++) {
        const src = rvalueToVarId(st.args[i]!);
        if (!src) continue;
        edges.push({
          from: { kind: "var", id: src },
          to: { kind: "call_arg", callsiteId: st.callsiteId, index: i },
        });
      }
    }
  }

  // Deduplicate (set semantics) and sort deterministically.
  const uniqueByKey = new Map<string, CheapDepEdge>();
  for (const e of edges) uniqueByKey.set(edgeKey(e), e);

  return {
    funcId: ir.funcId,
    edges: stableSort([...uniqueByKey.values()], cmpCheapDepEdge),
  };
}

// Cheap static pass v2 extends v1 with member read/write heap edges:
// - obj.p = y => y -> heapWrite(HeapId(anchor(obj), p))
// - x = obj.p => heapRead(HeapId(anchor(obj), p)) -> x
//
// Heap bucketing rules (cheap / deterministic):
// - Each VarId has a "heap anchor" StmtId.
// - Initially, each VarId is assigned a synthetic anchor derived from its VarId (stable across runs).
// - Assignments propagate or reset anchors:
//   - dst = srcVar => anchor(dst) = anchor(srcVar)
//   - dst = <non-var> => anchor(dst) = stmtId (fresh value identity)
//   - dst = call(...) => anchor(dst) = callsiteId
//   - dst = await ... => anchor(dst) = stmtId
//
// This is deliberately coarse: it is good enough to bucket property reads/writes deterministically
// without requiring full alias/points-to analysis.

export type CheapStaticPassV2Result = Readonly<{
  funcId: FuncId;
  edges: readonly CheapDepEdge[];
}>;

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

function propertyKeyToBucketName(p: IrPropertyKey): string {
  return p.kind === "named" ? p.name : "*";
}

export function runCheapStaticPassV2(ir: NormalizedFuncIR): CheapStaticPassV2Result {
  const edges: CheapDepEdge[] = [];

  // VarId -> StmtId (heap anchor). Prepopulate with synthetic anchors so params/this can bucket.
  const heapAnchorByVar = new Map<VarId, StmtId>();
  for (const id of ir.params) heapAnchorByVar.set(id, syntheticHeapAnchorId(ir.funcId, id));
  for (const id of ir.locals) heapAnchorByVar.set(id, syntheticHeapAnchorId(ir.funcId, id));

  for (const st of ir.stmts) {
    if (st.kind === "assign") {
      const src = rvalueToVarId(st.src);
      if (src) {
        edges.push({ from: { kind: "var", id: src }, to: { kind: "var", id: st.dst } });
        heapAnchorByVar.set(st.dst, heapAnchorForVar(heapAnchorByVar, ir.funcId, src));
      } else {
        // Fresh identity for non-var RHS.
        heapAnchorByVar.set(st.dst, st.stmtId);
      }
      continue;
    }

    if (st.kind === "return") {
      if (!st.value) continue;
      const src = rvalueToVarId(st.value);
      if (!src) continue;
      edges.push({ from: { kind: "var", id: src }, to: { kind: "return" } });
      continue;
    }

    if (st.kind === "call") {
      for (let i = 0; i < st.args.length; i++) {
        const src = rvalueToVarId(st.args[i]!);
        if (!src) continue;
        edges.push({
          from: { kind: "var", id: src },
          to: { kind: "call_arg", callsiteId: st.callsiteId, index: i },
        });
      }

      if (st.dst) heapAnchorByVar.set(st.dst, st.callsiteId);
      continue;
    }

    if (st.kind === "await") {
      heapAnchorByVar.set(st.dst, st.stmtId);
      continue;
    }

    if (st.kind === "alloc") {
      heapAnchorByVar.set(st.dst, st.stmtId);
      continue;
    }

    if (st.kind === "member_read") {
      const anchor = heapAnchorForVar(heapAnchorByVar, ir.funcId, st.object);
      const bucket = createHeapId(anchor, propertyKeyToBucketName(st.property));
      edges.push({ from: { kind: "heap_read", id: bucket }, to: { kind: "var", id: st.dst } });
      heapAnchorByVar.set(st.dst, st.stmtId);
      continue;
    }

    if (st.kind === "member_write") {
      const src = rvalueToVarId(st.value);
      if (src) {
        const anchor = heapAnchorForVar(heapAnchorByVar, ir.funcId, st.object);
        const bucket = createHeapId(anchor, propertyKeyToBucketName(st.property));
        edges.push({ from: { kind: "var", id: src }, to: { kind: "heap_write", id: bucket } });
      }
      continue;
    }

    if (st.kind === "select" || st.kind === "short_circuit") {
      // The cheap pass doesn't model these expressions, but dst receives a fresh value.
      heapAnchorByVar.set(st.dst, st.stmtId);
      continue;
    }
  }

  // Deduplicate (set semantics) and sort deterministically.
  const uniqueByKey = new Map<string, CheapDepEdge>();
  for (const e of edges) uniqueByKey.set(edgeKey(e), e);

  return {
    funcId: ir.funcId,
    edges: stableSort([...uniqueByKey.values()], cmpCheapDepEdge),
  };
}
