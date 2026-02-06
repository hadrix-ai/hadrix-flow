import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
