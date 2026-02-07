import { runCheapStaticPassV2 } from "./cheap_static_pass.ts";
import type { CheapDepEdge, CheapDepNode } from "./cheap_static_pass.ts";
import { FUNC_SUMMARY_SCHEMA_VERSION, normalizeFuncSummary } from "./func_summary.ts";
import type { FuncSummaryBounds, FuncSummaryEdge, FuncSummaryNode, NormalizedFuncSummary } from "./func_summary.ts";
import { readFuncSummaryFromCache, writeFuncSummaryToCache } from "./func_summary_cache.ts";
import type { FuncId } from "./ids.ts";
import { hashNormalizedFuncIr } from "./ir.ts";
import type { NormalizedFuncIR } from "./ir.ts";
import { buildFuncIrV3 } from "./ir_builder.ts";
import type { IndexedFunction } from "./function_indexer.ts";
import type { IndexedStatement, StatementIndex } from "./statement_indexer.ts";

export type IntraProcSummaryPipelineOptions = Readonly<{
  cacheRootDir: string;
  bounds?: Partial<FuncSummaryBounds>;
}>;

export type IntraProcSummaryPipelineResult = Readonly<{
  funcId: FuncId;
  normalizedIrHash: string;
  summary: NormalizedFuncSummary;
  cacheHit: boolean;
}>;

function cheapNodeToSummaryNode(n: CheapDepNode): FuncSummaryNode {
  if (n.kind === "var") return { kind: "var", id: n.id };
  if (n.kind === "call_arg") return { kind: "call_arg", callsiteId: n.callsiteId, index: n.index };
  if (n.kind === "heap_read") return { kind: "heap_read", id: n.id };
  if (n.kind === "heap_write") return { kind: "heap_write", id: n.id };
  return { kind: "return" };
}

function cheapEdgeToSummaryEdge(e: CheapDepEdge): FuncSummaryEdge {
  return { from: cheapNodeToSummaryNode(e.from), to: cheapNodeToSummaryNode(e.to) };
}

function cheapEdgesToSummaryEdges(edges: readonly CheapDepEdge[]): FuncSummaryEdge[] {
  // `runCheapStaticPassV2` already returns stable-sorted, de-duped edges; preserve ordering.
  return edges.map(cheapEdgeToSummaryEdge);
}

export function getOrComputeFuncSummaryCheapPassOnly(
  ir: NormalizedFuncIR,
  opts: IntraProcSummaryPipelineOptions,
): IntraProcSummaryPipelineResult {
  const normalizedIrHash = hashNormalizedFuncIr(ir);

  const baseline = runCheapStaticPassV2(ir);
  const baselineEdges = cheapEdgesToSummaryEdges(baseline.edges);

  const cached = readFuncSummaryFromCache(opts.cacheRootDir, normalizedIrHash);
  if (cached) {
    const summary = normalizeFuncSummary(cached, { ir, baselineEdges, bounds: opts.bounds });
    return { funcId: ir.funcId, normalizedIrHash, summary, cacheHit: true };
  }

  const computed = normalizeFuncSummary(
    { schemaVersion: FUNC_SUMMARY_SCHEMA_VERSION, funcId: ir.funcId, edges: baselineEdges },
    { ir, baselineEdges, bounds: opts.bounds },
  );
  writeFuncSummaryToCache(opts.cacheRootDir, normalizedIrHash, computed);
  return { funcId: ir.funcId, normalizedIrHash, summary: computed, cacheHit: false };
}

export function getOrComputeIndexedFuncSummaryCheapPassOnly(
  func: IndexedFunction,
  statements: readonly IndexedStatement[],
  opts: IntraProcSummaryPipelineOptions,
): IntraProcSummaryPipelineResult {
  const ir = buildFuncIrV3(func, statements);
  return getOrComputeFuncSummaryCheapPassOnly(ir, opts);
}

export function runIntraProcSummaryPipelineCheapPassOnly(
  statementIndex: StatementIndex,
  opts: IntraProcSummaryPipelineOptions,
): readonly IntraProcSummaryPipelineResult[] {
  const out: IntraProcSummaryPipelineResult[] = [];
  for (const entry of statementIndex.perFunction) {
    out.push(getOrComputeIndexedFuncSummaryCheapPassOnly(entry.func, entry.statements, opts));
  }
  return out;
}

