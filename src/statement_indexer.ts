import ts from "typescript";

import { createStmtId } from "./ids.ts";
import type { FuncId, StmtId } from "./ids.ts";
import { buildFunctionIndexFromProject } from "./function_indexer.ts";
import type { FunctionIndex, IndexedFunction } from "./function_indexer.ts";
import type { TsProject } from "./ts_project.ts";

export type IndexedStatement = Readonly<{
  id: StmtId;
  funcId: FuncId;
  statementIndex: number;
  // Offsets are in `sourceFile.text` coordinates.
  startOffset: number;
  endOffset: number;
  node: ts.Node;
  sourceFile: ts.SourceFile;
}>;

export type StatementIndex = Readonly<{
  // Aligned with `functionIndex.functions` ordering for deterministic iteration.
  perFunction: ReadonlyArray<
    Readonly<{
      func: IndexedFunction;
      statements: readonly IndexedStatement[];
    }>
  >;
  // All indexed statements, sorted by `cmpStmtId` implicitly via construction.
  statements: readonly IndexedStatement[];
  getById: (id: StmtId) => IndexedStatement | undefined;
  getByFuncId: (id: FuncId) => readonly IndexedStatement[] | undefined;
}>;

function isIndexableFunctionLikeNode(node: ts.Node): node is ts.FunctionLikeDeclaration {
  switch (node.kind) {
    case ts.SyntaxKind.FunctionDeclaration:
    case ts.SyntaxKind.FunctionExpression:
    case ts.SyntaxKind.ArrowFunction:
    case ts.SyntaxKind.MethodDeclaration:
    case ts.SyntaxKind.Constructor:
    case ts.SyntaxKind.GetAccessor:
    case ts.SyntaxKind.SetAccessor:
      return true;
    default:
      return false;
  }
}

function functionLikeHasBody(node: ts.FunctionLikeDeclaration): boolean {
  // In TS, overload signatures and abstract/interface members have no body.
  const body = (node as { body?: unknown }).body;
  return body !== undefined && body !== null;
}

/*
Statement indexing rules (deterministic):

- `StmtId = FuncId + statementIndex`.
- `statementIndex` is assigned by walking the function's body AST in source order
  and counting "statement sites" encountered.
- A "statement site" is:
  - any `ts.Statement` excluding `ts.Block` (blocks are structural), OR
  - any `ts.CallExpression` (callsites), OR
  - any `ts.NewExpression` (allocation sites), OR
  - any `ts.ObjectLiteralExpression` / `ts.ArrayLiteralExpression` (allocation sites), OR
  - for expression-bodied arrow functions, the body expression root (to model the implicit return).
- Nested function-like nodes with bodies are treated as separate functions:
  their bodies are NOT traversed while indexing an outer function.
*/
function isStatementSite(node: ts.Node, arrowExprBodyRoot: ts.Expression | undefined): boolean {
  if (arrowExprBodyRoot && node === arrowExprBodyRoot) return true;

  if (ts.isStatement(node)) {
    // Blocks are structural containers; indexing them would add noise and shift indices.
    if (ts.isBlock(node)) return false;
    return true;
  }

  return (
    ts.isCallExpression(node) ||
    ts.isNewExpression(node) ||
    ts.isObjectLiteralExpression(node) ||
    ts.isArrayLiteralExpression(node) ||
    ts.isAwaitExpression(node)
  );
}

function buildStatementsForFunction(fn: IndexedFunction): IndexedStatement[] {
  const sourceFile = fn.sourceFile;

  const body = (fn.node as { body?: ts.ConciseBody }).body;
  if (!body) return [];

  const arrowExprBodyRoot =
    fn.node.kind === ts.SyntaxKind.ArrowFunction && !ts.isBlock(body) ? (body as ts.Expression) : undefined;

  const collected: IndexedStatement[] = [];
  let statementIndex = 0;

  const visit = (node: ts.Node): void => {
    if (isIndexableFunctionLikeNode(node)) {
      const nested = node as ts.FunctionLikeDeclaration;
      if (functionLikeHasBody(nested)) {
        // Skip nested function bodies; they get their own FuncId/StmtIds.
        return;
      }
    }

    if (isStatementSite(node, arrowExprBodyRoot)) {
      // Offsets are computed excluding leading trivia, matching TS token spans.
      const startOffset = node.getStart(sourceFile, /*includeJsDocComment*/ false);
      const endOffset = node.getEnd();
      const id = createStmtId(fn.id, statementIndex);
      collected.push({
        id,
        funcId: fn.id,
        statementIndex,
        startOffset,
        endOffset,
        node,
        sourceFile,
      });
      statementIndex++;
    }

    ts.forEachChild(node, visit);
  };

  visit(body);
  return collected;
}

export function buildStatementIndex(functionIndex: FunctionIndex): StatementIndex {
  const perFunction: Array<{ readonly func: IndexedFunction; readonly statements: readonly IndexedStatement[] }> = [];
  const all: IndexedStatement[] = [];

  const byId = new Map<StmtId, IndexedStatement>();
  const byFuncId = new Map<FuncId, readonly IndexedStatement[]>();

  for (const func of functionIndex.functions) {
    const statements = buildStatementsForFunction(func);
    perFunction.push({ func, statements });
    byFuncId.set(func.id, statements);

    for (const st of statements) {
      if (byId.has(st.id)) throw new Error(`Duplicate StmtId in statement index: ${st.id}`);
      byId.set(st.id, st);
      all.push(st);
    }
  }

  return {
    perFunction,
    statements: all,
    getById: (id) => byId.get(id),
    getByFuncId: (id) => byFuncId.get(id),
  };
}

export function buildStatementIndexFromProject(project: TsProject): StatementIndex {
  const fns = buildFunctionIndexFromProject(project);
  return buildStatementIndex(fns);
}

