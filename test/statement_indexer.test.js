import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import { buildFunctionIndex } from "../src/function_indexer.ts";
import { buildStatementIndex, buildStatementIndexFromProject } from "../src/statement_indexer.ts";
import { cmpStmtId, createStmtId } from "../src/ids.ts";
import { loadTsProject } from "../src/ts_project.ts";

const testDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(testDir, "..");

function isStrictlySortedStmtIds(ids) {
  for (let i = 1; i < ids.length; i++) {
    if (!(cmpStmtId(ids[i - 1], ids[i]) < 0)) return false;
  }
  return true;
}

test("buildStatementIndexFromProject: indexes statement sites and provides stable StmtIds + lookups", () => {
  const fixtureDir = join(projectRoot, "test", "fixtures", "basic");
  const tsconfigPath = join(fixtureDir, "tsconfig.json");

  const project = loadTsProject({ tsconfig: tsconfigPath });
  const idx = buildStatementIndexFromProject(project);

  // Per-function entries align 1:1 with the function index.
  assert.equal(idx.perFunction.length > 0, true);
  assert.equal(idx.perFunction.length, new Set(idx.perFunction.map((e) => e.func.id)).size);

  // Global list is strictly sorted by StmtId by construction.
  assert.equal(isStrictlySortedStmtIds(idx.statements.map((s) => s.id)), true);

  for (const { func, statements } of idx.perFunction) {
    assert.equal(idx.getByFuncId(func.id), statements);
    for (let i = 0; i < statements.length; i++) {
      const st = statements[i];
      assert.equal(st.funcId, func.id);
      assert.equal(st.statementIndex, i);
      assert.equal(st.id, createStmtId(func.id, i));
      assert.equal(idx.getById(st.id), st);
    }
  }

  const findFunctionBySnippet = (needle) =>
    idx.perFunction.find(({ func }) => func.sourceFile.text.slice(func.startOffset, func.endOffset).includes(needle));

  const pipeline = findFunctionBySnippet("function pipeline");
  assert.ok(pipeline);
  assert.equal(
    pipeline.statements.some(
      (s) => s.node.kind === ts.SyntaxKind.CallExpression && s.sourceFile.text.slice(s.startOffset, s.endOffset) === "wrap(input)",
    ),
    true,
  );

  const constructorFn = findFunctionBySnippet("constructor(value: string)");
  assert.ok(constructorFn);
  assert.equal(
    constructorFn.statements.some(
      (s) =>
        s.node.kind === ts.SyntaxKind.ExpressionStatement &&
        s.sourceFile.text.slice(s.startOffset, s.endOffset).trim() === "this.value = value;",
    ),
    true,
  );
});

test("buildStatementIndex: expression-bodied arrow functions index the body expression root", () => {
  const text = [
    "declare function foo(x: number): number;",
    "const add1 = (y: number) => y + 1;",
    "const call = (z: number) => foo(z);",
    "",
  ].join("\n");

  const sourceFile = ts.createSourceFile("mem.ts", text, ts.ScriptTarget.Latest, /*setParentNodes*/ true, ts.ScriptKind.TS);
  const fnIdx = buildFunctionIndex({ sourceFilePaths: ["src/mem.ts"], sourceFiles: [sourceFile] });
  const stIdx = buildStatementIndex(fnIdx);

  const add1 = stIdx.perFunction.find(({ func }) =>
    func.sourceFile.text.slice(func.startOffset, func.endOffset).includes("(y: number) => y + 1"),
  );
  assert.ok(add1);
  assert.equal(add1.statements.length >= 1, true);
  assert.equal(add1.statements[0].sourceFile.text.slice(add1.statements[0].startOffset, add1.statements[0].endOffset), "y + 1");

  const call = stIdx.perFunction.find(({ func }) =>
    func.sourceFile.text.slice(func.startOffset, func.endOffset).includes("(z: number) => foo(z)"),
  );
  assert.ok(call);
  assert.equal(call.statements.some((s) => s.node.kind === ts.SyntaxKind.CallExpression), true);
});
