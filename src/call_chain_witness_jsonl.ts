import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { canonicalJsonStringify, stableSort } from "./determinism.ts";
import { cmpCallsiteId, cmpFuncId } from "./ids.ts";
import type { CallsiteId, FuncId } from "./ids.ts";
import type { MappedCallEdge } from "./mapped_callgraph.ts";

export const CALL_CHAIN_WITNESS_SCHEMA_VERSION = 1 as const;

export type CallChainWitnessSchemaVersion = typeof CALL_CHAIN_WITNESS_SCHEMA_VERSION;

export type CallChainWitnessStep = Readonly<{
  callerFuncId: FuncId;
  callsiteId: CallsiteId;
  calleeFuncId: FuncId;
}>;

export type CallChainWitness = Readonly<{
  schemaVersion: CallChainWitnessSchemaVersion;
  kind: "call_chain";
  steps: readonly CallChainWitnessStep[];
}>;

function cmpCallChainWitnessStep(a: CallChainWitnessStep, b: CallChainWitnessStep): number {
  return (
    cmpFuncId(a.callerFuncId, b.callerFuncId) ||
    cmpFuncId(a.calleeFuncId, b.calleeFuncId) ||
    cmpCallsiteId(a.callsiteId, b.callsiteId)
  );
}

function callChainWitnessKey(w: CallChainWitness): string {
  // NUL-delimited so keys can't collide.
  return w.steps.map((s) => `${s.callerFuncId}\0${s.calleeFuncId}\0${s.callsiteId}`).join("\0\0");
}

function cmpCallChainWitness(a: CallChainWitness, b: CallChainWitness): number {
  const n = Math.min(a.steps.length, b.steps.length);
  for (let i = 0; i < n; i++) {
    const c = cmpCallChainWitnessStep(a.steps[i]!, b.steps[i]!);
    if (c !== 0) return c;
  }
  return a.steps.length - b.steps.length;
}

export function serializeCallChainWitnessesJsonlFromEdges(edges: readonly MappedCallEdge[]): string {
  if (edges.length === 0) return "";

  const witnesses = edges.map((e) => ({
    schemaVersion: CALL_CHAIN_WITNESS_SCHEMA_VERSION,
    kind: "call_chain" as const,
    steps: [{ callerFuncId: e.callerFuncId, callsiteId: e.callsiteId, calleeFuncId: e.calleeFuncId }],
  }));

  const uniqueByKey = new Map<string, CallChainWitness>();
  for (const w of witnesses) uniqueByKey.set(callChainWitnessKey(w), w);

  const sorted = stableSort([...uniqueByKey.values()], cmpCallChainWitness);
  const lines = sorted.map((w) => canonicalJsonStringify(w));
  return `${lines.join("\n")}\n`;
}

export function writeCallChainWitnessesJsonlFile(outPath: string, edges: readonly MappedCallEdge[]): void {
  writeFileSync(resolve(outPath), serializeCallChainWitnessesJsonlFromEdges(edges), "utf8");
}

