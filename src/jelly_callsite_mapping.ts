import { cmpNumber, cmpString, stableSort } from "./determinism.ts";
import type { CallsiteIndex, IndexedCallsite } from "./callsite_indexer.ts";
import type { CallsiteId, FuncId } from "./ids.ts";
import type { JellyCallEdge, JellyCallEdgeKind, NormalizedJellyCallGraph } from "./jelly_callgraph.ts";

export type JellyCallEdgeMappingMode = "strict" | "lenient";

export type JellyCallEdgeMappingDiagnostic = Readonly<{
  level: "warn" | "error";
  edgeIndex: number;
  callerId: string;
  calleeId: string;
  kind: JellyCallEdgeKind;
  jellyFilePath: string;
  resolvedFilePath: string | null;
  startOffset: number;
  endOffset: number;
  message: string;
}>;

export type JellyCallEdgeMappingResult = Readonly<{
  // Array aligned with `jelly.edges` ordering. Null indicates an unmapped edge in lenient mode.
  callsiteIdByEdgeIndex: ReadonlyArray<CallsiteId | null>;
  diagnostics: readonly JellyCallEdgeMappingDiagnostic[];
}>;

export type MapJellyCallEdgesToCallsiteIdsOptions = Readonly<{
  mode?: JellyCallEdgeMappingMode;
  // Optional: if provided, validate that mapped callsites belong to the mapped caller function.
  nodeIdToFuncId?: ReadonlyMap<string, FuncId>;
}>;

function toPosixPath(p: string): string {
  return p.replaceAll("\\", "/");
}

function collapseSlashes(p: string): string {
  // Avoid regex backtracking surprises; paths are short and ASCII by convention.
  while (p.includes("//")) p = p.replaceAll("//", "/");
  return p;
}

function stripDotSlashPrefix(p: string): string {
  while (p.startsWith("./")) p = p.slice(2);
  return p;
}

function stripLeadingSlashes(p: string): string {
  while (p.startsWith("/")) p = p.slice(1);
  return p;
}

function lenientNormalizePath(p: string): { readonly normalized: string; readonly changed: boolean } {
  const normalized = stripLeadingSlashes(stripDotSlashPrefix(collapseSlashes(toPosixPath(p))));
  return { normalized, changed: normalized !== p };
}

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

function pathSegments(p: string): readonly string[] {
  // We assume POSIX separators at call sites.
  return p.length === 0 ? [] : p.split("/");
}

function isSuffixSegments(shorter: readonly string[], longer: readonly string[]): boolean {
  if (shorter.length > longer.length) return false;
  const offset = longer.length - shorter.length;
  for (let i = 0; i < shorter.length; i++) {
    if (shorter[i] !== longer[offset + i]) return false;
  }
  return true;
}

type FilePathResolverCtx = Readonly<{
  uniqueFilePathsSorted: readonly string[];
  filePathSet: ReadonlySet<string>;
  filePathLowerToPaths: ReadonlyMap<string, readonly string[]>;
  basenameToPaths: ReadonlyMap<string, readonly string[]>;
  basenameLowerToPaths: ReadonlyMap<string, readonly string[]>;
}>;

function buildFilePathResolverCtx(callsiteIndex: CallsiteIndex): FilePathResolverCtx {
  const uniqueFilePathsSorted = stableSort(
    Array.from(new Set(callsiteIndex.perFunction.map((p) => p.func.filePath))),
    cmpString,
  );

  const filePathSet = new Set(uniqueFilePathsSorted);

  const filePathLowerToPaths = new Map<string, string[]>();
  const basenameToPaths = new Map<string, string[]>();
  const basenameLowerToPaths = new Map<string, string[]>();

  for (const fp of uniqueFilePathsSorted) {
    const lower = fp.toLowerCase();
    const sameLower = filePathLowerToPaths.get(lower);
    if (sameLower) sameLower.push(fp);
    else filePathLowerToPaths.set(lower, [fp]);

    const base = basename(fp);
    const sameBase = basenameToPaths.get(base);
    if (sameBase) sameBase.push(fp);
    else basenameToPaths.set(base, [fp]);

    const baseLower = base.toLowerCase();
    const sameBaseLower = basenameLowerToPaths.get(baseLower);
    if (sameBaseLower) sameBaseLower.push(fp);
    else basenameLowerToPaths.set(baseLower, [fp]);
  }

  return {
    uniqueFilePathsSorted,
    filePathSet,
    filePathLowerToPaths,
    basenameToPaths,
    basenameLowerToPaths,
  };
}

type ResolvedFilePath = Readonly<
  | { kind: "ok"; filePath: string; warn?: string }
  | { kind: "ambiguous"; message: string; candidates: readonly string[] }
  | { kind: "missing"; message: string }
>;

function resolveFilePath(ctx: FilePathResolverCtx, jellyFilePath: string, mode: JellyCallEdgeMappingMode): ResolvedFilePath {
  if (ctx.filePathSet.has(jellyFilePath)) return { kind: "ok", filePath: jellyFilePath };

  if (mode === "strict") {
    return { kind: "missing", message: `Jelly filePath is not in analyzed source files: ${JSON.stringify(jellyFilePath)}` };
  }

  const { normalized, changed } = lenientNormalizePath(jellyFilePath);
  const normalizedWarn = changed
    ? `Normalized Jelly filePath ${JSON.stringify(jellyFilePath)} -> ${JSON.stringify(normalized)}`
    : undefined;

  if (ctx.filePathSet.has(normalized)) {
    return { kind: "ok", filePath: normalized, warn: normalizedWarn };
  }

  const lowerMatches = ctx.filePathLowerToPaths.get(normalized.toLowerCase());
  if (lowerMatches && lowerMatches.length > 0) {
    if (lowerMatches.length === 1) {
      const filePath = lowerMatches[0]!;
      const warn = normalizedWarn
        ? `${normalizedWarn}; case-insensitive match -> ${JSON.stringify(filePath)}`
        : `Case-insensitive match for Jelly filePath ${JSON.stringify(normalized)} -> ${JSON.stringify(filePath)}`;
      return { kind: "ok", filePath, warn };
    }

    return {
      kind: "ambiguous",
      message: `Jelly filePath matches multiple analyzed files (case-insensitive): ${JSON.stringify(normalized)}`,
      candidates: stableSort(lowerMatches, cmpString),
    };
  }

  // Last-ditch suffix matching using basename buckets.
  const base = basename(normalized);
  const candidates = ctx.basenameToPaths.get(base) ?? ctx.basenameLowerToPaths.get(base.toLowerCase()) ?? [];
  if (candidates.length === 0) {
    return { kind: "missing", message: `Jelly filePath does not match any analyzed file: ${JSON.stringify(normalized)}` };
  }

  const jellySeg = pathSegments(normalized);

  const matches: Array<{ readonly filePath: string; readonly matchSegments: number }> = [];
  for (const fp of candidates) {
    const fpSeg = pathSegments(fp);
    if (isSuffixSegments(fpSeg, jellySeg) || isSuffixSegments(jellySeg, fpSeg)) {
      matches.push({ filePath: fp, matchSegments: Math.min(fpSeg.length, jellySeg.length) });
    }
  }

  if (matches.length === 0) {
    // Basename matches, but path tails don't. This is still useful diagnostic info.
    return {
      kind: "missing",
      message: `Jelly filePath basename matches analyzed files, but no suffix match found: ${JSON.stringify(normalized)} candidates=${JSON.stringify(
        stableSort(candidates, cmpString),
      )}`,
    };
  }

  // Prefer the most-specific suffix match; require uniqueness.
  const maxSeg = Math.max(...matches.map((m) => m.matchSegments));
  const best = stableSort(
    matches.filter((m) => m.matchSegments === maxSeg),
    (a, b) => cmpString(a.filePath, b.filePath),
  );

  if (best.length !== 1) {
    return {
      kind: "ambiguous",
      message: `Jelly filePath suffix-matches multiple analyzed files: ${JSON.stringify(normalized)}`,
      candidates: best.map((m) => m.filePath),
    };
  }

  const chosen = best[0]!.filePath;
  const warn = normalizedWarn
    ? `${normalizedWarn}; suffix match -> ${JSON.stringify(chosen)}`
    : `Suffix match for Jelly filePath ${JSON.stringify(normalized)} -> ${JSON.stringify(chosen)}`;
  return { kind: "ok", filePath: chosen, warn };
}

function buildCallsitesByFilePath(callsiteIndex: CallsiteIndex): ReadonlyMap<string, readonly IndexedCallsite[]> {
  const map = new Map<string, IndexedCallsite[]>();
  // `callsiteIndex.callsites` is stable-sorted by CallsiteId.
  for (const cs of callsiteIndex.callsites) {
    const arr = map.get(cs.filePath);
    if (arr) arr.push(cs);
    else map.set(cs.filePath, [cs]);
  }
  return map;
}

function fmtNearestCallsites(
  byFilePath: ReadonlyMap<string, readonly IndexedCallsite[]>,
  filePath: string,
  startOffset: number,
): string {
  const callsites = byFilePath.get(filePath);
  if (!callsites || callsites.length === 0) return "No indexed callsites in resolved file.";

  // Keep this deterministic and small: show up to 3 closest by start offset.
  const scored = callsites.map((cs) => ({
    callsiteId: cs.id,
    startOffset: cs.startOffset,
    endOffset: cs.endOffset,
    dist: Math.abs(cs.startOffset - startOffset),
  }));

  const sorted = stableSort(
    scored,
    (a, b) => cmpNumber(a.dist, b.dist) || cmpNumber(a.startOffset, b.startOffset) || cmpString(a.callsiteId, b.callsiteId),
  );
  const top = sorted.slice(0, 3);

  const parts = top.map((t) => `${t.callsiteId} span=${t.startOffset}..${t.endOffset}`);
  return `Nearest indexed callsites: ${parts.join(", ")}`;
}

function diagKey(d: JellyCallEdgeMappingDiagnostic): string {
  // NUL-delimited so keys can't collide.
  return `${d.jellyFilePath}\0${d.startOffset}\0${d.endOffset}\0${d.edgeIndex}\0${d.level}\0${d.message}`;
}

function cmpDiagnostic(a: JellyCallEdgeMappingDiagnostic, b: JellyCallEdgeMappingDiagnostic): number {
  // Keep diagnostics ordering stable and predictable independent of internal algorithm details.
  return (
    cmpString(a.jellyFilePath, b.jellyFilePath) ||
    cmpNumber(a.startOffset, b.startOffset) ||
    cmpNumber(a.endOffset, b.endOffset) ||
    cmpNumber(a.edgeIndex, b.edgeIndex) ||
    cmpString(a.callerId, b.callerId) ||
    cmpString(a.calleeId, b.calleeId) ||
    cmpString(a.kind, b.kind) ||
    cmpString(a.level, b.level) ||
    cmpString(a.message, b.message)
  );
}

function formatEdgeLabel(e: JellyCallEdge, edgeIndex: number): string {
  return `edgeIndex=${edgeIndex} callerId=${JSON.stringify(e.callerId)} calleeId=${JSON.stringify(e.calleeId)} kind=${JSON.stringify(e.kind)} callsite.filePath=${JSON.stringify(e.callsite.filePath)} span=${e.callsite.startOffset}..${e.callsite.endOffset}`;
}

export function mapJellyCallEdgesToCallsiteIds(
  jelly: NormalizedJellyCallGraph,
  callsiteIndex: CallsiteIndex,
  opts: MapJellyCallEdgesToCallsiteIdsOptions = {},
): JellyCallEdgeMappingResult {
  const mode: JellyCallEdgeMappingMode = opts.mode ?? "strict";
  const nodeIdToFuncId = opts.nodeIdToFuncId;

  const resolverCtx = buildFilePathResolverCtx(callsiteIndex);
  const callsitesByFilePath = buildCallsitesByFilePath(callsiteIndex);

  const callsiteIdByEdgeIndex: Array<CallsiteId | null> = new Array(jelly.edges.length).fill(null);
  const diagnostics: JellyCallEdgeMappingDiagnostic[] = [];

  for (let i = 0; i < jelly.edges.length; i++) {
    const e = jelly.edges[i]!;

    if (e.kind !== "call") {
      diagnostics.push({
        level: "error",
        edgeIndex: i,
        callerId: e.callerId,
        calleeId: e.calleeId,
        kind: e.kind,
        jellyFilePath: e.callsite.filePath,
        resolvedFilePath: null,
        startOffset: e.callsite.startOffset,
        endOffset: e.callsite.endOffset,
        message: `Unsupported Jelly call edge kind for callsite mapping: ${JSON.stringify(e.kind)} (only "call" is supported)`,
      });
      continue;
    }

    const resolved = resolveFilePath(resolverCtx, e.callsite.filePath, mode);
    if (resolved.kind === "ambiguous") {
      diagnostics.push({
        level: "error",
        edgeIndex: i,
        callerId: e.callerId,
        calleeId: e.calleeId,
        kind: e.kind,
        jellyFilePath: e.callsite.filePath,
        resolvedFilePath: null,
        startOffset: e.callsite.startOffset,
        endOffset: e.callsite.endOffset,
        message: `${resolved.message} candidates=${JSON.stringify(resolved.candidates)}`,
      });
      continue;
    }

    if (resolved.kind === "missing") {
      diagnostics.push({
        level: "error",
        edgeIndex: i,
        callerId: e.callerId,
        calleeId: e.calleeId,
        kind: e.kind,
        jellyFilePath: e.callsite.filePath,
        resolvedFilePath: null,
        startOffset: e.callsite.startOffset,
        endOffset: e.callsite.endOffset,
        message: resolved.message,
      });
      continue;
    }

    if (resolved.warn) {
      diagnostics.push({
        level: "warn",
        edgeIndex: i,
        callerId: e.callerId,
        calleeId: e.calleeId,
        kind: e.kind,
        jellyFilePath: e.callsite.filePath,
        resolvedFilePath: resolved.filePath,
        startOffset: e.callsite.startOffset,
        endOffset: e.callsite.endOffset,
        message: resolved.warn,
      });
    }

    const cs = callsiteIndex.getBySpan(resolved.filePath, e.callsite.startOffset, e.callsite.endOffset);
    if (!cs) {
      diagnostics.push({
        level: "error",
        edgeIndex: i,
        callerId: e.callerId,
        calleeId: e.calleeId,
        kind: e.kind,
        jellyFilePath: e.callsite.filePath,
        resolvedFilePath: resolved.filePath,
        startOffset: e.callsite.startOffset,
        endOffset: e.callsite.endOffset,
        message: `No indexed callsite matches Jelly span in resolved file. ${fmtNearestCallsites(
          callsitesByFilePath,
          resolved.filePath,
          e.callsite.startOffset,
        )}`,
      });
      continue;
    }

    const expectedCallerFuncId = nodeIdToFuncId?.get(e.callerId);
    if (expectedCallerFuncId && cs.funcId !== expectedCallerFuncId) {
      diagnostics.push({
        level: "error",
        edgeIndex: i,
        callerId: e.callerId,
        calleeId: e.calleeId,
        kind: e.kind,
        jellyFilePath: e.callsite.filePath,
        resolvedFilePath: resolved.filePath,
        startOffset: e.callsite.startOffset,
        endOffset: e.callsite.endOffset,
        message: `Mapped callsite belongs to a different function than edge.callerId: callsite.funcId=${cs.funcId} expectedCallerFuncId=${expectedCallerFuncId}`,
      });
      continue;
    }

    callsiteIdByEdgeIndex[i] = cs.id;
  }

  // De-dupe diagnostics deterministically (multiple normalization paths can generate identical lines).
  const unique = new Map<string, JellyCallEdgeMappingDiagnostic>();
  for (const d of diagnostics) unique.set(diagKey(d), d);
  const deduped = stableSort(Array.from(unique.values()), cmpDiagnostic);

  const errorCount = deduped.filter((d) => d.level === "error").length;
  if (mode === "strict" && errorCount > 0) {
    const lines: string[] = [];
    lines.push(
      `Jelly call edge callsite mapping failed in strict mode: ${errorCount} error(s) while mapping ${jelly.edges.length} edge(s)`,
    );
    for (const d of deduped) {
      if (d.level !== "error") continue;
      const e = jelly.edges[d.edgeIndex]!;
      lines.push(`- ${formatEdgeLabel(e, d.edgeIndex)}: ${d.message}`);
    }
    throw new Error(lines.join("\n"));
  }

  return { callsiteIdByEdgeIndex, diagnostics: deduped };
}

