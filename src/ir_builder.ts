import ts from "typescript";

import { createLocalVarId, createParamVarId } from "./ids.ts";
import type { VarId } from "./ids.ts";
import { FUNC_IR_SCHEMA_VERSION, normalizeFuncIr } from "./ir.ts";
import type { IrRValue, IrStmt, NormalizedFuncIR } from "./ir.ts";
import type { IndexedFunction } from "./function_indexer.ts";
import type { IndexedStatement } from "./statement_indexer.ts";

function unwrapExpr(expr: ts.Expression): ts.Expression {
  // Strip syntactic wrappers that don't affect runtime values.
  let cur: ts.Expression = expr;
  for (;;) {
    if (ts.isParenthesizedExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    if (ts.isAsExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    if (ts.isTypeAssertionExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    if (ts.isNonNullExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    // TS 4.9+.
    if (ts.isSatisfiesExpression?.(cur)) {
      cur = cur.expression;
      continue;
    }
    return cur;
  }
}

function exprToRValue(expr: ts.Expression, lookupVar: (name: string) => VarId | undefined): IrRValue {
  const e = unwrapExpr(expr);

  if (ts.isIdentifier(e)) {
    if (e.text === "undefined") return { kind: "undef" };
    const id = lookupVar(e.text);
    if (id) return { kind: "var", id };
    return { kind: "unknown" };
  }

  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) {
    return { kind: "lit", value: e.text };
  }

  if (ts.isNumericLiteral(e)) {
    const raw = e.text.replaceAll("_", "");
    const n = Number(raw);
    if (Number.isFinite(n)) return { kind: "lit", value: n };
    return { kind: "unknown" };
  }

  if (e.kind === ts.SyntaxKind.TrueKeyword) return { kind: "lit", value: true };
  if (e.kind === ts.SyntaxKind.FalseKeyword) return { kind: "lit", value: false };
  if (e.kind === ts.SyntaxKind.NullKeyword) return { kind: "lit", value: null };

  if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.VoidKeyword) {
    return { kind: "undef" };
  }

  return { kind: "unknown" };
}

export function buildFuncIrV1(func: IndexedFunction, statements: readonly IndexedStatement[]): NormalizedFuncIR {
  const params: VarId[] = [];
  const paramByName = new Map<string, VarId>();
  for (let i = 0; i < func.node.parameters.length; i++) {
    const id = createParamVarId(i);
    params.push(id);
    const p = func.node.parameters[i]!;
    if (ts.isIdentifier(p.name)) paramByName.set(p.name.text, id);
  }

  const locals: VarId[] = [];
  const localByName = new Map<string, VarId>();
  const allocLocal = (name: string): VarId => {
    const existing = localByName.get(name);
    if (existing) return existing;
    const id = createLocalVarId(locals.length);
    locals.push(id);
    localByName.set(name, id);
    return id;
  };

  const allocTemp = (): VarId => {
    const id = createLocalVarId(locals.length);
    locals.push(id);
    return id;
  };

  const lookupVar = (name: string): VarId | undefined => paramByName.get(name) ?? localByName.get(name);

  // Map call expressions to the VarId receiving their result (or null for "call as statement").
  const callDst = new Map<ts.CallExpression, VarId | null>();

  // First, allocate locals based on declarations (in deterministic statement-site order).
  for (const st of statements) {
    if (!ts.isVariableStatement(st.node)) continue;
    for (const decl of st.node.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name)) continue;
      allocLocal(decl.name.text);
    }
  }

  // Next, map calls that are direct initializers `const x = foo(...)`.
  for (const st of statements) {
    if (!ts.isVariableStatement(st.node)) continue;
    for (const decl of st.node.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name)) continue;
      if (!decl.initializer) continue;
      const init = unwrapExpr(decl.initializer);
      if (!ts.isCallExpression(init)) continue;
      callDst.set(init, allocLocal(decl.name.text));
    }
  }

  // Map calls in direct assignments `x = foo(...)`.
  for (const st of statements) {
    if (!ts.isExpressionStatement(st.node)) continue;
    const expr = unwrapExpr(st.node.expression);
    if (!ts.isBinaryExpression(expr) || expr.operatorToken.kind !== ts.SyntaxKind.EqualsToken) continue;
    if (!ts.isIdentifier(expr.left)) continue;
    const rhs = unwrapExpr(expr.right);
    if (!ts.isCallExpression(rhs)) continue;
    callDst.set(rhs, lookupVar(expr.left.text) ?? null);
  }

  // Allocate temps for `return <callExpr>` patterns (since `IrRValue` can't inline calls).
  for (const st of statements) {
    if (!ts.isReturnStatement(st.node)) continue;
    if (!st.node.expression) continue;
    const expr = unwrapExpr(st.node.expression);
    if (!ts.isCallExpression(expr)) continue;
    if (!callDst.has(expr)) callDst.set(expr, allocTemp());
  }

  // Default remaining callsites to dst=null (side-effect calls / unsupported contexts).
  for (const st of statements) {
    if (!ts.isCallExpression(st.node)) continue;
    const call = st.node;
    if (!callDst.has(call)) callDst.set(call, null);
  }

  const stmts: IrStmt[] = [];

  for (const st of statements) {
    const node = st.node;

    if (ts.isReturnStatement(node)) {
      if (!node.expression) {
        stmts.push({ kind: "return", stmtId: st.id, value: null });
        continue;
      }

      const expr = unwrapExpr(node.expression);
      if (ts.isCallExpression(expr)) {
        const dst = callDst.get(expr);
        if (!dst) {
          // Should be impossible given the pre-scan, but keep the IR valid/deterministic.
          stmts.push({ kind: "return", stmtId: st.id, value: { kind: "unknown" } });
          continue;
        }
        stmts.push({ kind: "return", stmtId: st.id, value: { kind: "var", id: dst } });
        continue;
      }

      stmts.push({ kind: "return", stmtId: st.id, value: exprToRValue(expr, lookupVar) });
      continue;
    }

    if (ts.isVariableStatement(node)) {
      const decls = node.declarationList.declarations;
      if (decls.length !== 1) continue;
      const decl = decls[0]!;
      if (!ts.isIdentifier(decl.name)) continue;
      if (!decl.initializer) continue;

      const init = unwrapExpr(decl.initializer);
      if (ts.isCallExpression(init)) continue; // handled by the callsite IR node

      const dst = lookupVar(decl.name.text);
      if (!dst) continue;
      stmts.push({ kind: "assign", stmtId: st.id, dst, src: exprToRValue(init, lookupVar) });
      continue;
    }

    if (ts.isExpressionStatement(node)) {
      const expr = unwrapExpr(node.expression);
      if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const rhs = unwrapExpr(expr.right);
        if (ts.isCallExpression(rhs)) continue; // handled by the callsite IR node
        if (!ts.isIdentifier(expr.left)) continue;
        const dst = lookupVar(expr.left.text);
        if (!dst) continue;
        stmts.push({ kind: "assign", stmtId: st.id, dst, src: exprToRValue(rhs, lookupVar) });
      }
      continue;
    }

    if (ts.isCallExpression(node)) {
      const dst = callDst.get(node) ?? null;
      const callee = exprToRValue(node.expression, lookupVar);
      const args = node.arguments.map((a) => exprToRValue(a, lookupVar));

      stmts.push({
        kind: "call",
        callsiteId: st.id,
        dst,
        callee,
        args,
      });
      continue;
    }
  }

  return normalizeFuncIr({
    schemaVersion: FUNC_IR_SCHEMA_VERSION,
    funcId: func.id,
    params,
    locals,
    stmts,
  });
}
