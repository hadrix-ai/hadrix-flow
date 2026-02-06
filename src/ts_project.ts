import { realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import ts from "typescript";

import { cmpString, stableSort } from "./determinism.ts";

export type TsProject = Readonly<{
  repoRoot: string;
  tsconfigPath: string;
  program: ts.Program;
  // Repo-relative, POSIX-separated file paths in stable order.
  sourceFilePaths: readonly string[];
  // Source files aligned with sourceFilePaths ordering.
  sourceFiles: readonly ts.SourceFile[];
}>;

export type TsProjectLoadArgs = Readonly<{
  repo?: string;
  tsconfig?: string;
}>;

function toPosixPath(p: string): string {
  return p.replaceAll("\\", "/");
}

function isOutsideRepo(relPosixPath: string): boolean {
  return relPosixPath === ".." || relPosixPath.startsWith("../");
}

function hasPathSegment(relPosixPath: string, segment: string): boolean {
  // `split("/")` is safe because we force POSIX separators at all call sites.
  return relPosixPath.split("/").includes(segment);
}

function mustExistAsFile(p: string, label: string): void {
  let st;
  try {
    st = statSync(p);
  } catch {
    throw new Error(`${label} does not exist: ${JSON.stringify(p)}`);
  }
  if (!st.isFile()) throw new Error(`${label} is not a file: ${JSON.stringify(p)}`);
}

function mustExistAsDirectory(p: string, label: string): void {
  let st;
  try {
    st = statSync(p);
  } catch {
    throw new Error(`${label} does not exist: ${JSON.stringify(p)}`);
  }
  if (!st.isDirectory()) throw new Error(`${label} is not a directory: ${JSON.stringify(p)}`);
}

function tryRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function canonicalizeRepoRoot(repoPath: string): string {
  const abs = resolve(repoPath);
  mustExistAsDirectory(abs, "--repo");
  return tryRealpath(abs);
}

function canonicalizeTsconfigPath(tsconfigPath: string): string {
  const abs = resolve(tsconfigPath);
  mustExistAsFile(abs, "--tsconfig");
  return tryRealpath(abs);
}

function isSupportedTsJsSourcePath(relPosixPath: string): boolean {
  // Exclude declaration files and non-JS/TS inputs (like JSON) from the analysis source set.
  const lower = relPosixPath.toLowerCase();
  if (lower.endsWith(".d.ts") || lower.endsWith(".d.mts") || lower.endsWith(".d.cts")) return false;
  return (
    lower.endsWith(".ts") ||
    lower.endsWith(".tsx") ||
    lower.endsWith(".js") ||
    lower.endsWith(".jsx") ||
    lower.endsWith(".mts") ||
    lower.endsWith(".cts") ||
    lower.endsWith(".mjs") ||
    lower.endsWith(".cjs")
  );
}

function normalizeAbsPathToRepoRelPosix(repoRoot: string, absPath: string): string {
  // Avoid `--repo` symlink vs TS canonical path mismatch by realpathing both sides.
  const abs = tryRealpath(absPath);
  const rel = relative(repoRoot, abs);
  const relPosix = toPosixPath(rel);
  if (relPosix.length === 0 || relPosix === ".") {
    throw new Error(`Unexpected source file path equal to repo root: ${JSON.stringify(abs)}`);
  }
  if (isOutsideRepo(relPosix)) {
    throw new Error(
      `Source file is outside repo root; pass a different --repo or --tsconfig: file=${JSON.stringify(abs)} repoRoot=${JSON.stringify(repoRoot)}`,
    );
  }
  return relPosix;
}

export function loadTsProject(args: TsProjectLoadArgs): TsProject {
  const repoRoot = args.repo ? canonicalizeRepoRoot(args.repo) : undefined;

  const tsconfigPath = args.tsconfig
    ? canonicalizeTsconfigPath(repoRoot && !isAbsolute(args.tsconfig) ? resolve(repoRoot, args.tsconfig) : args.tsconfig)
    : repoRoot
      ? canonicalizeTsconfigPath(resolve(repoRoot, "tsconfig.json"))
      : undefined;

  if (!tsconfigPath) {
    throw new Error("Expected --repo <path> and/or --tsconfig <file>");
  }

  const effectiveRepoRoot = repoRoot ?? tryRealpath(dirname(tsconfigPath));
  mustExistAsDirectory(effectiveRepoRoot, "repo root");

  const diagHost: ts.FormatDiagnosticsHost = {
    getCanonicalFileName: (p) => p,
    getCurrentDirectory: ts.sys.getCurrentDirectory,
    getNewLine: () => ts.sys.newLine,
  };

  const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(ts.formatDiagnostics([configFile.error], diagHost));
  }

  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    dirname(tsconfigPath),
    undefined,
    tsconfigPath,
  );
  if (parsed.errors.length > 0) {
    throw new Error(ts.formatDiagnostics(parsed.errors, diagHost));
  }

  // Use the classic signature for broad compatibility across TS versions.
  const program = ts.createProgram(parsed.fileNames, parsed.options, undefined, undefined, undefined, parsed.projectReferences);

  const entries: Array<{ readonly relPath: string; readonly sf: ts.SourceFile }> = [];
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;

    const relPath = normalizeAbsPathToRepoRelPosix(effectiveRepoRoot, sf.fileName);
    if (!isSupportedTsJsSourcePath(relPath)) continue;

    // Avoid analyzing vendored dependencies by default.
    if (hasPathSegment(relPath, "node_modules")) continue;

    entries.push({ relPath, sf });
  }

  const sorted = stableSort(entries, (a, b) => cmpString(a.relPath, b.relPath));

  const sourceFilePaths: string[] = [];
  const sourceFiles: ts.SourceFile[] = [];
  const seen = new Set<string>();
  for (const e of sorted) {
    if (seen.has(e.relPath)) {
      throw new Error(`Duplicate source file path after normalization: ${JSON.stringify(e.relPath)}`);
    }
    seen.add(e.relPath);
    sourceFilePaths.push(e.relPath);
    sourceFiles.push(e.sf);
  }

  return {
    repoRoot: effectiveRepoRoot,
    tsconfigPath,
    program,
    sourceFilePaths,
    sourceFiles,
  };
}

