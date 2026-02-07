import { canonicalJsonStringify, cmpNumber } from "./determinism.ts";
import {
  cmpCallsiteId,
  cmpFuncId,
  cmpHeapId,
  cmpVarId,
  parseCallsiteId,
  parseFuncId,
  parseHeapId,
  parseVarId,
} from "./ids.ts";
import type { CallsiteId, FuncId, HeapId, VarId } from "./ids.ts";

export const FLOW_FACT_SCHEMA_VERSION = 1 as const;

export type FlowFactSchemaVersion = typeof FLOW_FACT_SCHEMA_VERSION;

export type FlowNode =
  | Readonly<{ kind: "var"; funcId: FuncId; id: VarId }>
  | Readonly<{ kind: "call_arg"; callsiteId: CallsiteId; index: number }>
  | Readonly<{ kind: "heap_read"; id: HeapId }>
  | Readonly<{ kind: "heap_write"; id: HeapId }>
  | Readonly<{ kind: "return"; funcId: FuncId }>;

export type FlowFact = Readonly<{
  schemaVersion: FlowFactSchemaVersion;
  from: FlowNode;
  to: FlowNode;
}>;

export type NormalizedFlowFact = FlowFact;

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

function normalizeFlowNode(value: unknown, label: string): FlowNode {
  const obj = expectPlainObject(value, label);
  const kind = expectString(obj.kind, `${label}.kind`) as FlowNode["kind"];

  if (kind === "var") {
    assertNoExtraKeys(obj, ["kind", "funcId", "id"], label);
    const funcId = parseFuncId(expectString(obj.funcId, `${label}.funcId`));
    const id = parseVarId(expectString(obj.id, `${label}.id`));
    return { kind: "var", funcId, id };
  }

  if (kind === "call_arg") {
    assertNoExtraKeys(obj, ["kind", "callsiteId", "index"], label);
    const callsiteId = parseCallsiteId(expectString(obj.callsiteId, `${label}.callsiteId`));
    const index = assertNonNegativeSafeInt(expectNumber(obj.index, `${label}.index`), `${label}.index`);
    return { kind: "call_arg", callsiteId, index };
  }

  if (kind === "heap_read" || kind === "heap_write") {
    assertNoExtraKeys(obj, ["kind", "id"], label);
    const id = parseHeapId(expectString(obj.id, `${label}.id`));
    return kind === "heap_read" ? { kind: "heap_read", id } : { kind: "heap_write", id };
  }

  if (kind === "return") {
    assertNoExtraKeys(obj, ["kind", "funcId"], label);
    const funcId = parseFuncId(expectString(obj.funcId, `${label}.funcId`));
    return { kind: "return", funcId };
  }

  throw new Error(`${label}.kind is not a supported FlowNode kind: ${JSON.stringify(kind)}`);
}

export function normalizeFlowFact(value: unknown): NormalizedFlowFact {
  const obj = expectPlainObject(value, "FlowFact");
  assertNoExtraKeys(obj, ["schemaVersion", "from", "to"], "FlowFact");

  const schemaVersion = obj.schemaVersion;
  if (schemaVersion !== FLOW_FACT_SCHEMA_VERSION) {
    throw new Error(
      `FlowFact.schemaVersion must be ${FLOW_FACT_SCHEMA_VERSION}; got ${JSON.stringify(schemaVersion)}`,
    );
  }

  const from = normalizeFlowNode(obj.from, "FlowFact.from");
  const to = normalizeFlowNode(obj.to, "FlowFact.to");
  return { schemaVersion: FLOW_FACT_SCHEMA_VERSION, from, to };
}

export function serializeNormalizedFlowFact(fact: NormalizedFlowFact): string {
  return canonicalJsonStringify(fact);
}

const NODE_KIND_ORDER: Readonly<Record<FlowNode["kind"], number>> = {
  var: 0,
  call_arg: 1,
  heap_read: 2,
  heap_write: 3,
  return: 4,
};

export function cmpFlowNode(a: FlowNode, b: FlowNode): number {
  const ka = NODE_KIND_ORDER[a.kind];
  const kb = NODE_KIND_ORDER[b.kind];
  if (ka !== kb) return cmpNumber(ka, kb);

  if (a.kind === "var" && b.kind === "var") return cmpFuncId(a.funcId, b.funcId) || cmpVarId(a.id, b.id);

  if (a.kind === "call_arg" && b.kind === "call_arg") {
    return cmpCallsiteId(a.callsiteId, b.callsiteId) || cmpNumber(a.index, b.index);
  }

  if (a.kind === "heap_read" && b.kind === "heap_read") return cmpHeapId(a.id, b.id);
  if (a.kind === "heap_write" && b.kind === "heap_write") return cmpHeapId(a.id, b.id);

  if (a.kind === "return" && b.kind === "return") return cmpFuncId(a.funcId, b.funcId);

  return 0;
}

export function cmpFlowFact(a: NormalizedFlowFact, b: NormalizedFlowFact): number {
  return cmpFlowNode(a.from, b.from) || cmpFlowNode(a.to, b.to);
}

function flowNodeKey(n: FlowNode): string {
  if (n.kind === "var") return `v:${n.funcId}:${n.id}`;
  if (n.kind === "call_arg") return `a:${n.callsiteId}:${n.index}`;
  if (n.kind === "heap_read") return `hr:${n.id}`;
  if (n.kind === "heap_write") return `hw:${n.id}`;
  return `r:${n.funcId}`;
}

export function flowFactKey(f: NormalizedFlowFact): string {
  return `${flowNodeKey(f.from)}->${flowNodeKey(f.to)}`;
}

