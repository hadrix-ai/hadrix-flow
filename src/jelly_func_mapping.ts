import { cmpNumber, cmpString, stableSort } from "./determinism.ts";
import type { FunctionIndex, IndexedFunction } from "./function_indexer.ts";
import type { FuncId } from "./ids.ts";
import type { JellyFunctionNode, NormalizedJellyCallGraph } from "./jelly_callgraph.ts";

export type JellyFuncNodeMappingMode = "strict" | "lenient";

export type JellyFuncNodeMappingDiagnostic = Readonly<{
  level: "warn" | "error";
  nodeId: string;
  nodeName: string | null;
  jellyFilePath: string;
  resolvedFilePath: string | null;
  startOffset: number;
  endOffset: number;
  message: string;
}>;

export type JellyFuncNodeMappingResult = Readonly<{
  nodeIdToFuncId: ReadonlyMap<string, FuncId>;
  diagnostics: readonly JellyFuncNodeMappingDiagnostic[];
}>;

export type MapJellyFunctionNodesToFuncIdsOptions = Readonly<{
  mode?: JellyFuncNodeMappingMode;
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

function buildFilePathResolverCtx(index: FunctionIndex): FilePathResolverCtx {
  const uniqueFilePathsSorted = stableSort(
    Array.from(new Set(index.functions.map((f) => f.filePath))),
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

function resolveFilePath(ctx: FilePathResolverCtx, jellyFilePath: string, mode: JellyFuncNodeMappingMode): ResolvedFilePath {
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

function buildFunctionsByFilePath(index: FunctionIndex): ReadonlyMap<string, readonly IndexedFunction[]> {
  const map = new Map<string, IndexedFunction[]>();
  // `index.functions` is already stable-sorted by `(filePath, startOffset, endOffset)`.
  for (const f of index.functions) {
    const arr = map.get(f.filePath);
    if (arr) arr.push(f);
    else map.set(f.filePath, [f]);
  }
  return map;
}

function fmtNearestFunctions(
  byFilePath: ReadonlyMap<string, readonly IndexedFunction[]>,
  filePath: string,
  startOffset: number,
  endOffset: number,
): string {
  const fns = byFilePath.get(filePath);
  if (!fns || fns.length === 0) return "No indexed functions in resolved file.";

  // Keep this deterministic and small: show up to 3 closest by start offset.
  const scored = fns.map((f) => ({
    funcId: f.id,
    startOffset: f.startOffset,
    endOffset: f.endOffset,
    // Absolute difference is deterministic; tie-break below ensures stable.
    dist: Math.abs(f.startOffset - startOffset),
  }));

  const sorted = stableSort(scored, (a, b) => cmpNumber(a.dist, b.dist) || cmpNumber(a.startOffset, b.startOffset));
  const top = sorted.slice(0, 3);

  const parts = top.map((t) => `${t.funcId} span=${t.startOffset}..${t.endOffset}`);
  return `Nearest indexed functions: ${parts.join(", ")}`;
}

function diagKey(d: JellyFuncNodeMappingDiagnostic): string {
  // NUL-delimited so keys can't collide.
  return `${d.jellyFilePath}\0${d.startOffset}\0${d.endOffset}\0${d.nodeId}\0${d.level}\0${d.message}`;
}

function cmpDiagnostic(a: JellyFuncNodeMappingDiagnostic, b: JellyFuncNodeMappingDiagnostic): number {
  // Keep diagnostics ordering stable and predictable independent of internal algorithm details.
  return (
    cmpString(a.jellyFilePath, b.jellyFilePath) ||
    cmpNumber(a.startOffset, b.startOffset) ||
    cmpNumber(a.endOffset, b.endOffset) ||
    cmpString(a.nodeId, b.nodeId) ||
    cmpString(a.level, b.level) ||
    cmpString(a.message, b.message)
  );
}

function formatNodeLabel(n: JellyFunctionNode): string {
  const name = n.name ? ` name=${JSON.stringify(n.name)}` : "";
  return `nodeId=${JSON.stringify(n.id)}${name} filePath=${JSON.stringify(n.filePath)} span=${n.startOffset}..${n.endOffset}`;
}

export function mapJellyFunctionNodesToFuncIds(
  jelly: NormalizedJellyCallGraph,
  functionIndex: FunctionIndex,
  opts: MapJellyFunctionNodesToFuncIdsOptions = {},
): JellyFuncNodeMappingResult {
  const mode: JellyFuncNodeMappingMode = opts.mode ?? "strict";

  const resolverCtx = buildFilePathResolverCtx(functionIndex);
  const functionsByFilePath = buildFunctionsByFilePath(functionIndex);

  const nodeIdToFuncId = new Map<string, FuncId>();
  const diagnostics: JellyFuncNodeMappingDiagnostic[] = [];

  for (const n of jelly.nodes) {
    const resolved = resolveFilePath(resolverCtx, n.filePath, mode);
    if (resolved.kind === "ambiguous") {
      diagnostics.push({
        level: "error",
        nodeId: n.id,
        nodeName: n.name,
        jellyFilePath: n.filePath,
        resolvedFilePath: null,
        startOffset: n.startOffset,
        endOffset: n.endOffset,
        message: `${resolved.message} candidates=${JSON.stringify(resolved.candidates)}`,
      });
      continue;
    }

    if (resolved.kind === "missing") {
      diagnostics.push({
        level: "error",
        nodeId: n.id,
        nodeName: n.name,
        jellyFilePath: n.filePath,
        resolvedFilePath: null,
        startOffset: n.startOffset,
        endOffset: n.endOffset,
        message: resolved.message,
      });
      continue;
    }

    if (resolved.warn) {
      diagnostics.push({
        level: "warn",
        nodeId: n.id,
        nodeName: n.name,
        jellyFilePath: n.filePath,
        resolvedFilePath: resolved.filePath,
        startOffset: n.startOffset,
        endOffset: n.endOffset,
        message: resolved.warn,
      });
    }

    const f = functionIndex.getBySpan(resolved.filePath, n.startOffset, n.endOffset);
    if (!f) {
      diagnostics.push({
        level: "error",
        nodeId: n.id,
        nodeName: n.name,
        jellyFilePath: n.filePath,
        resolvedFilePath: resolved.filePath,
        startOffset: n.startOffset,
        endOffset: n.endOffset,
        message: `No indexed function matches Jelly span in resolved file. ${fmtNearestFunctions(
          functionsByFilePath,
          resolved.filePath,
          n.startOffset,
          n.endOffset,
        )}`,
      });
      continue;
    }

    nodeIdToFuncId.set(n.id, f.id);
  }

  // De-dupe diagnostics deterministically (multiple normalization paths can generate identical lines).
  const unique = new Map<string, JellyFuncNodeMappingDiagnostic>();
  for (const d of diagnostics) unique.set(diagKey(d), d);
  const deduped = stableSort(Array.from(unique.values()), cmpDiagnostic);

  const errorCount = deduped.filter((d) => d.level === "error").length;
  if (mode === "strict" && errorCount > 0) {
    const lines: string[] = [];
    lines.push(
      `Jelly function node mapping failed in strict mode: ${errorCount} error(s) while mapping ${jelly.nodes.length} node(s)`,
    );
    for (const d of deduped) {
      if (d.level !== "error") continue;
      const label = formatNodeLabel({
        id: d.nodeId,
        name: d.nodeName,
        filePath: d.jellyFilePath,
        startOffset: d.startOffset,
        endOffset: d.endOffset,
      });
      lines.push(`- ${label}: ${d.message}`);
    }
    throw new Error(lines.join("\n"));
  }

  return { nodeIdToFuncId, diagnostics: deduped };
}

