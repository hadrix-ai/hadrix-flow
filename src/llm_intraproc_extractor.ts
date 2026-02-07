import type { FuncSummaryEdge } from "./func_summary.ts";
import type { NormalizedFuncIR } from "./ir.ts";

export type LlmIntraProcExtractRequest = Readonly<{
  ir: NormalizedFuncIR;
  baselineEdges: readonly FuncSummaryEdge[];
  // 1-based attempt counter for retry loops.
  attempt: number;
  // Validation/runtime error from the previous attempt, if any.
  previousError?: string;
}>;

// Note: intentionally synchronous for the MVP. A future provider can use a
// subprocess for offline use-cases; networked providers can be layered later.
export type LlmIntraProcSummaryExtractor = Readonly<{
  kind: string;
  extractFuncSummary: (req: LlmIntraProcExtractRequest) => unknown;
}>;

