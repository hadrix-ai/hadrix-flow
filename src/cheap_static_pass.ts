import { cmpNumber, stableSort } from "./determinism.ts";
import { cmpCallsiteId, cmpVarId } from "./ids.ts";
import type { CallsiteId, FuncId, VarId } from "./ids.ts";
import type { IrRValue, NormalizedFuncIR } from "./ir.ts";

// Cheap static pass v1:
// - x = y          => y -> x
// - return y       => y -> return
// - f(..., y, ...) => y -> callArg(callsiteId, index)
//
// This pass is intentionally conservative and only emits edges when the source is a VarId.

export type CheapDepNode =
  | Readonly<{ kind: "var"; id: VarId }>
  | Readonly<{ kind: "call_arg"; callsiteId: CallsiteId; index: number }>
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
  return "r";
}

function edgeKey(e: CheapDepEdge): string {
  return `${nodeKey(e.from)}->${nodeKey(e.to)}`;
}

const NODE_KIND_ORDER: Readonly<Record<CheapDepNode["kind"], number>> = {
  var: 0,
  call_arg: 1,
  return: 2,
};

export function cmpCheapDepNode(a: CheapDepNode, b: CheapDepNode): number {
  const ka = NODE_KIND_ORDER[a.kind];
  const kb = NODE_KIND_ORDER[b.kind];
  if (ka !== kb) return cmpNumber(ka, kb);

  if (a.kind === "var" && b.kind === "var") return cmpVarId(a.id, b.id);

  if (a.kind === "call_arg" && b.kind === "call_arg") {
    return cmpCallsiteId(a.callsiteId, b.callsiteId) || cmpNumber(a.index, b.index);
  }

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

