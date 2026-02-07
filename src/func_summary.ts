import { canonicalJsonStringify, cmpNumber, stableSort } from "./determinism.ts";
import {
  cmpCallsiteId,
  cmpHeapId,
  cmpVarId,
  funcIdToParts,
  heapIdToParts,
  parseCallsiteId,
  parseFuncId,
  parseHeapId,
  parseVarId,
} from "./ids.ts";
import type { CallsiteId, FuncId, HeapId, VarId } from "./ids.ts";
import type { NormalizedFuncIR } from "./ir.ts";

export const FUNC_SUMMARY_SCHEMA_VERSION = 1 as const;

export type FuncSummarySchemaVersion = typeof FUNC_SUMMARY_SCHEMA_VERSION;

export type FuncSummaryNode =
  | Readonly<{ kind: "var"; id: VarId }>
  | Readonly<{ kind: "call_arg"; callsiteId: CallsiteId; index: number }>
  | Readonly<{ kind: "heap_read"; id: HeapId }>
  | Readonly<{ kind: "heap_write"; id: HeapId }>
  | Readonly<{ kind: "return" }>;

export type FuncSummaryEdge = Readonly<{
  from: FuncSummaryNode;
  to: FuncSummaryNode;
}>;

export type FuncSummary = Readonly<{
  schemaVersion: FuncSummarySchemaVersion;
  funcId: FuncId;
  // Set semantics; canonical ordering is defined by normalizeFuncSummary.
  edges: readonly FuncSummaryEdge[];
}>;

export type NormalizedFuncSummary = FuncSummary;

export type FuncSummaryBounds = Readonly<{
  maxEdges: number;
  maxFanout: number;
}>;

export const DEFAULT_FUNC_SUMMARY_BOUNDS: FuncSummaryBounds = {
  maxEdges: 25_000,
  maxFanout: 5_000,
};

export type NormalizeFuncSummaryOptions = Readonly<{
  ir: NormalizedFuncIR;
  baselineEdges: readonly FuncSummaryEdge[];
  bounds?: Partial<FuncSummaryBounds>;
}>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function expectPlainObject(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    const t = value === null ? "null" : typeof value;
    throw new Error(`${label} must be a plain object; got ${t}`);
  }
  return value;
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function expectNumber(value: unknown, label: string): number {
  if (typeof value !== "number") throw new Error(`${label} must be a number`);
  if (!Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
  return value;
}

function expectArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function assertPositiveSafeInt(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer; got ${value}`);
  }
  return value;
}

function assertNonNegativeSafeInt(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer; got ${value}`);
  }
  return value;
}

function assertNoExtraKeys(obj: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  for (const k of Object.keys(obj)) {
    if (!allowedSet.has(k)) throw new Error(`${label} has unknown key ${JSON.stringify(k)}`);
  }
}

function nodeKey(n: FuncSummaryNode): string {
  if (n.kind === "var") return `v:${n.id}`;
  if (n.kind === "call_arg") return `a:${n.callsiteId}:${n.index}`;
  if (n.kind === "heap_read") return `hr:${n.id}`;
  if (n.kind === "heap_write") return `hw:${n.id}`;
  return "r";
}

function edgeKey(e: FuncSummaryEdge): string {
  return `${nodeKey(e.from)}->${nodeKey(e.to)}`;
}

const NODE_KIND_ORDER: Readonly<Record<FuncSummaryNode["kind"], number>> = {
  var: 0,
  call_arg: 1,
  heap_read: 2,
  heap_write: 3,
  return: 4,
};

function cmpFuncSummaryNode(a: FuncSummaryNode, b: FuncSummaryNode): number {
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

function cmpFuncSummaryEdge(a: FuncSummaryEdge, b: FuncSummaryEdge): number {
  return cmpFuncSummaryNode(a.from, b.from) || cmpFuncSummaryNode(a.to, b.to);
}

function assertNodeAllowedPosition(kind: FuncSummaryNode["kind"], position: "from" | "to", label: string): void {
  if (position === "from") {
    if (kind === "return" || kind === "call_arg" || kind === "heap_write") {
      throw new Error(`${label} may not appear in edge from-position: ${JSON.stringify(kind)}`);
    }
    return;
  }

  // position === "to"
  if (kind === "heap_read") throw new Error(`${label} may not appear in edge to-position: ${JSON.stringify(kind)}`);
}

type NodeNormalizeCtx = Readonly<{
  funcId: FuncId;
  declaredVars: ReadonlySet<string>;
  callsiteArgCount: ReadonlyMap<string, number>;
  declaredHeapIds: ReadonlySet<string>;
}>;

function normalizeFuncSummaryNode(
  value: unknown,
  ctx: NodeNormalizeCtx,
  position: "from" | "to",
  label: string,
): FuncSummaryNode {
  const obj = expectPlainObject(value, label);
  const kind = expectString(obj.kind, `${label}.kind`) as FuncSummaryNode["kind"];
  assertNodeAllowedPosition(kind, position, `${label}.kind`);

  if (kind === "var") {
    assertNoExtraKeys(obj, ["kind", "id"], label);
    const id = parseVarId(expectString(obj.id, `${label}.id`));
    if (!ctx.declaredVars.has(id)) throw new Error(`${label}.id references undeclared VarId: ${id}`);
    return { kind: "var", id };
  }

  if (kind === "call_arg") {
    assertNoExtraKeys(obj, ["kind", "callsiteId", "index"], label);
    const callsiteId = parseCallsiteId(expectString(obj.callsiteId, `${label}.callsiteId`));
    const argCount = ctx.callsiteArgCount.get(callsiteId);
    if (argCount === undefined) throw new Error(`${label}.callsiteId references undeclared CallsiteId: ${callsiteId}`);

    const index = assertNonNegativeSafeInt(expectNumber(obj.index, `${label}.index`), `${label}.index`);
    if (index >= argCount) {
      throw new Error(`${label}.index is out of range for callsiteId=${callsiteId}: got ${index}, want < ${argCount}`);
    }
    return { kind: "call_arg", callsiteId, index };
  }

  if (kind === "heap_read" || kind === "heap_write") {
    assertNoExtraKeys(obj, ["kind", "id"], label);
    const id = parseHeapId(expectString(obj.id, `${label}.id`));
    if (!ctx.declaredHeapIds.has(id)) throw new Error(`${label}.id references undeclared HeapId: ${id}`);
    const parts = heapIdToParts(id);
    const fp = funcIdToParts(ctx.funcId);
    if (parts.filePath !== fp.filePath || parts.startOffset !== fp.startOffset || parts.endOffset !== fp.endOffset) {
      throw new Error(`${label}.id must belong to funcId=${ctx.funcId}; got ${id}`);
    }
    return kind === "heap_read" ? { kind: "heap_read", id } : { kind: "heap_write", id };
  }

  if (kind === "return") {
    assertNoExtraKeys(obj, ["kind"], label);
    return { kind: "return" };
  }

  throw new Error(`${label}.kind is not a supported FuncSummaryNode kind: ${JSON.stringify(kind)}`);
}

function normalizeFuncSummaryEdge(value: unknown, ctx: NodeNormalizeCtx, label: string): FuncSummaryEdge {
  const obj = expectPlainObject(value, label);
  assertNoExtraKeys(obj, ["from", "to"], label);

  const from = normalizeFuncSummaryNode(obj.from, ctx, "from", `${label}.from`);
  const to = normalizeFuncSummaryNode(obj.to, ctx, "to", `${label}.to`);
  return { from, to };
}

function collectDeclaredHeapIds(baselineEdges: readonly FuncSummaryEdge[]): ReadonlySet<string> {
  const out = new Set<string>();
  const add = (n: FuncSummaryNode): void => {
    if (n.kind === "heap_read" || n.kind === "heap_write") out.add(n.id);
  };
  for (const e of baselineEdges) {
    add(e.from);
    add(e.to);
  }
  return out;
}

export function normalizeFuncSummary(value: unknown, opts: NormalizeFuncSummaryOptions): NormalizedFuncSummary {
  const maxEdges = assertPositiveSafeInt(
    opts.bounds?.maxEdges ?? DEFAULT_FUNC_SUMMARY_BOUNDS.maxEdges,
    "FuncSummary.bounds.maxEdges",
  );
  const maxFanout = assertPositiveSafeInt(
    opts.bounds?.maxFanout ?? DEFAULT_FUNC_SUMMARY_BOUNDS.maxFanout,
    "FuncSummary.bounds.maxFanout",
  );

  const obj = expectPlainObject(value, "FuncSummary");
  assertNoExtraKeys(obj, ["schemaVersion", "funcId", "edges"], "FuncSummary");

  const schemaVersion = obj.schemaVersion;
  if (schemaVersion !== FUNC_SUMMARY_SCHEMA_VERSION) {
    throw new Error(
      `FuncSummary.schemaVersion must be ${FUNC_SUMMARY_SCHEMA_VERSION}; got ${JSON.stringify(schemaVersion)}`,
    );
  }

  const funcId = parseFuncId(expectString(obj.funcId, "FuncSummary.funcId"));
  if (funcId !== opts.ir.funcId) {
    throw new Error(`FuncSummary.funcId must match IR.funcId=${opts.ir.funcId}; got ${funcId}`);
  }

  const declaredVars = new Set<string>([...opts.ir.params, ...opts.ir.locals]);
  const callsiteArgCount = new Map<string, number>();
  for (const st of opts.ir.stmts) {
    if (st.kind !== "call") continue;
    callsiteArgCount.set(st.callsiteId, st.args.length);
  }

  const declaredHeapIds = collectDeclaredHeapIds(opts.baselineEdges);
  const ctx: NodeNormalizeCtx = { funcId, declaredVars, callsiteArgCount, declaredHeapIds };

  const rawEdges = expectArray(obj.edges, "FuncSummary.edges");
  const uniqueByKey = new Map<string, FuncSummaryEdge>();
  for (let i = 0; i < rawEdges.length; i++) {
    const e = normalizeFuncSummaryEdge(rawEdges[i], ctx, `FuncSummary.edges[${i}]`);
    uniqueByKey.set(edgeKey(e), e);
  }

  const edges = stableSort([...uniqueByKey.values()], cmpFuncSummaryEdge);
  if (edges.length > maxEdges) {
    throw new Error(`FuncSummary.edges exceeds maxEdges=${maxEdges}; got ${edges.length}`);
  }

  const fanoutByFrom = new Map<string, number>();
  for (const e of edges) {
    const k = nodeKey(e.from);
    const next = (fanoutByFrom.get(k) ?? 0) + 1;
    fanoutByFrom.set(k, next);
    if (next > maxFanout) {
      throw new Error(`FuncSummary.edges fanout exceeds maxFanout=${maxFanout} for from=${k}; got ${next}`);
    }
  }

  // Baseline coverage: enforce cheap-pass edges are present as a subset.
  const edgeKeySet = new Set<string>();
  for (const e of edges) edgeKeySet.add(edgeKey(e));

  const missing: string[] = [];
  for (const be of opts.baselineEdges) {
    const k = edgeKey(be);
    if (!edgeKeySet.has(k)) missing.push(k);
  }
  if (missing.length > 0) {
    const shown = stableSort(missing, (a, b) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, 10);
    throw new Error(`FuncSummary.edges is missing ${missing.length} baseline edge(s); e.g. ${shown.join(", ")}`);
  }

  return { schemaVersion: FUNC_SUMMARY_SCHEMA_VERSION, funcId, edges };
}

export function serializeNormalizedFuncSummary(summary: NormalizedFuncSummary): string {
  return canonicalJsonStringify(summary);
}
