import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { canonicalJsonStringify, sha256HexFromUtf8, stableSort } from "./determinism.ts";
import { DEFAULT_FUNC_SUMMARY_BOUNDS, FUNC_SUMMARY_SCHEMA_VERSION } from "./func_summary.ts";
import type { NormalizedFuncSummary } from "./func_summary.ts";
import { cmpFuncId, funcIdToParts } from "./ids.ts";
import type { FuncId } from "./ids.ts";
import { ANALYSIS_CONFIG_VERSION, FUNC_IR_SCHEMA_VERSION } from "./ir.ts";
import type { NormalizedFuncIR } from "./ir.ts";

export const EXPLAIN_BUNDLE_SCHEMA_VERSION = 1 as const;
export const EXPLAIN_MANIFEST_SCHEMA_VERSION = 1 as const;

export type FuncExplainBundle = Readonly<{
  schemaVersion: typeof EXPLAIN_BUNDLE_SCHEMA_VERSION;
  kind: "func_explain";
  funcId: FuncId;
  filePath: string;
  startOffset: number;
  endOffset: number;
  normalizedIrHash: string;
  ir: NormalizedFuncIR;
  summary: NormalizedFuncSummary;
  validation: Readonly<{
    analysisConfigVersion: number;
    funcIrSchemaVersion: number;
    funcSummarySchemaVersion: number;
    bounds: Readonly<{ maxEdges: number; maxFanout: number }>;
    baselineCoverage: "ok";
  }>;
  warnings: readonly string[];
}>;

export type ExplainManifestEntry = Readonly<{
  funcId: FuncId;
  funcIdHash: string;
  filePath: string;
  startOffset: number;
  endOffset: number;
  normalizedIrHash: string;
  bundlePath: string;
}>;

export type ExplainManifest = Readonly<{
  schemaVersion: typeof EXPLAIN_MANIFEST_SCHEMA_VERSION;
  kind: "explain_manifest";
  analysisConfigVersion: number;
  functions: readonly ExplainManifestEntry[];
}>;

export type FuncExplainInput = Readonly<{
  funcId: FuncId;
  normalizedIrHash: string;
  ir: NormalizedFuncIR;
  summary: NormalizedFuncSummary;
}>;

function funcIdHash(funcId: FuncId): string {
  // Avoid embedding FuncId directly in filenames (":" is invalid on Windows).
  return sha256HexFromUtf8(funcId);
}

export function writeExplainBundlesDir(outDir: string, funcs: readonly FuncExplainInput[]): void {
  const outAbs = resolve(outDir);
  const funcDir = join(outAbs, "functions");

  // Keep output deterministic: clear only our managed subtree.
  rmSync(funcDir, { recursive: true, force: true });
  mkdirSync(funcDir, { recursive: true });

  const sorted = stableSort([...funcs], (a, b) => cmpFuncId(a.funcId, b.funcId));

  const manifestEntries: ExplainManifestEntry[] = [];
  for (const f of sorted) {
    const parts = funcIdToParts(f.funcId);
    const hash = funcIdHash(f.funcId);
    const fileName = `${hash}.json`;
    const relPath = `functions/${fileName}`;

    const bundle: FuncExplainBundle = {
      schemaVersion: EXPLAIN_BUNDLE_SCHEMA_VERSION,
      kind: "func_explain",
      funcId: f.funcId,
      filePath: parts.filePath,
      startOffset: parts.startOffset,
      endOffset: parts.endOffset,
      normalizedIrHash: f.normalizedIrHash,
      ir: f.ir,
      summary: f.summary,
      validation: {
        analysisConfigVersion: ANALYSIS_CONFIG_VERSION,
        funcIrSchemaVersion: FUNC_IR_SCHEMA_VERSION,
        funcSummarySchemaVersion: FUNC_SUMMARY_SCHEMA_VERSION,
        bounds: DEFAULT_FUNC_SUMMARY_BOUNDS,
        baselineCoverage: "ok",
      },
      warnings: [],
    };

    writeFileSync(join(funcDir, fileName), `${canonicalJsonStringify(bundle)}\n`, "utf8");

    manifestEntries.push({
      funcId: f.funcId,
      funcIdHash: hash,
      filePath: parts.filePath,
      startOffset: parts.startOffset,
      endOffset: parts.endOffset,
      normalizedIrHash: f.normalizedIrHash,
      bundlePath: relPath,
    });
  }

  const manifest: ExplainManifest = {
    schemaVersion: EXPLAIN_MANIFEST_SCHEMA_VERSION,
    kind: "explain_manifest",
    analysisConfigVersion: ANALYSIS_CONFIG_VERSION,
    functions: manifestEntries,
  };
  writeFileSync(join(outAbs, "manifest.json"), `${canonicalJsonStringify(manifest)}\n`, "utf8");
}

