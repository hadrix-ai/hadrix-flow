import { canonicalJsonStringify, stableSort } from "./determinism.ts";
import {
  cmpStmtId,
  cmpVarId,
  funcIdToParts,
  parseCallsiteId,
  parseFuncId,
  parseStmtId,
  parseVarId,
  stmtIdToParts,
  varIdToParts,
} from "./ids.ts";
import type { CallsiteId, FuncId, StmtId, VarId } from "./ids.ts";

export const FUNC_IR_SCHEMA_VERSION = 1 as const;

export type IrSchemaVersion = typeof FUNC_IR_SCHEMA_VERSION;

export type IrRValue =
  | Readonly<{ kind: "var"; id: VarId }>
  | Readonly<{ kind: "lit"; value: string | number | boolean | null }>
  | Readonly<{ kind: "undef" }>
  | Readonly<{ kind: "unknown" }>;

export type IrPropertyKey = Readonly<{ kind: "named"; name: string }> | Readonly<{ kind: "dynamic" }>;

export type IrStmt =
  | Readonly<{
      kind: "assign";
      stmtId: StmtId;
      dst: VarId;
      src: IrRValue;
    }>
  | Readonly<{
      kind: "return";
      stmtId: StmtId;
      value: IrRValue | null;
    }>
  | Readonly<{
      kind: "call";
      callsiteId: CallsiteId;
      dst: VarId | null;
      callee: IrRValue;
      args: readonly IrRValue[];
    }>
  | Readonly<{
      kind: "await";
      stmtId: StmtId;
      dst: VarId;
      src: IrRValue;
    }>
  | Readonly<{
      kind: "alloc";
      stmtId: StmtId;
      dst: VarId;
      allocKind: "new" | "object" | "array";
      ctor: IrRValue | null;
      args: readonly IrRValue[];
    }>
  | Readonly<{
      kind: "member_read";
      stmtId: StmtId;
      dst: VarId;
      object: VarId;
      property: IrPropertyKey;
      optional: boolean;
    }>
  | Readonly<{
      kind: "member_write";
      stmtId: StmtId;
      object: VarId;
      property: IrPropertyKey;
      value: IrRValue;
      optional: boolean;
    }>
  | Readonly<{
      kind: "select";
      stmtId: StmtId;
      dst: VarId;
      cond: IrRValue;
      thenValue: IrRValue;
      elseValue: IrRValue;
    }>
  | Readonly<{
      kind: "short_circuit";
      stmtId: StmtId;
      dst: VarId;
      op: "&&" | "||" | "??";
      lhs: IrRValue;
      rhs: IrRValue;
    }>;

export type FuncIR = Readonly<{
  schemaVersion: IrSchemaVersion;
  funcId: FuncId;
  // Declares available IDs for schema validation + downstream (optional) LLM prompts.
  params: readonly VarId[];
  locals: readonly VarId[];
  // Canonical ordering is by `StmtId` (`CallsiteId` for `call` statements).
  stmts: readonly IrStmt[];
}>;

export type NormalizedFuncIR = FuncIR;

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

function expectBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function assertNonNegativeSafeInt(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer; got ${value}`);
  }
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

function normalizeVarIdList(value: unknown, expectedKind: "p" | "v", label: string): VarId[] {
  const arr = expectArray(value, label);
  const ids: VarId[] = [];
  const seen = new Set<number>();

  for (let i = 0; i < arr.length; i++) {
    const raw = expectString(arr[i], `${label}[${i}]`);
    const id = parseVarId(raw);
    const parts = varIdToParts(id);
    if (parts.kind !== expectedKind) {
      throw new Error(`${label}[${i}] must be a ${expectedKind}* VarId; got ${JSON.stringify(raw)}`);
    }
    if (seen.has(parts.index)) {
      throw new Error(`${label} contains duplicate ${expectedKind}${parts.index}`);
    }
    seen.add(parts.index);
    ids.push(id);
  }

  for (let i = 0; i < ids.length; i++) {
    if (!seen.has(i)) throw new Error(`${label} is missing ${expectedKind}${i}`);
  }

  return stableSort(ids, cmpVarId);
}

function normalizeIrRValue(value: unknown, label: string): IrRValue {
  const obj = expectPlainObject(value, label);
  const kind = expectString(obj.kind, `${label}.kind`);

  if (kind === "var") {
    assertNoExtraKeys(obj, ["kind", "id"], label);
    const id = parseVarId(expectString(obj.id, `${label}.id`));
    return { kind: "var", id };
  }

  if (kind === "lit") {
    assertNoExtraKeys(obj, ["kind", "value"], label);
    const v = obj.value;
    if (v === null) return { kind: "lit", value: null };
    const t = typeof v;
    if (t === "string" || t === "boolean") return { kind: "lit", value: v as string | boolean };
    if (t === "number") {
      if (!Number.isFinite(v)) throw new Error(`${label}.value must be a finite number`);
      return { kind: "lit", value: v };
    }
    throw new Error(`${label}.value must be a JSON literal`);
  }

  if (kind === "undef") {
    assertNoExtraKeys(obj, ["kind"], label);
    return { kind: "undef" };
  }

  if (kind === "unknown") {
    assertNoExtraKeys(obj, ["kind"], label);
    return { kind: "unknown" };
  }

  throw new Error(`${label}.kind is not a supported IrRValue kind: ${JSON.stringify(kind)}`);
}

function normalizeIrPropertyKey(value: unknown, label: string): IrPropertyKey {
  const obj = expectPlainObject(value, label);
  const kind = expectString(obj.kind, `${label}.kind`);

  if (kind === "named") {
    assertNoExtraKeys(obj, ["kind", "name"], label);
    const name = expectString(obj.name, `${label}.name`);
    if (name.length === 0) throw new Error(`${label}.name must be non-empty`);
    return { kind: "named", name };
  }

  if (kind === "dynamic") {
    assertNoExtraKeys(obj, ["kind"], label);
    return { kind: "dynamic" };
  }

  throw new Error(`${label}.kind is not a supported IrPropertyKey kind: ${JSON.stringify(kind)}`);
}

function irStmtAnchorId(stmt: IrStmt): StmtId {
  return stmt.kind === "call" ? stmt.callsiteId : stmt.stmtId;
}

function assertStmtIdMatchesFunc(stmtId: StmtId, funcId: FuncId, label: string): void {
  const sp = stmtIdToParts(stmtId);
  const fp = funcIdToParts(funcId);
  if (sp.filePath !== fp.filePath || sp.startOffset !== fp.startOffset || sp.endOffset !== fp.endOffset) {
    throw new Error(`${label} must belong to funcId=${funcId}; got stmtId=${stmtId}`);
  }
}

function assertDeclaredVarId(id: VarId, declared: ReadonlySet<string>, label: string): void {
  if (!declared.has(id)) throw new Error(`${label} references undeclared VarId: ${id}`);
}

function assertDeclaredRValueVars(v: IrRValue, declared: ReadonlySet<string>, label: string): void {
  if (v.kind !== "var") return;
  assertDeclaredVarId(v.id, declared, label);
}

function normalizeIrStmt(value: unknown, funcId: FuncId, declared: ReadonlySet<string>, label: string): IrStmt {
  const obj = expectPlainObject(value, label);
  const kind = expectString(obj.kind, `${label}.kind`);

  if (kind === "assign") {
    assertNoExtraKeys(obj, ["kind", "stmtId", "dst", "src"], label);
    const stmtId = parseStmtId(expectString(obj.stmtId, `${label}.stmtId`));
    assertStmtIdMatchesFunc(stmtId, funcId, `${label}.stmtId`);
    const dst = parseVarId(expectString(obj.dst, `${label}.dst`));
    assertDeclaredVarId(dst, declared, `${label}.dst`);
    const src = normalizeIrRValue(obj.src, `${label}.src`);
    assertDeclaredRValueVars(src, declared, `${label}.src`);
    return { kind: "assign", stmtId, dst, src };
  }

  if (kind === "return") {
    assertNoExtraKeys(obj, ["kind", "stmtId", "value"], label);
    const stmtId = parseStmtId(expectString(obj.stmtId, `${label}.stmtId`));
    assertStmtIdMatchesFunc(stmtId, funcId, `${label}.stmtId`);
    const rawValue = obj.value;
    if (rawValue === null || rawValue === undefined) return { kind: "return", stmtId, value: null };
    const valueNorm = normalizeIrRValue(rawValue, `${label}.value`);
    assertDeclaredRValueVars(valueNorm, declared, `${label}.value`);
    return { kind: "return", stmtId, value: valueNorm };
  }

  if (kind === "call") {
    assertNoExtraKeys(obj, ["kind", "callsiteId", "dst", "callee", "args"], label);
    const callsiteId = parseCallsiteId(expectString(obj.callsiteId, `${label}.callsiteId`));
    assertStmtIdMatchesFunc(callsiteId, funcId, `${label}.callsiteId`);
    const rawDst = obj.dst;
    const dst = rawDst === null || rawDst === undefined ? null : parseVarId(expectString(rawDst, `${label}.dst`));
    if (dst !== null) assertDeclaredVarId(dst, declared, `${label}.dst`);
    const callee = normalizeIrRValue(obj.callee, `${label}.callee`);
    assertDeclaredRValueVars(callee, declared, `${label}.callee`);
    const argsArr = expectArray(obj.args, `${label}.args`);
    const args: IrRValue[] = [];
    for (let i = 0; i < argsArr.length; i++) {
      const a = normalizeIrRValue(argsArr[i], `${label}.args[${i}]`);
      assertDeclaredRValueVars(a, declared, `${label}.args[${i}]`);
      args.push(a);
    }
    return { kind: "call", callsiteId, dst, callee, args };
  }

  if (kind === "await") {
    assertNoExtraKeys(obj, ["kind", "stmtId", "dst", "src"], label);
    const stmtId = parseStmtId(expectString(obj.stmtId, `${label}.stmtId`));
    assertStmtIdMatchesFunc(stmtId, funcId, `${label}.stmtId`);
    const dst = parseVarId(expectString(obj.dst, `${label}.dst`));
    assertDeclaredVarId(dst, declared, `${label}.dst`);
    const src = normalizeIrRValue(obj.src, `${label}.src`);
    assertDeclaredRValueVars(src, declared, `${label}.src`);
    return { kind: "await", stmtId, dst, src };
  }

  if (kind === "alloc") {
    assertNoExtraKeys(obj, ["kind", "stmtId", "dst", "allocKind", "ctor", "args"], label);
    const stmtId = parseStmtId(expectString(obj.stmtId, `${label}.stmtId`));
    assertStmtIdMatchesFunc(stmtId, funcId, `${label}.stmtId`);
    const dst = parseVarId(expectString(obj.dst, `${label}.dst`));
    assertDeclaredVarId(dst, declared, `${label}.dst`);

    const allocKindRaw = expectString(obj.allocKind, `${label}.allocKind`);
    if (allocKindRaw !== "new" && allocKindRaw !== "object" && allocKindRaw !== "array") {
      throw new Error(`${label}.allocKind must be one of "new"|"object"|"array"`);
    }
    const allocKind = allocKindRaw as "new" | "object" | "array";

    const ctorRaw = obj.ctor;
    const ctor = ctorRaw === null || ctorRaw === undefined ? null : normalizeIrRValue(ctorRaw, `${label}.ctor`);
    if (ctor !== null) assertDeclaredRValueVars(ctor, declared, `${label}.ctor`);

    const argsArr = obj.args === undefined ? [] : expectArray(obj.args, `${label}.args`);
    const args: IrRValue[] = [];
    for (let i = 0; i < argsArr.length; i++) {
      const a = normalizeIrRValue(argsArr[i], `${label}.args[${i}]`);
      assertDeclaredRValueVars(a, declared, `${label}.args[${i}]`);
      args.push(a);
    }

    return { kind: "alloc", stmtId, dst, allocKind, ctor, args };
  }

  if (kind === "member_read") {
    assertNoExtraKeys(obj, ["kind", "stmtId", "dst", "object", "property", "optional"], label);
    const stmtId = parseStmtId(expectString(obj.stmtId, `${label}.stmtId`));
    assertStmtIdMatchesFunc(stmtId, funcId, `${label}.stmtId`);
    const dst = parseVarId(expectString(obj.dst, `${label}.dst`));
    assertDeclaredVarId(dst, declared, `${label}.dst`);
    const object = parseVarId(expectString(obj.object, `${label}.object`));
    assertDeclaredVarId(object, declared, `${label}.object`);
    const property = normalizeIrPropertyKey(obj.property, `${label}.property`);
    const optional = obj.optional === undefined ? false : expectBoolean(obj.optional, `${label}.optional`);
    return { kind: "member_read", stmtId, dst, object, property, optional };
  }

  if (kind === "member_write") {
    assertNoExtraKeys(obj, ["kind", "stmtId", "object", "property", "value", "optional"], label);
    const stmtId = parseStmtId(expectString(obj.stmtId, `${label}.stmtId`));
    assertStmtIdMatchesFunc(stmtId, funcId, `${label}.stmtId`);
    const object = parseVarId(expectString(obj.object, `${label}.object`));
    assertDeclaredVarId(object, declared, `${label}.object`);
    const property = normalizeIrPropertyKey(obj.property, `${label}.property`);
    const valueNorm = normalizeIrRValue(obj.value, `${label}.value`);
    assertDeclaredRValueVars(valueNorm, declared, `${label}.value`);
    const optional = obj.optional === undefined ? false : expectBoolean(obj.optional, `${label}.optional`);
    return { kind: "member_write", stmtId, object, property, value: valueNorm, optional };
  }

  if (kind === "select") {
    assertNoExtraKeys(obj, ["kind", "stmtId", "dst", "cond", "thenValue", "elseValue"], label);
    const stmtId = parseStmtId(expectString(obj.stmtId, `${label}.stmtId`));
    assertStmtIdMatchesFunc(stmtId, funcId, `${label}.stmtId`);
    const dst = parseVarId(expectString(obj.dst, `${label}.dst`));
    assertDeclaredVarId(dst, declared, `${label}.dst`);
    const cond = normalizeIrRValue(obj.cond, `${label}.cond`);
    assertDeclaredRValueVars(cond, declared, `${label}.cond`);
    const thenValue = normalizeIrRValue(obj.thenValue, `${label}.thenValue`);
    assertDeclaredRValueVars(thenValue, declared, `${label}.thenValue`);
    const elseValue = normalizeIrRValue(obj.elseValue, `${label}.elseValue`);
    assertDeclaredRValueVars(elseValue, declared, `${label}.elseValue`);
    return { kind: "select", stmtId, dst, cond, thenValue, elseValue };
  }

  if (kind === "short_circuit") {
    assertNoExtraKeys(obj, ["kind", "stmtId", "dst", "op", "lhs", "rhs"], label);
    const stmtId = parseStmtId(expectString(obj.stmtId, `${label}.stmtId`));
    assertStmtIdMatchesFunc(stmtId, funcId, `${label}.stmtId`);
    const dst = parseVarId(expectString(obj.dst, `${label}.dst`));
    assertDeclaredVarId(dst, declared, `${label}.dst`);

    const opRaw = expectString(obj.op, `${label}.op`);
    if (opRaw !== "&&" && opRaw !== "||" && opRaw !== "??") {
      throw new Error(`${label}.op must be one of "&&"|"||"|"??"`);
    }
    const op = opRaw as "&&" | "||" | "??";

    const lhs = normalizeIrRValue(obj.lhs, `${label}.lhs`);
    assertDeclaredRValueVars(lhs, declared, `${label}.lhs`);
    const rhs = normalizeIrRValue(obj.rhs, `${label}.rhs`);
    assertDeclaredRValueVars(rhs, declared, `${label}.rhs`);
    return { kind: "short_circuit", stmtId, dst, op, lhs, rhs };
  }

  throw new Error(`${label}.kind is not a supported IrStmt kind: ${JSON.stringify(kind)}`);
}

function normalizeIrStmtList(value: unknown, funcId: FuncId, declared: ReadonlySet<string>, label: string): IrStmt[] {
  const arr = expectArray(value, label);
  const collected: IrStmt[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < arr.length; i++) {
    const st = normalizeIrStmt(arr[i], funcId, declared, `${label}[${i}]`);
    const anchor = irStmtAnchorId(st);
    if (seen.has(anchor)) throw new Error(`${label} contains duplicate statement ID: ${anchor}`);
    seen.add(anchor);
    collected.push(st);
  }

  return stableSort(collected, (a, b) => cmpStmtId(irStmtAnchorId(a), irStmtAnchorId(b)));
}

function assertVarListsAreDisjoint(params: readonly VarId[], locals: readonly VarId[]): void {
  // This should be impossible because VarId kind differs, but treat it as a schema guardrail.
  const seen = new Set<string>();
  for (const p of params) seen.add(p);
  for (const v of locals) {
    if (seen.has(v)) throw new Error(`VarId appears in both params and locals: ${v}`);
  }
}

function assertStmtIdsUniqueAcrossKinds(stmts: readonly IrStmt[]): void {
  // Anchors are already checked for uniqueness; this ensures stmtId/callsiteId are canonical IDs.
  const seen = new Set<string>();
  for (const st of stmts) {
    const id = irStmtAnchorId(st);
    if (seen.has(id)) throw new Error(`Duplicate IR statement ID: ${id}`);
    seen.add(id);
  }
}

export function normalizeFuncIr(value: unknown): NormalizedFuncIR {
  const obj = expectPlainObject(value, "FuncIR");
  assertNoExtraKeys(obj, ["schemaVersion", "funcId", "params", "locals", "stmts"], "FuncIR");

  const schemaVersion = obj.schemaVersion;
  if (schemaVersion !== FUNC_IR_SCHEMA_VERSION) {
    throw new Error(
      `FuncIR.schemaVersion must be ${FUNC_IR_SCHEMA_VERSION}; got ${JSON.stringify(schemaVersion)}`,
    );
  }

  const funcId = parseFuncId(expectString(obj.funcId, "FuncIR.funcId"));
  const params = normalizeVarIdList(obj.params, "p", "FuncIR.params");
  const locals = normalizeVarIdList(obj.locals, "v", "FuncIR.locals");
  assertVarListsAreDisjoint(params, locals);

  const declared = new Set<string>([...params, ...locals]);
  const stmts = normalizeIrStmtList(obj.stmts, funcId, declared, "FuncIR.stmts");
  assertStmtIdsUniqueAcrossKinds(stmts);

  // Guardrail: statements should not mention stmt IDs outside the function span.
  // (Already checked per statement, but this makes errors easier to localize if types change.)
  const fp = funcIdToParts(funcId);
  for (const st of stmts) {
    const sp = stmtIdToParts(irStmtAnchorId(st));
    if (sp.filePath !== fp.filePath || sp.startOffset !== fp.startOffset || sp.endOffset !== fp.endOffset) {
      throw new Error(`IR statement ID is outside function span: funcId=${funcId} stmtId=${irStmtAnchorId(st)}`);
    }
  }

  // Ensure deterministic schema invariants for stable hashing/serialization.
  // `normalizeVarIdList` already sorts, and `normalizeIrStmtList` sorts by StmtId.
  for (let i = 0; i < params.length; i++) {
    const p = varIdToParts(params[i]!);
    assertNonNegativeSafeInt(p.index, `FuncIR.params[${i}].index`);
    if (p.index !== i) throw new Error(`FuncIR.params must be contiguous p0..p${params.length - 1}`);
  }
  for (let i = 0; i < locals.length; i++) {
    const v = varIdToParts(locals[i]!);
    assertNonNegativeSafeInt(v.index, `FuncIR.locals[${i}].index`);
    if (v.index !== i) throw new Error(`FuncIR.locals must be contiguous v0..v${locals.length - 1}`);
  }

  return {
    schemaVersion: FUNC_IR_SCHEMA_VERSION,
    funcId,
    params,
    locals,
    stmts,
  };
}

export function serializeNormalizedFuncIr(ir: NormalizedFuncIR): string {
  return canonicalJsonStringify(ir);
}

