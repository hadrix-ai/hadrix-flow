#!/usr/bin/env node
import { readFileSync } from "node:fs";

function getVersion(): string {
  try {
    const pkgUrl = new URL("../package.json", import.meta.url);
    const raw = readFileSync(pkgUrl, "utf8");
    const pkg = JSON.parse(raw);
    if (pkg && typeof pkg.version === "string") return pkg.version;
  } catch {
    // Best-effort; version is not critical for the stub.
  }
  return "0.0.0";
}

function helpText(version: string): string {
  return [
    `Hadrix Flow v${version} (CLI stub)`,
    "Deterministic JS/TS flow-fact generator (infrastructure, not a vulnerability scanner).",
    "",
    "Usage:",
    "  hadrix-flow analyze --repo <path> --jelly <file> --out <facts.jsonl> [--witness <witness.jsonl>] [--explain <dir>]",
    "",
    "Commands:",
    "  analyze    Generate flow facts (not implemented yet)",
    "",
    "Options:",
    "  -h, --help     Show help",
    "      --version  Show version",
    "",
  ].join("\n");
}

function main(argv: string[]): number {
  const version = getVersion();

  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(helpText(version));
    return 0;
  }

  if (argv.includes("--version")) {
    process.stdout.write(`${version}\n`);
    return 0;
  }

  const [command] = argv;
  if (command === "analyze") {
    process.stderr.write("hadrix-flow analyze: not implemented yet (CLI stub)\n");
    return 1;
  }

  process.stderr.write(`Unknown command: ${command}\n\n`);
  process.stdout.write(helpText(version));
  return 1;
}

process.exitCode = main(process.argv.slice(2));

