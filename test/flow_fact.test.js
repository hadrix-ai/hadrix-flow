import assert from "node:assert/strict";
import test from "node:test";

import { normalizeFlowFact } from "../src/flow_fact.ts";
import { serializeFlowFactsJsonl } from "../src/flow_fact_jsonl.ts";
import { createFuncId, createParamVarId, createStmtId } from "../src/ids.ts";

test("serializeFlowFactsJsonl sorts, dedupes, and uses canonical JSON", () => {
  const funcId = createFuncId("src/a.ts", 0, 1);
  const callsiteId = createStmtId(funcId, 0);
  const p0 = createParamVarId(0);

  const fReturn = {
    // Intentionally out-of-order keys to ensure canonical serialization.
    to: { kind: "return", funcId },
    schemaVersion: 1,
    from: { id: p0, kind: "var", funcId },
  };

  const fCallArg = {
    schemaVersion: 1,
    from: { kind: "var", funcId, id: p0 },
    to: { index: 0, kind: "call_arg", callsiteId },
  };

  // Return is sorted after call_arg for the same `from` node, and duplicates are removed.
  const out = serializeFlowFactsJsonl([fReturn, fCallArg, fCallArg]);

  assert.equal(
    out,
    [
      '{"from":{"funcId":"f:src%2Fa.ts:0:1","id":"p0","kind":"var"},"schemaVersion":1,"to":{"callsiteId":"s:src%2Fa.ts:0:1:0","index":0,"kind":"call_arg"}}',
      '{"from":{"funcId":"f:src%2Fa.ts:0:1","id":"p0","kind":"var"},"schemaVersion":1,"to":{"funcId":"f:src%2Fa.ts:0:1","kind":"return"}}',
      "",
    ].join("\n"),
  );

  assert.equal(serializeFlowFactsJsonl([]), "");
});

test("normalizeFlowFact rejects unknown keys", () => {
  const funcId = createFuncId("src/a.ts", 0, 1);
  const p0 = createParamVarId(0);

  assert.throws(
    () =>
      normalizeFlowFact({
        schemaVersion: 1,
        from: { kind: "var", funcId, id: p0 },
        to: { kind: "return", funcId },
        extra: "nope",
      }),
    /unknown key/i,
  );
});

