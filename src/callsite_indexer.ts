import ts from "typescript";

import { stableSort } from "./determinism.ts";
import { cmpCallsiteId } from "./ids.ts";
import type { CallsiteId, FuncId } from "./ids.ts";
import type { IndexedFunction } from "./function_indexer.ts";
import { buildStatementIndexFromProject } from "./statement_indexer.ts";
import type { IndexedStatement, StatementIndex } from "./statement_indexer.ts";
import type { TsProject } from "./ts_project.ts";

export type IndexedCallsite = Readonly<{
  id: CallsiteId;
  funcId: FuncId;
  // Repo-relative, POSIX-separated.
  filePath: string;
  // Offsets are in `sourceFile.text` coordinates.
  startOffset: number;
  endOffset: number;
  node: ts.CallExpression;
  sourceFile: ts.SourceFile;
}>;

export type CallsiteIndex = Readonly<{
  // Aligned with the statement indexer per-function ordering (and thus the function index).
  perFunction: ReadonlyArray<
    Readonly<{
      func: IndexedFunction;
      callsites: readonly IndexedCallsite[];
    }>
  >;
  // Sorted by `cmpCallsiteId` for deterministic iteration.
  callsites: readonly IndexedCallsite[];
  getById: (id: CallsiteId) => IndexedCallsite | undefined;
  getByFuncId: (id: FuncId) => readonly IndexedCallsite[] | undefined;
  getBySpan: (filePath: string, startOffset: number, endOffset: number) => IndexedCallsite | undefined;
}>;

function spanKey(filePath: string, startOffset: number, endOffset: number): string {
  // File paths cannot contain NUL, so this is unambiguous and fast.
  return `${filePath}\0${startOffset}\0${endOffset}`;
}

function isCallsiteStatement(st: IndexedStatement): st is IndexedStatement & { readonly node: ts.CallExpression } {
  return ts.isCallExpression(st.node);
}

export function buildCallsiteIndex(statementIndex: StatementIndex): CallsiteIndex {
  const perFunction: Array<{ readonly func: IndexedFunction; readonly callsites: readonly IndexedCallsite[] }> = [];
  const collected: IndexedCallsite[] = [];

  const byId = new Map<CallsiteId, IndexedCallsite>();
  const byFuncId = new Map<FuncId, readonly IndexedCallsite[]>();
  const bySpan = new Map<string, IndexedCallsite>();

  for (const { func, statements } of statementIndex.perFunction) {
    const callsites: IndexedCallsite[] = [];

    for (const st of statements) {
      if (!isCallsiteStatement(st)) continue;

      // By architecture, CallsiteId is the StmtId for call expressions.
      const cs: IndexedCallsite = {
        id: st.id,
        funcId: st.funcId,
        filePath: func.filePath,
        startOffset: st.startOffset,
        endOffset: st.endOffset,
        node: st.node,
        sourceFile: st.sourceFile,
      };

      if (byId.has(cs.id)) throw new Error(`Duplicate CallsiteId in callsite index: ${cs.id}`);
      byId.set(cs.id, cs);

      const key = spanKey(cs.filePath, cs.startOffset, cs.endOffset);
      if (bySpan.has(key)) {
        throw new Error(
          `Duplicate callsite span in index: filePath=${JSON.stringify(cs.filePath)} start=${cs.startOffset} end=${cs.endOffset}`,
        );
      }
      bySpan.set(key, cs);

      callsites.push(cs);
      collected.push(cs);
    }

    perFunction.push({ func, callsites });
    byFuncId.set(func.id, callsites);
  }

  const callsites = stableSort(collected, (a, b) => cmpCallsiteId(a.id, b.id));

  return {
    perFunction,
    callsites,
    getById: (id) => byId.get(id),
    getByFuncId: (id) => byFuncId.get(id),
    getBySpan: (filePath, startOffset, endOffset) => bySpan.get(spanKey(filePath, startOffset, endOffset)),
  };
}

export function buildCallsiteIndexFromProject(project: TsProject): CallsiteIndex {
  const st = buildStatementIndexFromProject(project);
  return buildCallsiteIndex(st);
}

