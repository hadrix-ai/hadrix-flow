import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { stableSort } from "./determinism.ts";
import { cmpFlowFact, flowFactKey, normalizeFlowFact, serializeNormalizedFlowFact } from "./flow_fact.ts";
import type { NormalizedFlowFact } from "./flow_fact.ts";

export function normalizeFlowFacts(value: readonly unknown[]): NormalizedFlowFact[] {
  const facts: NormalizedFlowFact[] = [];
  for (let i = 0; i < value.length; i++) facts.push(normalizeFlowFact(value[i]));

  const uniqueByKey = new Map<string, NormalizedFlowFact>();
  for (const f of facts) uniqueByKey.set(flowFactKey(f), f);

  return stableSort([...uniqueByKey.values()], cmpFlowFact);
}

export function serializeFlowFactsJsonl(value: readonly unknown[]): string {
  const facts = normalizeFlowFacts(value);
  if (facts.length === 0) return "";

  const lines = facts.map((f) => serializeNormalizedFlowFact(f));
  return `${lines.join("\n")}\n`;
}

export function writeFlowFactsJsonlFile(outPath: string, value: readonly unknown[]): void {
  writeFileSync(resolve(outPath), serializeFlowFactsJsonl(value), "utf8");
}

