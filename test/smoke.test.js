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
  assert.equal(firstLine, `Hadrix Flow v${pkg.version}`);
  assert.match(res.stdout, /Usage:\n\s+hadrix-flow analyze\b/);
});

test("hadrix-flow analyze wires TS + Jelly + propagation and writes flow facts JSONL", () => {
  const fixtureDir = join(projectRoot, "test", "fixtures", "basic");
  const jellyPath = join(fixtureDir, "jelly_callgraph.json");

  const dir = mkdtempSync(join(tmpdir(), "hadrix-flow-"));
  try {
    const outPath = join(dir, "facts.jsonl");
    const witnessPath = join(dir, "witness.jsonl");
    const res = runCli([
      "analyze",
      "--repo",
      fixtureDir,
      "--jelly",
      jellyPath,
      "--out",
      outPath,
      "--witness",
      witnessPath,
    ]);
    assert.equal(res.status, 0);
    assert.equal(res.signal, null);
    assert.equal(res.stderr, "");

    const out = readFileSync(outPath, "utf8");
    assert.notEqual(out, "");
    // Basic JSONL sanity: parse each line as JSON.
    for (const line of out.split("\n")) {
      if (line.length === 0) continue;
      assert.doesNotThrow(() => JSON.parse(line));
    }

    const witness = readFileSync(witnessPath, "utf8");
    assert.notEqual(witness, "");
    for (const line of witness.split("\n")) {
      if (line.length === 0) continue;
      const obj = JSON.parse(line);
      assert.equal(obj.schemaVersion, 1);
      assert.equal(obj.kind, "call_chain");
      assert.ok(Array.isArray(obj.steps));
      assert.equal(obj.steps.length, 1);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hadrix-flow analyze is byte-identical across runs (warm cache)", () => {
  const fixtureDir = join(projectRoot, "test", "fixtures", "basic");
  const jellyPath = join(fixtureDir, "jelly_callgraph.json");

  const dir = mkdtempSync(join(tmpdir(), "hadrix-flow-"));
  try {
    const outPath = join(dir, "facts.jsonl");
    const witnessPath = join(dir, "witness.jsonl");

    const res1 = runCli([
      "analyze",
      "--repo",
      fixtureDir,
      "--jelly",
      jellyPath,
      "--out",
      outPath,
      "--witness",
      witnessPath,
    ]);
    assert.equal(res1.status, 0);
    assert.equal(res1.signal, null);
    assert.equal(res1.stderr, "");

    const out1 = readFileSync(outPath);
    assert.notEqual(out1.byteLength, 0);

    const wit1 = readFileSync(witnessPath);
    assert.notEqual(wit1.byteLength, 0);

    const res2 = runCli([
      "analyze",
      "--repo",
      fixtureDir,
      "--jelly",
      jellyPath,
      "--out",
      outPath,
      "--witness",
      witnessPath,
    ]);
    assert.equal(res2.status, 0);
    assert.equal(res2.signal, null);
    assert.equal(res2.stderr, "");

    const out2 = readFileSync(outPath);
    assert.equal(Buffer.compare(out1, out2), 0);

    const wit2 = readFileSync(witnessPath);
    assert.equal(Buffer.compare(wit1, wit2), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
