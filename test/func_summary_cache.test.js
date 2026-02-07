import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { normalizeFuncSummary, serializeNormalizedFuncSummary } from "../src/func_summary.ts";
import { funcSummaryCachePath, readFuncSummaryFromCache, writeFuncSummaryToCache } from "../src/func_summary_cache.ts";
import { createFuncId } from "../src/ids.ts";
import { hashNormalizedFuncIr, normalizeFuncIr } from "../src/ir.ts";

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "hadrix-flow-cache-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("readFuncSummaryFromCache returns undefined when cache entry is missing (including missing root dir)", () => {
  withTempDir((dir) => {
    const funcId = createFuncId("src/a.ts", 0, 1);
    const ir = normalizeFuncIr({ schemaVersion: 1, funcId, params: [], locals: [], stmts: [] });
    const normalizedIrHash = hashNormalizedFuncIr(ir, 1);

    assert.equal(readFuncSummaryFromCache(join(dir, "does-not-exist"), normalizedIrHash), undefined);
    assert.equal(readFuncSummaryFromCache(dir, normalizedIrHash), undefined);
  });
});

test("writeFuncSummaryToCache writes canonical JSON and readFuncSummaryFromCache roundtrips", () => {
  withTempDir((dir) => {
    const funcId = createFuncId("src/a.ts", 0, 1);
    const ir = normalizeFuncIr({ schemaVersion: 1, funcId, params: [], locals: [], stmts: [] });
    const summary = normalizeFuncSummary({ schemaVersion: 1, funcId, edges: [] }, { ir, baselineEdges: [] });
    const normalizedIrHash = hashNormalizedFuncIr(ir, 1);

    writeFuncSummaryToCache(dir, normalizedIrHash, summary);
    const readBack = readFuncSummaryFromCache(dir, normalizedIrHash);
    assert.deepEqual(readBack, summary);

    const p = funcSummaryCachePath(dir, normalizedIrHash);
    assert.equal(readFileSync(p, "utf8"), `${serializeNormalizedFuncSummary(summary)}\n`);
  });
});

test("writeFuncSummaryToCache is idempotent and does not overwrite existing entries", () => {
  withTempDir((dir) => {
    const funcId = createFuncId("src/a.ts", 0, 1);
    const ir = normalizeFuncIr({ schemaVersion: 1, funcId, params: [], locals: [], stmts: [] });
    const normalizedIrHash = hashNormalizedFuncIr(ir, 1);

    const s1 = normalizeFuncSummary({ schemaVersion: 1, funcId, edges: [] }, { ir, baselineEdges: [] });
    writeFuncSummaryToCache(dir, normalizedIrHash, s1);
    const p = funcSummaryCachePath(dir, normalizedIrHash);
    const raw1 = readFileSync(p, "utf8");

    // Different content for the same key should be ignored.
    const s2 = { schemaVersion: 1, funcId, edges: [{ from: { kind: "return" }, to: { kind: "return" } }] };
    writeFuncSummaryToCache(dir, normalizedIrHash, s2);

    const raw2 = readFileSync(p, "utf8");
    assert.equal(raw2, raw1);
    assert.deepEqual(readFuncSummaryFromCache(dir, normalizedIrHash), s1);
  });
});

test("analysisConfigVersion participates in the normalized IR hash (cache key)", () => {
  withTempDir((dir) => {
    const funcId = createFuncId("src/a.ts", 0, 1);
    const ir = normalizeFuncIr({ schemaVersion: 1, funcId, params: [], locals: [], stmts: [] });
    const s = normalizeFuncSummary({ schemaVersion: 1, funcId, edges: [] }, { ir, baselineEdges: [] });

    const h1 = hashNormalizedFuncIr(ir, 1);
    const h2 = hashNormalizedFuncIr(ir, 2);
    assert.notEqual(h1, h2);

    writeFuncSummaryToCache(dir, h1, s);
    assert.equal(readFuncSummaryFromCache(dir, h2), undefined);
  });
});
