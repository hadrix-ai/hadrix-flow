#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { loadTsProject } from "./ts_project.ts";

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
    "  hadrix-flow analyze (--repo <path> | --tsconfig <file>) --out <facts.jsonl> [--jelly <file>] [--witness <witness.jsonl>] [--explain <dir>]",
    "",
    "Commands:",
    "  analyze    Generate flow facts (skeleton; emits empty facts for now)",
    "",
    "Options:",
    "  -h, --help     Show help",
    "      --version  Show version",
    "",
  ].join("\n");
}

type AnalyzeArgs = Readonly<{
  repo?: string;
  tsconfig?: string;
  jelly?: string;
  out?: string;
  witness?: string;
  explain?: string;
  help: boolean;
}>;

function parseAnalyzeArgs(argv: string[]): AnalyzeArgs {
  const args: {
    repo?: string;
    tsconfig?: string;
    jelly?: string;
    out?: string;
    witness?: string;
    explain?: string;
    help: boolean;
  } = { help: false };

  const takeValue = (flag: string, i: number): string => {
    const v = argv[i + 1];
    if (typeof v !== "string" || v.startsWith("-")) {
      throw new Error(`${flag} requires a value`);
    }
    return v;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h") {
      args.help = true;
      continue;
    }

    if (a === "--repo") {
      args.repo = takeValue(a, i);
      i++;
      continue;
    }
    if (a === "--tsconfig") {
      args.tsconfig = takeValue(a, i);
      i++;
      continue;
    }
    if (a === "--jelly") {
      args.jelly = takeValue(a, i);
      i++;
      continue;
    }
    if (a === "--out") {
      args.out = takeValue(a, i);
      i++;
      continue;
    }
    if (a === "--witness") {
      args.witness = takeValue(a, i);
      i++;
      continue;
    }
    if (a === "--explain") {
      args.explain = takeValue(a, i);
      i++;
      continue;
    }

    throw new Error(`Unknown option: ${a}`);
  }

  return args;
}

function cmdAnalyze(argv: string[], version: string): number {
  let args: AnalyzeArgs;
  try {
    args = parseAnalyzeArgs(argv);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`hadrix-flow analyze: ${msg}\n\n`);
    process.stdout.write(helpText(version));
    return 1;
  }

  if (args.help) {
    process.stdout.write(helpText(version));
    return 0;
  }

  if (!args.out) {
    process.stderr.write("hadrix-flow analyze: missing required --out <facts.jsonl>\n");
    return 1;
  }

  if (!args.repo && !args.tsconfig) {
    process.stderr.write("hadrix-flow analyze: expected --repo <path> or --tsconfig <file>\n");
    return 1;
  }

  try {
    const project = loadTsProject({ repo: args.repo, tsconfig: args.tsconfig });
    const program = project.program;
    // Force the program to realize sources and types.
    void program.getSourceFiles();
    void program.getTypeChecker();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`hadrix-flow analyze: failed to load TS project\n${msg}\n`);
    return 1;
  }

  // Placeholder: write an empty JSONL file (no facts) deterministically.
  writeFileSync(resolve(args.out), "", "utf8");
  return 0;
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
    return cmdAnalyze(argv.slice(1), version);
  }

  process.stderr.write(`Unknown command: ${command}\n\n`);
  process.stdout.write(helpText(version));
  return 1;
}

process.exitCode = main(process.argv.slice(2));
