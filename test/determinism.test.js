import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalJsonStringify,
  cmpArrayLex,
  cmpBoolean,
  cmpNumber,
  cmpString,
  hashCanonicalJson,
  sha256HexFromUtf8,
  stableSort,
} from "../src/determinism.ts";

test("cmp helpers order values", () => {
  assert.equal(cmpString("a", "b"), -1);
  assert.equal(cmpString("b", "a"), 1);
  assert.equal(cmpString("a", "a"), 0);

  assert.equal(cmpNumber(1, 2), -1);
  assert.equal(cmpNumber(2, 1), 1);
  assert.equal(cmpNumber(2, 2), 0);
  assert.throws(() => cmpNumber(Number.NaN, 1), /finite/);
  assert.throws(() => cmpNumber(1, Number.POSITIVE_INFINITY), /finite/);

  assert.equal(cmpBoolean(false, true), -1);
  assert.equal(cmpBoolean(true, false), 1);
  assert.equal(cmpBoolean(true, true), 0);

  assert.equal(cmpArrayLex([1, 2], [1, 3], cmpNumber), -1);
  assert.equal(cmpArrayLex([1, 2], [1, 2, 0], cmpNumber), -1);
  assert.equal(cmpArrayLex([1, 2], [1, 2], cmpNumber), 0);
});

test("stableSort is stable and deterministic", () => {
  const input = [
    { k: 1, v: "a" },
    { k: 1, v: "b" },
    { k: 0, v: "c" },
    { k: 1, v: "d" },
  ];

  const sorted = stableSort(input, (x, y) => cmpNumber(x.k, y.k));
  assert.deepEqual(
    sorted.map((o) => o.v),
    ["c", "a", "b", "d"],
  );

  const allEqual = stableSort(["x", "y", "z"], () => 0);
  assert.deepEqual(allEqual, ["x", "y", "z"]);
});

test("canonicalJsonStringify sorts object keys and matches JSON semantics", () => {
  assert.equal(canonicalJsonStringify({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(
    canonicalJsonStringify({ z: { b: 1, a: 2 }, a: [3, 2, 1] }),
    '{"a":[3,2,1],"z":{"a":2,"b":1}}',
  );
  assert.equal(canonicalJsonStringify([1, undefined, 3]), "[1,null,3]");
  assert.equal(canonicalJsonStringify({ a: undefined, b: 1 }), '{"b":1}');
  assert.equal(canonicalJsonStringify([1, () => 1, 3]), "[1,null,3]");
  assert.equal(canonicalJsonStringify({ a: () => 1, b: 2 }), '{"b":2}');
});

test("canonicalJsonStringify rejects cycles and non-plain objects", () => {
  const obj = { a: 1 };
  obj.self = obj;
  assert.throws(() => canonicalJsonStringify(obj), /Cycle detected/);

  assert.throws(() => canonicalJsonStringify(new Date(0)), /plain objects/);
});

test("hash helpers are stable", () => {
  assert.equal(
    sha256HexFromUtf8("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );

  const a = { b: 1, a: 2 };
  const b = { a: 2, b: 1 };
  assert.equal(hashCanonicalJson(a), hashCanonicalJson(b));
});

