import ts from "typescript";

import { createLocalVarId, createParamVarId } from "./ids.ts";
import type { VarId } from "./ids.ts";
import { FUNC_IR_SCHEMA_VERSION, normalizeFuncIr } from "./ir.ts";
import type { IrPropertyKey, IrRValue, IrStmt, NormalizedFuncIR } from "./ir.ts";
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

function isNullishCoalesce(expr: ts.Expression): expr is ts.BinaryExpression {
  return ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken;
}

type MemberAccessParts = Readonly<{
  object: VarId;
  property: IrPropertyKey;
  optional: boolean;
}>;

function propertyKeyFromElementAccessArgument(arg: ts.Expression): IrPropertyKey {
  const a = unwrapExpr(arg);
  if (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) return { kind: "named", name: a.text };
  return { kind: "dynamic" };
}

export function buildFuncIrV2(func: IndexedFunction, statements: readonly IndexedStatement[]): NormalizedFuncIR {
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

  const THIS_KEY = "@this";
  const thisVar = (): VarId => allocLocal(THIS_KEY);

  const exprToVarId = (expr: ts.Expression): VarId | undefined => {
    const e = unwrapExpr(expr);
    if (ts.isIdentifier(e)) return lookupVar(e.text);
    if (e.kind === ts.SyntaxKind.ThisKeyword) return thisVar();
    return undefined;
  };

  const memberAccessParts = (expr: ts.Expression): MemberAccessParts | undefined => {
    const e = unwrapExpr(expr);

    if (ts.isPropertyAccessExpression(e) || ts.isPropertyAccessChain(e)) {
      const obj = exprToVarId(e.expression);
      if (!obj) return undefined;
      const optional = ts.isPropertyAccessChain(e);
      return { object: obj, property: { kind: "named", name: e.name.text }, optional };
    }

    if (ts.isElementAccessExpression(e) || ts.isElementAccessChain(e)) {
      const obj = exprToVarId(e.expression);
      if (!obj) return undefined;
      if (!e.argumentExpression) return undefined;
      const optional = ts.isElementAccessChain(e);
      return { object: obj, property: propertyKeyFromElementAccessArgument(e.argumentExpression), optional };
    }

    return undefined;
  };

  // Map call expressions to the VarId receiving their result (or null for "call as statement").
  const callDst = new Map<ts.CallExpression, VarId | null>();

  // Map await expressions to the VarId receiving their awaited result.
  const awaitDst = new Map<ts.AwaitExpression, VarId>();

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

  // Map awaits that are direct initializers `const x = await y`.
  for (const st of statements) {
    if (!ts.isVariableStatement(st.node)) continue;
    for (const decl of st.node.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name)) continue;
      if (!decl.initializer) continue;
      const init = unwrapExpr(decl.initializer);
      if (!ts.isAwaitExpression(init)) continue;
      awaitDst.set(init, allocLocal(decl.name.text));

      // If awaiting a direct call, capture the call's result into a temp first.
      const awaited = unwrapExpr(init.expression);
      if (ts.isCallExpression(awaited) && !callDst.has(awaited)) callDst.set(awaited, allocTemp());
    }
  }

  // Map awaits in direct assignments `x = await y`.
  for (const st of statements) {
    if (!ts.isExpressionStatement(st.node)) continue;
    const expr = unwrapExpr(st.node.expression);
    if (!ts.isBinaryExpression(expr) || expr.operatorToken.kind !== ts.SyntaxKind.EqualsToken) continue;
    if (!ts.isIdentifier(expr.left)) continue;
    const rhs = unwrapExpr(expr.right);
    if (!ts.isAwaitExpression(rhs)) continue;

    const dst = lookupVar(expr.left.text);
    if (dst) awaitDst.set(rhs, dst);

    const awaited = unwrapExpr(rhs.expression);
    if (ts.isCallExpression(awaited) && !callDst.has(awaited)) callDst.set(awaited, allocTemp());
  }

  // Allocate temps for `return await <expr>` patterns.
  for (const st of statements) {
    if (!ts.isReturnStatement(st.node)) continue;
    if (!st.node.expression) continue;
    const expr = unwrapExpr(st.node.expression);
    if (!ts.isAwaitExpression(expr)) continue;
    if (!awaitDst.has(expr)) awaitDst.set(expr, allocTemp());

    const awaited = unwrapExpr(expr.expression);
    if (ts.isCallExpression(awaited) && !callDst.has(awaited)) callDst.set(awaited, allocTemp());
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

      if (ts.isAwaitExpression(expr)) {
        const dst = awaitDst.get(expr);
        if (!dst) {
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
      if (ts.isAwaitExpression(init)) continue; // handled by the await IR node

      const dst = lookupVar(decl.name.text);
      if (!dst) continue;

      const memberExpr = isNullishCoalesce(init) ? unwrapExpr(init.left) : init;
      const mem = memberAccessParts(memberExpr);
      if (mem) {
        stmts.push({
          kind: "member_read",
          stmtId: st.id,
          dst,
          object: mem.object,
          property: mem.property,
          optional: mem.optional,
        });
        continue;
      }

      stmts.push({ kind: "assign", stmtId: st.id, dst, src: exprToRValue(init, lookupVar) });
      continue;
    }

    if (ts.isExpressionStatement(node)) {
      const expr = unwrapExpr(node.expression);
      if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const rhs = unwrapExpr(expr.right);
        if (ts.isCallExpression(rhs)) continue; // handled by the callsite IR node
        if (ts.isAwaitExpression(rhs)) continue; // handled by the await IR node

        const memLhs = memberAccessParts(expr.left as ts.Expression);
        if (memLhs) {
          stmts.push({
            kind: "member_write",
            stmtId: st.id,
            object: memLhs.object,
            property: memLhs.property,
            value: exprToRValue(rhs, lookupVar),
            optional: memLhs.optional,
          });
          continue;
        }

        if (!ts.isIdentifier(expr.left)) continue;
        const dst = lookupVar(expr.left.text);
        if (!dst) continue;

        const memberExpr = isNullishCoalesce(rhs) ? unwrapExpr(rhs.left) : rhs;
        const memRhs = memberAccessParts(memberExpr);
        if (memRhs) {
          stmts.push({
            kind: "member_read",
            stmtId: st.id,
            dst,
            object: memRhs.object,
            property: memRhs.property,
            optional: memRhs.optional,
          });
          continue;
        }

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

    if (ts.isAwaitExpression(node)) {
      let dst = awaitDst.get(node);
      if (!dst) {
        dst = allocTemp();
        awaitDst.set(node, dst);
      }

      const awaited = unwrapExpr(node.expression);
      const src: IrRValue = ts.isCallExpression(awaited)
        ? (() => {
            const innerDst = callDst.get(awaited);
            return innerDst ? { kind: "var", id: innerDst } : { kind: "unknown" };
          })()
        : exprToRValue(awaited, lookupVar);

      stmts.push({ kind: "await", stmtId: st.id, dst, src });
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

export function buildFuncIrV3(func: IndexedFunction, statements: readonly IndexedStatement[]): NormalizedFuncIR {
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

  const THIS_KEY = "@this";
  const thisVar = (): VarId => allocLocal(THIS_KEY);

  const exprToVarId = (expr: ts.Expression): VarId | undefined => {
    const e = unwrapExpr(expr);
    if (ts.isIdentifier(e)) return lookupVar(e.text);
    if (e.kind === ts.SyntaxKind.ThisKeyword) return thisVar();
    return undefined;
  };

  const memberAccessParts = (expr: ts.Expression): MemberAccessParts | undefined => {
    const e = unwrapExpr(expr);

    if (ts.isPropertyAccessExpression(e) || ts.isPropertyAccessChain(e)) {
      const obj = exprToVarId(e.expression);
      if (!obj) return undefined;
      const optional = ts.isPropertyAccessChain(e);
      return { object: obj, property: { kind: "named", name: e.name.text }, optional };
    }

    if (ts.isElementAccessExpression(e) || ts.isElementAccessChain(e)) {
      const obj = exprToVarId(e.expression);
      if (!obj) return undefined;
      if (!e.argumentExpression) return undefined;
      const optional = ts.isElementAccessChain(e);
      return { object: obj, property: propertyKeyFromElementAccessArgument(e.argumentExpression), optional };
    }

    return undefined;
  };

  // Map call expressions to the VarId receiving their result (or null for "call as statement").
  const callDst = new Map<ts.CallExpression, VarId | null>();

  // Map await expressions to the VarId receiving their awaited result.
  const awaitDst = new Map<ts.AwaitExpression, VarId>();

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

  // Map awaits that are direct initializers `const x = await y`.
  for (const st of statements) {
    if (!ts.isVariableStatement(st.node)) continue;
    for (const decl of st.node.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name)) continue;
      if (!decl.initializer) continue;
      const init = unwrapExpr(decl.initializer);
      if (!ts.isAwaitExpression(init)) continue;
      awaitDst.set(init, allocLocal(decl.name.text));

      // If awaiting a direct call, capture the call's result into a temp first.
      const awaited = unwrapExpr(init.expression);
      if (ts.isCallExpression(awaited) && !callDst.has(awaited)) callDst.set(awaited, allocTemp());
    }
  }

  // Map awaits in direct assignments `x = await y`.
  for (const st of statements) {
    if (!ts.isExpressionStatement(st.node)) continue;
    const expr = unwrapExpr(st.node.expression);
    if (!ts.isBinaryExpression(expr) || expr.operatorToken.kind !== ts.SyntaxKind.EqualsToken) continue;
    if (!ts.isIdentifier(expr.left)) continue;
    const rhs = unwrapExpr(expr.right);
    if (!ts.isAwaitExpression(rhs)) continue;

    const dst = lookupVar(expr.left.text);
    if (dst) awaitDst.set(rhs, dst);

    const awaited = unwrapExpr(rhs.expression);
    if (ts.isCallExpression(awaited) && !callDst.has(awaited)) callDst.set(awaited, allocTemp());
  }

  // Allocate temps for `return await <expr>` patterns.
  for (const st of statements) {
    if (!ts.isReturnStatement(st.node)) continue;
    if (!st.node.expression) continue;
    const expr = unwrapExpr(st.node.expression);
    if (!ts.isAwaitExpression(expr)) continue;
    if (!awaitDst.has(expr)) awaitDst.set(expr, allocTemp());

    const awaited = unwrapExpr(expr.expression);
    if (ts.isCallExpression(awaited) && !callDst.has(awaited)) callDst.set(awaited, allocTemp());
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

      if (ts.isAwaitExpression(expr)) {
        const dst = awaitDst.get(expr);
        if (!dst) {
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
      if (ts.isAwaitExpression(init)) continue; // handled by the await IR node

      const dst = lookupVar(decl.name.text);
      if (!dst) continue;

      const memberExpr = isNullishCoalesce(init) ? unwrapExpr(init.left) : init;
      const mem = memberAccessParts(memberExpr);
      if (mem) {
        stmts.push({
          kind: "member_read",
          stmtId: st.id,
          dst,
          object: mem.object,
          property: mem.property,
          optional: mem.optional,
        });
        continue;
      }

      if (ts.isConditionalExpression(init)) {
        stmts.push({
          kind: "select",
          stmtId: st.id,
          dst,
          cond: exprToRValue(init.condition, lookupVar),
          thenValue: exprToRValue(init.whenTrue, lookupVar),
          elseValue: exprToRValue(init.whenFalse, lookupVar),
        });
        continue;
      }

      if (
        ts.isBinaryExpression(init) &&
        (init.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
          init.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
          init.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
      ) {
        const op =
          init.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
            ? "&&"
            : init.operatorToken.kind === ts.SyntaxKind.BarBarToken
              ? "||"
              : "??";
        stmts.push({
          kind: "short_circuit",
          stmtId: st.id,
          dst,
          op,
          lhs: exprToRValue(init.left, lookupVar),
          rhs: exprToRValue(init.right, lookupVar),
        });
        continue;
      }

      stmts.push({ kind: "assign", stmtId: st.id, dst, src: exprToRValue(init, lookupVar) });
      continue;
    }

    if (ts.isExpressionStatement(node)) {
      const expr = unwrapExpr(node.expression);
      if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const rhs = unwrapExpr(expr.right);
        if (ts.isCallExpression(rhs)) continue; // handled by the callsite IR node
        if (ts.isAwaitExpression(rhs)) continue; // handled by the await IR node

        const memLhs = memberAccessParts(expr.left as ts.Expression);
        if (memLhs) {
          stmts.push({
            kind: "member_write",
            stmtId: st.id,
            object: memLhs.object,
            property: memLhs.property,
            value: exprToRValue(rhs, lookupVar),
            optional: memLhs.optional,
          });
          continue;
        }

        if (!ts.isIdentifier(expr.left)) continue;
        const dst = lookupVar(expr.left.text);
        if (!dst) continue;

        const memberExpr = isNullishCoalesce(rhs) ? unwrapExpr(rhs.left) : rhs;
        const memRhs = memberAccessParts(memberExpr);
        if (memRhs) {
          stmts.push({
            kind: "member_read",
            stmtId: st.id,
            dst,
            object: memRhs.object,
            property: memRhs.property,
            optional: memRhs.optional,
          });
          continue;
        }

        if (ts.isConditionalExpression(rhs)) {
          stmts.push({
            kind: "select",
            stmtId: st.id,
            dst,
            cond: exprToRValue(rhs.condition, lookupVar),
            thenValue: exprToRValue(rhs.whenTrue, lookupVar),
            elseValue: exprToRValue(rhs.whenFalse, lookupVar),
          });
          continue;
        }

        if (
          ts.isBinaryExpression(rhs) &&
          (rhs.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
            rhs.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
            rhs.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
        ) {
          const op =
            rhs.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
              ? "&&"
              : rhs.operatorToken.kind === ts.SyntaxKind.BarBarToken
                ? "||"
                : "??";
          stmts.push({
            kind: "short_circuit",
            stmtId: st.id,
            dst,
            op,
            lhs: exprToRValue(rhs.left, lookupVar),
            rhs: exprToRValue(rhs.right, lookupVar),
          });
          continue;
        }

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

    if (ts.isAwaitExpression(node)) {
      let dst = awaitDst.get(node);
      if (!dst) {
        dst = allocTemp();
        awaitDst.set(node, dst);
      }

      const awaited = unwrapExpr(node.expression);
      const src: IrRValue = ts.isCallExpression(awaited)
        ? (() => {
            const innerDst = callDst.get(awaited);
            return innerDst ? { kind: "var", id: innerDst } : { kind: "unknown" };
          })()
        : exprToRValue(awaited, lookupVar);

      stmts.push({ kind: "await", stmtId: st.id, dst, src });
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
