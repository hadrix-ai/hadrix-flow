import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { serializeNormalizedFuncSummary } from "./func_summary.ts";
import type { NormalizedFuncSummary } from "./func_summary.ts";

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

function assertSha256Hex(hash: string, label: string): void {
  if (!SHA256_HEX_RE.test(hash)) {
    throw new Error(`${label} must be a sha256 hex digest (64 lowercase hex chars); got ${JSON.stringify(hash)}`);
  }
}

export function funcSummaryCachePath(cacheRootDir: string, normalizedIrHash: string): string {
  assertSha256Hex(normalizedIrHash, "normalizedIrHash");

  // Shard by hash prefix to avoid huge single directories.
  const p1 = normalizedIrHash.slice(0, 2);
  const p2 = normalizedIrHash.slice(2, 4);
  return join(cacheRootDir, "func_summaries", p1, p2, `${normalizedIrHash}.json`);
}

export function readFuncSummaryFromCache(
  cacheRootDir: string,
  normalizedIrHash: string,
): NormalizedFuncSummary | undefined {
  const p = funcSummaryCachePath(cacheRootDir, normalizedIrHash);
  let raw: string;
  try {
    raw = readFileSync(p, "utf8");
  } catch (err) {
    const e = err as { code?: string };
    if (e && e.code === "ENOENT") return undefined;
    throw err;
  }

  try {
    return JSON.parse(raw) as NormalizedFuncSummary;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse cached FuncSummary JSON: path=${JSON.stringify(p)} error=${msg}`);
  }
}

export function writeFuncSummaryToCache(
  cacheRootDir: string,
  normalizedIrHash: string,
  summary: NormalizedFuncSummary,
): void {
  const p = funcSummaryCachePath(cacheRootDir, normalizedIrHash);
  mkdirSync(dirname(p), { recursive: true });

  // Content-addressed caches are immutable: once present, do not overwrite.
  try {
    const st = statSync(p);
    if (st.isFile()) return;
  } catch (err) {
    const e = err as { code?: string };
    if (!e || e.code !== "ENOENT") throw err;
  }

  const json = `${serializeNormalizedFuncSummary(summary)}\n`;

  // Best-effort atomic write: write to a sibling tmp file then rename into place.
  // We avoid random suffixes to keep the cache layout deterministic.
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, json, "utf8");
  // renameSync would overwrite on POSIX; since we already checked for existence above,
  // this is sufficient for our single-process MVP.
  renameSync(tmp, p);
}
