import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadTsProject } from "../src/ts_project.ts";

const testDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(testDir, "..");

test("loadTsProject: normalizes to repo-relative POSIX source paths in stable order", () => {
  const fixtureDir = join(projectRoot, "test", "fixtures", "basic");
  const tsconfigPath = join(fixtureDir, "tsconfig.json");

  const project = loadTsProject({ tsconfig: tsconfigPath });

  assert.equal(project.repoRoot, realpathSync(fixtureDir));
  assert.equal(project.tsconfigPath, realpathSync(tsconfigPath));
  assert.deepEqual(project.sourceFilePaths, ["src/a.ts", "src/b.ts", "src/index.ts"]);
  assert.equal(project.sourceFiles.length, project.sourceFilePaths.length);
});

test("loadTsProject: resolves --tsconfig relative to --repo", () => {
  const fixtureDir = join(projectRoot, "test", "fixtures", "basic");

  const project = loadTsProject({ repo: fixtureDir, tsconfig: "tsconfig.json" });
  assert.deepEqual(project.sourceFilePaths, ["src/a.ts", "src/b.ts", "src/index.ts"]);
});

