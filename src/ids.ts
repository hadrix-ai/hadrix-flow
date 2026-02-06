import { cmpNumber, cmpString } from "./determinism.ts";

type BrandedString<B extends string> = string & { readonly __brand: B };

export type FuncId = BrandedString<"FuncId">;
export type StmtId = BrandedString<"StmtId">;

// By architecture, callsite IDs are statement IDs for call expressions.
export type CallsiteId = StmtId;

export type VarId = BrandedString<"VarId">;
export type HeapId = BrandedString<"HeapId">;

export type FuncIdParts = Readonly<{
  filePath: string;
  startOffset: number;
  endOffset: number;
}>;

export type StmtIdParts = Readonly<
  FuncIdParts & {
    statementIndex: number;
  }
>;

export type VarIdParts = Readonly<{
  kind: "p" | "v";
  index: number;
}>;

export type HeapIdParts = Readonly<
  StmtIdParts & {
    propertyName: string;
  }
>;

function assertNonEmptyString(value: string, label: string): void {
  if (value.length === 0) throw new Error(`${label} must be a non-empty string`);
}

function assertNonNegativeSafeInt(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer; got ${value}`);
  }
  return value;
}

function parseCanonicalNonNegativeInt(text: string, label: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(text)) {
    throw new Error(`${label} must be a canonical non-negative int; got ${JSON.stringify(text)}`);
  }
  const n = Number(text);
  if (!Number.isSafeInteger(n)) throw new Error(`${label} is out of range; got ${JSON.stringify(text)}`);
  return n;
}

function decodeCanonicalUriComponent(encoded: string, label: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`${label} is not valid URI component encoding: ${JSON.stringify(encoded)} (${msg})`);
  }

  const reencoded = encodeURIComponent(decoded);
  if (reencoded !== encoded) {
    throw new Error(
      `${label} must use canonical URI component encoding; expected ${JSON.stringify(reencoded)}, got ${JSON.stringify(encoded)}`,
    );
  }

  return decoded;
}

function parseFuncIdParts(text: string): FuncIdParts {
  const parts = text.split(":");
  if (parts.length !== 4 || parts[0] !== "f") {
    throw new Error(`Invalid FuncId: ${JSON.stringify(text)}`);
  }
  const filePath = decodeCanonicalUriComponent(parts[1]!, "FuncId.filePath");
  assertNonEmptyString(filePath, "FuncId.filePath");
  const startOffset = parseCanonicalNonNegativeInt(parts[2]!, "FuncId.startOffset");
  const endOffset = parseCanonicalNonNegativeInt(parts[3]!, "FuncId.endOffset");
  if (endOffset < startOffset) {
    throw new Error(`FuncId.endOffset must be >= startOffset; got ${startOffset}..${endOffset}`);
  }
  return { filePath, startOffset, endOffset };
}

function parseStmtIdParts(text: string): StmtIdParts {
  const parts = text.split(":");
  if (parts.length !== 5 || parts[0] !== "s") {
    throw new Error(`Invalid StmtId: ${JSON.stringify(text)}`);
  }
  const filePath = decodeCanonicalUriComponent(parts[1]!, "StmtId.filePath");
  assertNonEmptyString(filePath, "StmtId.filePath");
  const startOffset = parseCanonicalNonNegativeInt(parts[2]!, "StmtId.startOffset");
  const endOffset = parseCanonicalNonNegativeInt(parts[3]!, "StmtId.endOffset");
  if (endOffset < startOffset) {
    throw new Error(`StmtId.endOffset must be >= startOffset; got ${startOffset}..${endOffset}`);
  }
  const statementIndex = parseCanonicalNonNegativeInt(parts[4]!, "StmtId.statementIndex");
  return { filePath, startOffset, endOffset, statementIndex };
}

function parseHeapIdParts(text: string): HeapIdParts {
  const parts = text.split(":");
  if (parts.length !== 6 || parts[0] !== "h") {
    throw new Error(`Invalid HeapId: ${JSON.stringify(text)}`);
  }
  const filePath = decodeCanonicalUriComponent(parts[1]!, "HeapId.filePath");
  assertNonEmptyString(filePath, "HeapId.filePath");
  const startOffset = parseCanonicalNonNegativeInt(parts[2]!, "HeapId.startOffset");
  const endOffset = parseCanonicalNonNegativeInt(parts[3]!, "HeapId.endOffset");
  if (endOffset < startOffset) {
    throw new Error(`HeapId.endOffset must be >= startOffset; got ${startOffset}..${endOffset}`);
  }
  const statementIndex = parseCanonicalNonNegativeInt(parts[4]!, "HeapId.statementIndex");
  const propertyName = decodeCanonicalUriComponent(parts[5]!, "HeapId.propertyName");
  assertNonEmptyString(propertyName, "HeapId.propertyName");
  return { filePath, startOffset, endOffset, statementIndex, propertyName };
}

export function createFuncId(filePath: string, startOffset: number, endOffset: number): FuncId {
  assertNonEmptyString(filePath, "filePath");
  const s = assertNonNegativeSafeInt(startOffset, "startOffset");
  const e = assertNonNegativeSafeInt(endOffset, "endOffset");
  if (e < s) throw new Error(`endOffset must be >= startOffset; got ${s}..${e}`);
  return `f:${encodeURIComponent(filePath)}:${s}:${e}` as FuncId;
}

export function parseFuncId(text: string): FuncId {
  const p = parseFuncIdParts(text);
  const canonical = createFuncId(p.filePath, p.startOffset, p.endOffset);
  if (canonical !== text) throw new Error(`Non-canonical FuncId: expected ${JSON.stringify(canonical)}, got ${JSON.stringify(text)}`);
  return text as FuncId;
}

export function stringifyFuncId(id: FuncId): string {
  return id;
}

export function funcIdToParts(id: FuncId): FuncIdParts {
  // IDs are created via create/parse, so we accept the overhead of validating here.
  return parseFuncIdParts(id);
}

export function cmpFuncId(a: FuncId, b: FuncId): number {
  const ap = funcIdToParts(a);
  const bp = funcIdToParts(b);
  return (
    cmpString(ap.filePath, bp.filePath) ||
    cmpNumber(ap.startOffset, bp.startOffset) ||
    cmpNumber(ap.endOffset, bp.endOffset)
  );
}

export function createStmtId(funcId: FuncId, statementIndex: number): StmtId {
  const fp = funcIdToParts(funcId);
  const i = assertNonNegativeSafeInt(statementIndex, "statementIndex");
  return `s:${encodeURIComponent(fp.filePath)}:${fp.startOffset}:${fp.endOffset}:${i}` as StmtId;
}

export function parseStmtId(text: string): StmtId {
  const p = parseStmtIdParts(text);
  const f = createFuncId(p.filePath, p.startOffset, p.endOffset);
  const canonical = createStmtId(f, p.statementIndex);
  if (canonical !== text) throw new Error(`Non-canonical StmtId: expected ${JSON.stringify(canonical)}, got ${JSON.stringify(text)}`);
  return text as StmtId;
}

export function stringifyStmtId(id: StmtId): string {
  return id;
}

export function stmtIdToParts(id: StmtId): StmtIdParts {
  return parseStmtIdParts(id);
}

export function cmpStmtId(a: StmtId, b: StmtId): number {
  const ap = stmtIdToParts(a);
  const bp = stmtIdToParts(b);
  return (
    cmpString(ap.filePath, bp.filePath) ||
    cmpNumber(ap.startOffset, bp.startOffset) ||
    cmpNumber(ap.endOffset, bp.endOffset) ||
    cmpNumber(ap.statementIndex, bp.statementIndex)
  );
}

export function parseCallsiteId(text: string): CallsiteId {
  return parseStmtId(text);
}

export function stringifyCallsiteId(id: CallsiteId): string {
  return stringifyStmtId(id);
}

export function cmpCallsiteId(a: CallsiteId, b: CallsiteId): number {
  return cmpStmtId(a, b);
}

export function createParamVarId(index: number): VarId {
  const i = assertNonNegativeSafeInt(index, "index");
  return `p${i}` as VarId;
}

export function createLocalVarId(index: number): VarId {
  const i = assertNonNegativeSafeInt(index, "index");
  return `v${i}` as VarId;
}

export function parseVarId(text: string): VarId {
  const m = /^(p|v)(0|[1-9][0-9]*)$/.exec(text);
  if (!m) throw new Error(`Invalid VarId: ${JSON.stringify(text)}`);
  const index = parseCanonicalNonNegativeInt(m[2]!, "VarId.index");
  // Ensure safe-integer range (regex may still match huge values).
  assertNonNegativeSafeInt(index, "VarId.index");
  return text as VarId;
}

export function stringifyVarId(id: VarId): string {
  return id;
}

export function varIdToParts(id: VarId): VarIdParts {
  const m = /^(p|v)(0|[1-9][0-9]*)$/.exec(id);
  if (!m) throw new Error(`Invalid VarId: ${JSON.stringify(id)}`);
  const kind = m[1]! as "p" | "v";
  const index = parseCanonicalNonNegativeInt(m[2]!, "VarId.index");
  assertNonNegativeSafeInt(index, "VarId.index");
  return { kind, index };
}

export function cmpVarId(a: VarId, b: VarId): number {
  const ap = varIdToParts(a);
  const bp = varIdToParts(b);
  if (ap.kind !== bp.kind) return ap.kind === "p" ? -1 : 1;
  return cmpNumber(ap.index, bp.index);
}

export function createHeapId(allocationSiteId: StmtId, propertyName: string): HeapId {
  const sp = stmtIdToParts(allocationSiteId);
  assertNonEmptyString(propertyName, "propertyName");
  return `h:${encodeURIComponent(sp.filePath)}:${sp.startOffset}:${sp.endOffset}:${sp.statementIndex}:${encodeURIComponent(propertyName)}` as HeapId;
}

export function parseHeapId(text: string): HeapId {
  const p = parseHeapIdParts(text);
  const f = createFuncId(p.filePath, p.startOffset, p.endOffset);
  const s = createStmtId(f, p.statementIndex);
  const canonical = createHeapId(s, p.propertyName);
  if (canonical !== text) throw new Error(`Non-canonical HeapId: expected ${JSON.stringify(canonical)}, got ${JSON.stringify(text)}`);
  return text as HeapId;
}

export function stringifyHeapId(id: HeapId): string {
  return id;
}

export function heapIdToParts(id: HeapId): HeapIdParts {
  return parseHeapIdParts(id);
}

export function cmpHeapId(a: HeapId, b: HeapId): number {
  const ap = heapIdToParts(a);
  const bp = heapIdToParts(b);
  return (
    cmpString(ap.filePath, bp.filePath) ||
    cmpNumber(ap.startOffset, bp.startOffset) ||
    cmpNumber(ap.endOffset, bp.endOffset) ||
    cmpNumber(ap.statementIndex, bp.statementIndex) ||
    cmpString(ap.propertyName, bp.propertyName)
  );
}

