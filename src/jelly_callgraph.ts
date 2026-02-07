import { readFileSync } from "node:fs";

import { canonicalJsonStringify, cmpNumber, cmpString, stableSort } from "./determinism.ts";

export const JELLY_CALL_GRAPH_SCHEMA_VERSION = 1 as const;

export type JellyCallGraphSchemaVersion = typeof JELLY_CALL_GRAPH_SCHEMA_VERSION;

export type JellyFunctionNode = Readonly<{
  // Unique within the file. Opaque to Hadrix Flow.
  id: string;
  // Optional display name (diagnostics only).
  name: string | null;
  // Repo-relative, POSIX-separated (for example: "src/a.ts").
  filePath: string;
  // UTF-16 code unit offsets in TypeScript coordinates.
  startOffset: number;
  endOffset: number;
}>;

export type JellyCallsiteSpan = Readonly<{
  filePath: string;
  startOffset: number;
  endOffset: number;
}>;

export type JellyCallEdgeKind = "call" | "construct";

export type JellyCallEdge = Readonly<{
  callerId: string;
  calleeId: string;
  callsite: JellyCallsiteSpan;
  kind: JellyCallEdgeKind;
}>;

export type JellyCallGraph = Readonly<{
  schemaVersion: JellyCallGraphSchemaVersion;
  // Canonical ordering is defined by normalizeJellyCallGraph.
  nodes: readonly JellyFunctionNode[];
  // Set semantics; canonical ordering is defined by normalizeJellyCallGraph.
  edges: readonly JellyCallEdge[];

  // Convenience index (iteration order is nodes' canonical ordering).
  nodeById: ReadonlyMap<string, JellyFunctionNode>;
}>;

export type NormalizedJellyCallGraph = JellyCallGraph;

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

function assertNoExtraKeys(obj: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  for (const k of Object.keys(obj)) {
    if (!allowedSet.has(k)) throw new Error(`${label} has unknown key ${JSON.stringify(k)}`);
  }
}

function assertNonEmptyString(value: string, label: string): string {
  if (value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function assertNonNegativeSafeInt(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer; got ${value}`);
  }
  return value;
}

function normalizeRepoRelPosixPath(value: unknown, label: string): string {
  const p = assertNonEmptyString(expectString(value, label), label);

  // Strict mode: require canonical, repo-relative POSIX paths.
  if (p.includes("\\")) {
    throw new Error(`${label} must use '/' separators; got ${JSON.stringify(p)}`);
  }
  if (p.startsWith("/")) {
    throw new Error(`${label} must be repo-relative (not absolute): got ${JSON.stringify(p)}`);
  }
  if (/^[A-Za-z]:/.test(p) || p.startsWith("//")) {
    throw new Error(`${label} must be repo-relative (not absolute): got ${JSON.stringify(p)}`);
  }
  if (p === "." || p.startsWith("./")) {
    throw new Error(`${label} must not use a './' prefix: got ${JSON.stringify(p)}`);
  }

  const segments = p.split("/");
  for (const seg of segments) {
    if (seg.length === 0) throw new Error(`${label} must not contain empty path segments: got ${JSON.stringify(p)}`);
    if (seg === "." || seg === "..") {
      throw new Error(`${label} must not contain '.' or '..' segments: got ${JSON.stringify(p)}`);
    }
  }

  return p;
}

function normalizeSpan(value: unknown, label: string): JellyCallsiteSpan {
  const obj = expectPlainObject(value, label);
  assertNoExtraKeys(obj, ["filePath", "startOffset", "endOffset"], label);

  const filePath = normalizeRepoRelPosixPath(obj.filePath, `${label}.filePath`);
  const startOffset = assertNonNegativeSafeInt(expectNumber(obj.startOffset, `${label}.startOffset`), `${label}.startOffset`);
  const endOffset = assertNonNegativeSafeInt(expectNumber(obj.endOffset, `${label}.endOffset`), `${label}.endOffset`);
  if (endOffset < startOffset) {
    throw new Error(`${label}.endOffset must be >= ${label}.startOffset; got ${endOffset} < ${startOffset}`);
  }
  return { filePath, startOffset, endOffset };
}

function normalizeNode(value: unknown, label: string): JellyFunctionNode {
  const obj = expectPlainObject(value, label);
  assertNoExtraKeys(obj, ["id", "name", "filePath", "startOffset", "endOffset"], label);

  const id = assertNonEmptyString(expectString(obj.id, `${label}.id`), `${label}.id`);
  const name = obj.name === undefined ? null : expectString(obj.name, `${label}.name`);
  const filePath = normalizeRepoRelPosixPath(obj.filePath, `${label}.filePath`);
  const startOffset = assertNonNegativeSafeInt(expectNumber(obj.startOffset, `${label}.startOffset`), `${label}.startOffset`);
  const endOffset = assertNonNegativeSafeInt(expectNumber(obj.endOffset, `${label}.endOffset`), `${label}.endOffset`);
  if (endOffset < startOffset) {
    throw new Error(`${label}.endOffset must be >= ${label}.startOffset; got ${endOffset} < ${startOffset}`);
  }

  return { id, name, filePath, startOffset, endOffset };
}

function normalizeEdge(value: unknown, nodeIds: ReadonlySet<string>, label: string): JellyCallEdge {
  const obj = expectPlainObject(value, label);
  assertNoExtraKeys(obj, ["callerId", "calleeId", "callsite", "kind"], label);

  const callerId = assertNonEmptyString(expectString(obj.callerId, `${label}.callerId`), `${label}.callerId`);
  const calleeId = assertNonEmptyString(expectString(obj.calleeId, `${label}.calleeId`), `${label}.calleeId`);
  if (!nodeIds.has(callerId)) throw new Error(`${label}.callerId references unknown node id: ${JSON.stringify(callerId)}`);
  if (!nodeIds.has(calleeId)) throw new Error(`${label}.calleeId references unknown node id: ${JSON.stringify(calleeId)}`);

  const callsite = normalizeSpan(obj.callsite, `${label}.callsite`);

  const rawKind = obj.kind;
  const kind: JellyCallEdgeKind =
    rawKind === undefined
      ? "call"
      : (() => {
          const k = expectString(rawKind, `${label}.kind`);
          if (k !== "call" && k !== "construct") {
            throw new Error(`${label}.kind must be "call" or "construct"; got ${JSON.stringify(k)}`);
          }
          return k;
        })();

  return { callerId, calleeId, callsite, kind };
}

function cmpJellyFunctionNode(a: JellyFunctionNode, b: JellyFunctionNode): number {
  return (
    cmpString(a.filePath, b.filePath) ||
    cmpNumber(a.startOffset, b.startOffset) ||
    cmpNumber(a.endOffset, b.endOffset) ||
    cmpString(a.id, b.id)
  );
}

function cmpJellyCallEdge(a: JellyCallEdge, b: JellyCallEdge): number {
  return (
    cmpString(a.callerId, b.callerId) ||
    cmpString(a.calleeId, b.calleeId) ||
    cmpString(a.callsite.filePath, b.callsite.filePath) ||
    cmpNumber(a.callsite.startOffset, b.callsite.startOffset) ||
    cmpNumber(a.callsite.endOffset, b.callsite.endOffset) ||
    cmpString(a.kind, b.kind)
  );
}

function jellyEdgeKey(e: JellyCallEdge): string {
  // Canonical JSON ensures keys can't collide based on delimiter choice.
  return canonicalJsonStringify(e);
}

export function normalizeJellyCallGraph(value: unknown): NormalizedJellyCallGraph {
  const obj = expectPlainObject(value, "JellyCallGraph");
  assertNoExtraKeys(obj, ["schemaVersion", "nodes", "edges"], "JellyCallGraph");

  const schemaVersion = obj.schemaVersion;
  if (schemaVersion !== JELLY_CALL_GRAPH_SCHEMA_VERSION) {
    throw new Error(
      `JellyCallGraph.schemaVersion must be ${JELLY_CALL_GRAPH_SCHEMA_VERSION}; got ${JSON.stringify(schemaVersion)}`,
    );
  }

  const rawNodes = expectArray(obj.nodes, "JellyCallGraph.nodes");
  const nodes: JellyFunctionNode[] = [];
  const nodeIds = new Set<string>();
  for (let i = 0; i < rawNodes.length; i++) {
    const n = normalizeNode(rawNodes[i], `JellyCallGraph.nodes[${i}]`);
    if (nodeIds.has(n.id)) throw new Error(`JellyCallGraph.nodes contains duplicate id: ${JSON.stringify(n.id)}`);
    nodeIds.add(n.id);
    nodes.push(n);
  }

  const rawEdges = expectArray(obj.edges, "JellyCallGraph.edges");
  const edges: JellyCallEdge[] = [];
  for (let i = 0; i < rawEdges.length; i++) {
    edges.push(normalizeEdge(rawEdges[i], nodeIds, `JellyCallGraph.edges[${i}]`));
  }

  const sortedNodes = stableSort(nodes, cmpJellyFunctionNode);

  const sortedEdges = stableSort(edges, cmpJellyCallEdge);
  const seenEdgeKeys = new Set<string>();
  const dedupedEdges: JellyCallEdge[] = [];
  for (const e of sortedEdges) {
    const k = jellyEdgeKey(e);
    if (seenEdgeKeys.has(k)) continue;
    seenEdgeKeys.add(k);
    dedupedEdges.push(e);
  }

  const nodeById = new Map<string, JellyFunctionNode>();
  for (const n of sortedNodes) nodeById.set(n.id, n);

  return {
    schemaVersion: JELLY_CALL_GRAPH_SCHEMA_VERSION,
    nodes: sortedNodes,
    edges: dedupedEdges,
    nodeById,
  };
}

export function loadJellyCallGraphFromFile(filePath: string): NormalizedJellyCallGraph {
  const raw = readFileSync(filePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse Jelly call graph JSON: file=${JSON.stringify(filePath)} error=${msg}`);
  }
  try {
    return normalizeJellyCallGraph(parsed);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid Jelly call graph: file=${JSON.stringify(filePath)} error=${msg}`);
  }
}

