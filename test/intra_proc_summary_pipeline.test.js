import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runCheapStaticPassV2 } from "../src/cheap_static_pass.ts";
import { FUNC_SUMMARY_SCHEMA_VERSION } from "../src/func_summary.ts";
import { funcSummaryCachePath } from "../src/func_summary_cache.ts";
import {
  getOrComputeIndexedFuncSummaryCheapPassOnly,
  getOrComputeIndexedFuncSummaryHybridLlm,
} from "../src/intra_proc_summary_pipeline.ts";
import { buildFuncIrV3 } from "../src/ir_builder.ts";
import { buildStatementIndexFromProject } from "../src/statement_indexer.ts";
import { loadTsProject } from "../src/ts_project.ts";

const testDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(testDir, "..");

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "hadrix-flow-intraproc-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function loadFixtureStatements() {
  const fixtureDir = join(projectRoot, "test", "fixtures", "basic");
  const tsconfigPath = join(fixtureDir, "tsconfig.json");
  const project = loadTsProject({ tsconfig: tsconfigPath });
  return buildStatementIndexFromProject(project);
}

function findFuncEntryBySnippet(stIdx, needle) {
  const entry = stIdx.perFunction.find(({ func }) =>
    func.sourceFile.text.slice(func.startOffset, func.endOffset).includes(needle),
  );
  assert.ok(entry, `Expected to find function containing snippet: ${needle}`);
  return entry;
}

test("intra-proc summary pipeline (cheap-pass-only): cache miss computes + writes canonical summary", () => {
  withTempDir((cacheRootDir) => {
    const stIdx = loadFixtureStatements();
    const entry = findFuncEntryBySnippet(stIdx, "function pipeline");

    const res = getOrComputeIndexedFuncSummaryCheapPassOnly(entry.func, entry.statements, { cacheRootDir });
    assert.equal(res.cacheHit, false);

    const ir = buildFuncIrV3(entry.func, entry.statements);
    const baseline = runCheapStaticPassV2(ir);
    assert.deepEqual(res.summary.edges, baseline.edges);

    const cachePath = funcSummaryCachePath(cacheRootDir, res.normalizedIrHash);
    assert.ok(readFileSync(cachePath, "utf8").length > 0);
  });
});

test("intra-proc summary pipeline (cheap-pass-only): cache hit loads + does not overwrite", () => {
  withTempDir((cacheRootDir) => {
    const stIdx = loadFixtureStatements();
    const entry = findFuncEntryBySnippet(stIdx, "function pipeline");

    const r1 = getOrComputeIndexedFuncSummaryCheapPassOnly(entry.func, entry.statements, { cacheRootDir });
    const cachePath = funcSummaryCachePath(cacheRootDir, r1.normalizedIrHash);
    const raw1 = readFileSync(cachePath, "utf8");

    const r2 = getOrComputeIndexedFuncSummaryCheapPassOnly(entry.func, entry.statements, { cacheRootDir });
    const raw2 = readFileSync(cachePath, "utf8");

    assert.equal(r2.cacheHit, true);
    assert.deepEqual(r2.summary, r1.summary);
    assert.equal(raw2, raw1);
  });
});

test("intra-proc summary pipeline (hybrid-llm): retries invalid output, then writes + caches canonical summary", () => {
  withTempDir((cacheRootDir) => {
    const stIdx = loadFixtureStatements();
    const entry = findFuncEntryBySnippet(stIdx, "function pipeline");

    const calls = [];
    const extractor = {
      kind: "test-mock",
      extractFuncSummary: ({ ir, baselineEdges, attempt, previousError }) => {
        calls.push({ attempt, previousError });
        if (attempt === 1) {
          // Invalid: references an undeclared VarId to force a validation failure.
          return {
            schemaVersion: FUNC_SUMMARY_SCHEMA_VERSION,
            funcId: ir.funcId,
            edges: [...baselineEdges, { from: { kind: "var", id: "v999" }, to: { kind: "return" } }],
          };
        }

        const p0 = ir.params[0];
        const extra = p0 ? [{ from: { kind: "var", id: p0 }, to: { kind: "return" } }] : [];
        return {
          schemaVersion: FUNC_SUMMARY_SCHEMA_VERSION,
          funcId: ir.funcId,
          edges: [...baselineEdges, ...extra],
        };
      },
    };

    const r1 = getOrComputeIndexedFuncSummaryHybridLlm(entry.func, entry.statements, {
      cacheRootDir,
      extractor,
      maxAttempts: 2,
    });
    assert.equal(r1.cacheHit, false);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], { attempt: 1, previousError: undefined });
    assert.equal(calls[1].attempt, 2);
    assert.equal(typeof calls[1].previousError, "string");

    const cachePath = funcSummaryCachePath(cacheRootDir, r1.normalizedIrHash);
    const raw1 = readFileSync(cachePath, "utf8");
    assert.ok(raw1.length > 0);

    const r2 = getOrComputeIndexedFuncSummaryHybridLlm(entry.func, entry.statements, {
      cacheRootDir,
      extractor,
      maxAttempts: 2,
    });
    const raw2 = readFileSync(cachePath, "utf8");

    assert.equal(r2.cacheHit, true);
    assert.deepEqual(r2.summary, r1.summary);
    assert.equal(raw2, raw1);
    assert.equal(calls.length, 2);
  });
});
