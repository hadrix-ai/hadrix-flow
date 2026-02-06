import ts from "typescript";

import { stableSort } from "./determinism.ts";
import { cmpFuncId, createFuncId } from "./ids.ts";
import type { FuncId } from "./ids.ts";
import type { TsProject } from "./ts_project.ts";

export type IndexedFunction = Readonly<{
  id: FuncId;
  // Repo-relative, POSIX-separated.
  filePath: string;
  // Offsets are in `sourceFile.text` coordinates.
  startOffset: number;
  endOffset: number;
  node: ts.FunctionLikeDeclaration;
  sourceFile: ts.SourceFile;
}>;

export type FunctionIndex = Readonly<{
  // Sorted by `cmpFuncId` for deterministic iteration.
  functions: readonly IndexedFunction[];
  getById: (id: FuncId) => IndexedFunction | undefined;
  getBySpan: (filePath: string, startOffset: number, endOffset: number) => IndexedFunction | undefined;
}>;

export type FunctionIndexInput = Readonly<{
  // Repo-relative, POSIX-separated paths aligned with `sourceFiles`.
  sourceFilePaths: readonly string[];
  sourceFiles: readonly ts.SourceFile[];
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

function spanKey(filePath: string, startOffset: number, endOffset: number): string {
  // File paths cannot contain NUL, so this is unambiguous and fast.
  return `${filePath}\0${startOffset}\0${endOffset}`;
}

export function buildFunctionIndex(input: FunctionIndexInput): FunctionIndex {
  if (input.sourceFilePaths.length !== input.sourceFiles.length) {
    throw new Error(
      `buildFunctionIndex: sourceFilePaths/sourceFiles length mismatch: ${input.sourceFilePaths.length} vs ${input.sourceFiles.length}`,
    );
  }

  const collected: IndexedFunction[] = [];

  for (let i = 0; i < input.sourceFiles.length; i++) {
    const sourceFile = input.sourceFiles[i]!;
    const filePath = input.sourceFilePaths[i]!;

    const visit = (node: ts.Node): void => {
      if (isIndexableFunctionLikeNode(node)) {
        const fn = node as ts.FunctionLikeDeclaration;
        if (functionLikeHasBody(fn)) {
          // Offsets are computed excluding leading trivia, matching TS token spans.
          const startOffset = fn.getStart(sourceFile, /*includeJsDocComment*/ false);
          const endOffset = fn.getEnd();
          const id = createFuncId(filePath, startOffset, endOffset);
          collected.push({ id, filePath, startOffset, endOffset, node: fn, sourceFile });
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  const functions = stableSort(collected, (a, b) => cmpFuncId(a.id, b.id));

  const byId = new Map<FuncId, IndexedFunction>();
  const bySpan = new Map<string, IndexedFunction>();
  for (const f of functions) {
    if (byId.has(f.id)) {
      throw new Error(`Duplicate FuncId in function index: ${f.id}`);
    }
    byId.set(f.id, f);

    const key = spanKey(f.filePath, f.startOffset, f.endOffset);
    if (bySpan.has(key)) {
      throw new Error(
        `Duplicate function span in index: filePath=${JSON.stringify(f.filePath)} start=${f.startOffset} end=${f.endOffset}`,
      );
    }
    bySpan.set(key, f);
  }

  return {
    functions,
    getById: (id) => byId.get(id),
    getBySpan: (filePath, startOffset, endOffset) => bySpan.get(spanKey(filePath, startOffset, endOffset)),
  };
}

export function buildFunctionIndexFromProject(project: TsProject): FunctionIndex {
  return buildFunctionIndex({ sourceFilePaths: project.sourceFilePaths, sourceFiles: project.sourceFiles });
}
