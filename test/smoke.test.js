import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(testDir, "..");
const cliPath = join(projectRoot, "src", "cli.ts");

function runCli(args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env },
  });
}

test("hadrix-flow --help prints usage and exits 0", () => {
  const pkg = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));

  const res = runCli(["--help"]);
  assert.equal(res.status, 0);
  assert.equal(res.signal, null);
  assert.equal(res.stderr, "");

  const [firstLine] = res.stdout.split("\n");
  assert.equal(firstLine, `Hadrix Flow v${pkg.version} (CLI stub)`);
  assert.match(res.stdout, /Usage:\n\s+hadrix-flow analyze\b/);
});

test("hadrix-flow analyze loads a TS program and writes an empty facts JSONL file", () => {
  const fixtureDir = join(projectRoot, "test", "fixtures", "basic");
  const tsconfigPath = join(fixtureDir, "tsconfig.json");

  const dir = mkdtempSync(join(tmpdir(), "hadrix-flow-"));
  try {
    const outPath = join(dir, "facts.jsonl");
    const res = runCli(["analyze", "--tsconfig", tsconfigPath, "--out", outPath]);
    assert.equal(res.status, 0);
    assert.equal(res.signal, null);
    assert.equal(res.stderr, "");

    const out = readFileSync(outPath, "utf8");
    assert.equal(out, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
