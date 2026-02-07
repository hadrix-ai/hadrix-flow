#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { buildCallsiteIndex } from "./callsite_indexer.ts";
import { writeCallChainWitnessesJsonlFile } from "./call_chain_witness_jsonl.ts";
import { writeExplainBundlesDir } from "./explain_bundle.ts";
import { buildFunctionIndexFromProject } from "./function_indexer.ts";
import { writeFlowFactsJsonlFile } from "./flow_fact_jsonl.ts";
import type { FuncId } from "./ids.ts";
import { getOrComputeFuncSummaryCheapPassOnly } from "./intra_proc_summary_pipeline.ts";
import { loadJellyCallGraphFromFile } from "./jelly_callgraph.ts";
import { mapJellyCallEdgesToCallsiteIds } from "./jelly_callsite_mapping.ts";
import { mapJellyFunctionNodesToFuncIds } from "./jelly_func_mapping.ts";
import { runInterprocPropagationV2 } from "./interproc_propagation.ts";
import { buildFuncIrV3 } from "./ir_builder.ts";
import { normalizeMappedCallGraph } from "./mapped_callgraph.ts";
import { buildStatementIndex } from "./statement_indexer.ts";
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
    `Hadrix Flow v${version}`,
    "Deterministic JS/TS flow-fact generator (infrastructure, not a vulnerability scanner).",
    "",
    "Usage:",
    "  hadrix-flow analyze (--repo <path> | --tsconfig <file>) --jelly <file> --out <facts.jsonl> [--witness <witness.jsonl>] [--explain <dir>]",
    "",
    "Commands:",
    "  analyze    Generate flow facts",
    "",
    "Options:",
    "  -h, --help     Show help",
    "      --version  Show version",
    "      --witness  Write function-level call-chain witnesses (JSONL)",
    "      --explain  Write per-function explain bundles (IR + edges + validation notes)",
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
    if (!args.jelly) {
      process.stderr.write("hadrix-flow analyze: missing required --jelly <file>\n");
      return 1;
    }

    const outAbsPath = resolve(args.out);
    const cacheRootDir = join(dirname(outAbsPath), ".hadrix-flow-cache");

    const project = loadTsProject({ repo: args.repo, tsconfig: args.tsconfig });
    const functionIndex = buildFunctionIndexFromProject(project);
    const statementIndex = buildStatementIndex(functionIndex);
    const callsiteIndex = buildCallsiteIndex(statementIndex);

    const jelly = loadJellyCallGraphFromFile(resolve(args.jelly));
    const { nodeIdToFuncId } = mapJellyFunctionNodesToFuncIds(jelly, functionIndex, { mode: "strict" });
    const { callsiteIdByEdgeIndex } = mapJellyCallEdgesToCallsiteIds(jelly, callsiteIndex, {
      mode: "strict",
      nodeIdToFuncId,
    });

    const nodes: FuncId[] = Array.from(new Set(nodeIdToFuncId.values()));
    const edges = jelly.edges.flatMap((e, i) => {
      const callsiteId = callsiteIdByEdgeIndex[i];
      if (!callsiteId) return [];
      const callerFuncId = nodeIdToFuncId.get(e.callerId);
      const calleeFuncId = nodeIdToFuncId.get(e.calleeId);
      if (!callerFuncId || !calleeFuncId) return [];
      return [{ callerFuncId, calleeFuncId, callsiteId }];
    });

    const graph = normalizeMappedCallGraph({ nodes, edges });

    const irByFuncId = new Map<FuncId, ReturnType<typeof buildFuncIrV3>>();
    const summaryByFuncId = new Map<FuncId, ReturnType<typeof getOrComputeFuncSummaryCheapPassOnly>["summary"]>();
    const explainInputs: Array<{
      readonly funcId: FuncId;
      readonly normalizedIrHash: string;
      readonly ir: ReturnType<typeof buildFuncIrV3>;
      readonly summary: ReturnType<typeof getOrComputeFuncSummaryCheapPassOnly>["summary"];
    }> = [];

    for (const funcId of graph.nodes) {
      const func = functionIndex.getById(funcId);
      if (!func) throw new Error(`Missing indexed function for call graph node: ${funcId}`);
      const statements = statementIndex.getByFuncId(funcId);
      if (!statements) throw new Error(`Missing indexed statements for call graph node: ${funcId}`);

      const ir = buildFuncIrV3(func, statements);
      irByFuncId.set(funcId, ir);

      const { summary, normalizedIrHash } = getOrComputeFuncSummaryCheapPassOnly(ir, { cacheRootDir });
      summaryByFuncId.set(funcId, summary);
      if (args.explain) explainInputs.push({ funcId, normalizedIrHash, ir, summary });
    }

    const { facts } = runInterprocPropagationV2({ graph, irByFuncId, summaryByFuncId });
    writeFlowFactsJsonlFile(outAbsPath, facts);
    if (args.witness) writeCallChainWitnessesJsonlFile(resolve(args.witness), graph.edges);
    if (args.explain) writeExplainBundlesDir(resolve(args.explain), explainInputs);
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`hadrix-flow analyze: ${msg}\n`);
    return 1;
  }
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
