import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import { buildFunctionIndex, buildFunctionIndexFromProject } from "../src/function_indexer.ts";
import { cmpFuncId, createFuncId } from "../src/ids.ts";
import { loadTsProject } from "../src/ts_project.ts";

const testDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(testDir, "..");

function isStrictlySortedFuncIds(ids) {
  for (let i = 1; i < ids.length; i++) {
    if (!(cmpFuncId(ids[i - 1], ids[i]) < 0)) return false;
  }
  return true;
}

test("buildFunctionIndexFromProject: indexes function-like nodes in fixture and supports span lookup", () => {
  const fixtureDir = join(projectRoot, "test", "fixtures", "basic");
  const tsconfigPath = join(fixtureDir, "tsconfig.json");

  const project = loadTsProject({ tsconfig: tsconfigPath });
  const idx = buildFunctionIndexFromProject(project);

  // a.ts (4) + b.ts (11) + index.ts (1) = 16
  assert.equal(idx.functions.length, 16);

  assert.equal(
    isStrictlySortedFuncIds(idx.functions.map((f) => f.id)),
    true,
  );

  for (const f of idx.functions) {
    assert.equal(f.id, createFuncId(f.filePath, f.startOffset, f.endOffset));
    assert.equal(idx.getById(f.id), f);
    assert.equal(idx.getBySpan(f.filePath, f.startOffset, f.endOffset), f);
  }

  const hasSnippet = (filePath, needle) =>
    idx.functions.some(
      (f) => f.filePath === filePath && f.sourceFile.text.slice(f.startOffset, f.endOffset).includes(needle),
    );

  assert.equal(hasSnippet("src/a.ts", "function id"), true);
  assert.equal(hasSnippet("src/b.ts", "function pipeline"), true);
  assert.equal(hasSnippet("src/b.ts", "constructor(value: string)"), true);
  assert.equal(hasSnippet("src/b.ts", "get(): string"), true);
  assert.equal(hasSnippet("src/b.ts", "set(v: string): void"), true);
  assert.equal(hasSnippet("src/index.ts", "function main"), true);

  assert.equal(idx.getBySpan("src/b.ts", 0, 1), undefined);
});

test("buildFunctionIndex: includes arrow/function-expression/class members; skips declarations without bodies", () => {
  const text = [
    "export function f(x: number) { return x; }",
    "const g = (y: number) => y + 1;",
    "const h = function (z: number) { return z * 2; };",
    "",
    "interface I { m(x: number): number; }",
    "declare function d(x: string): string;",
    "abstract class A { abstract am(x: number): number; }",
    "",
    "class C {",
    "  constructor() {}",
    "  m(x: number) { return x; }",
    "  get p() { return 1; }",
    "  set p(v: number) { void v; }",
    "}",
    "",
  ].join("\n");

  const sourceFile = ts.createSourceFile("mem.ts", text, ts.ScriptTarget.Latest, /*setParentNodes*/ true, ts.ScriptKind.TS);
  const idx = buildFunctionIndex({ sourceFilePaths: ["src/mem.ts"], sourceFiles: [sourceFile] });

  // f, g, h, C.constructor, C.m, C.get, C.set
  assert.equal(idx.functions.length, 7);

  assert.equal(
    isStrictlySortedFuncIds(idx.functions.map((f) => f.id)),
    true,
  );

  const snippets = idx.functions.map((f) => f.sourceFile.text.slice(f.startOffset, f.endOffset));
  assert.equal(snippets.some((s) => s.includes("=>")), true);
  assert.equal(snippets.some((s) => s.includes("function (z")), true);
  assert.equal(snippets.some((s) => s.includes("constructor()")), true);
  assert.equal(snippets.some((s) => s.includes("get p()")), true);
  assert.equal(snippets.some((s) => s.includes("set p(v: number)")), true);

  for (const f of idx.functions) {
    assert.equal(f.id, createFuncId(f.filePath, f.startOffset, f.endOffset));
    assert.equal(idx.getBySpan(f.filePath, f.startOffset, f.endOffset), f);
  }
});
