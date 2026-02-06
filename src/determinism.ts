import { createHash } from "node:crypto";

export type Comparator<T> = (a: T, b: T) => number;

export function cmpString(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function cmpNumber(a: number, b: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    throw new Error(`cmpNumber requires finite numbers; got ${a} and ${b}`);
  }
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function cmpBoolean(a: boolean, b: boolean): number {
  if (a === b) return 0;
  return a ? 1 : -1;
}

export function cmpArrayLex<T>(a: readonly T[], b: readonly T[], cmpT: Comparator<T>): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const c = cmpT(a[i]!, b[i]!);
    if (c !== 0) return c;
  }
  return cmpNumber(a.length, b.length);
}

// Stable and deterministic sorting independent of engine-level sort stability.
export function stableSort<T>(values: readonly T[], cmpT: Comparator<T>): T[] {
  const decorated = values.map((value, index) => ({ value, index }));
  decorated.sort((a, b) => {
    const c = cmpT(a.value, b.value);
    if (!Number.isFinite(c)) throw new Error(`Comparator returned non-finite value: ${c}`);
    if (c !== 0) return c;
    return a.index - b.index;
  });
  return decorated.map((d) => d.value);
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function canonicalJsonStringify(value: unknown): string {
  const stack = new Set<object>();

  const stringifyInner = (v: unknown): string => {
    if (v === null) return "null";

    const t = typeof v;
    if (t === "string") return JSON.stringify(v);
    if (t === "number") {
      if (!Number.isFinite(v)) throw new Error(`Non-finite number is not valid JSON: ${v}`);
      return JSON.stringify(v);
    }
    if (t === "boolean") return v ? "true" : "false";
    if (t === "bigint") throw new Error("bigint is not valid JSON");
    if (t === "undefined") throw new Error("undefined is not valid JSON");
    if (t === "function" || t === "symbol") throw new Error(`${t} is not valid JSON`);

    if (Array.isArray(v)) {
      if (stack.has(v)) throw new Error("Cycle detected while stringifying JSON");
      stack.add(v);
      const parts = v.map((el) => {
        if (el === undefined) return "null"; // Match JSON.stringify array semantics.
        const et = typeof el;
        if (et === "function" || et === "symbol") return "null";
        return stringifyInner(el);
      });
      stack.delete(v);
      return `[${parts.join(",")}]`;
    }

    // Object.
    if (!isPlainObject(v)) {
      const name = (v as { constructor?: { name?: string } }).constructor?.name;
      throw new Error(`Only plain objects are supported in canonical JSON; got ${name ?? "(unknown)"}`);
    }
    if (stack.has(v)) throw new Error("Cycle detected while stringifying JSON");
    stack.add(v);

    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj).sort(cmpString);
    const parts: string[] = [];
    for (const k of keys) {
      const val = obj[k];
      if (val === undefined) continue; // Match JSON.stringify object semantics.
      const vt = typeof val;
      if (vt === "function" || vt === "symbol") continue;
      parts.push(`${JSON.stringify(k)}:${stringifyInner(val)}`);
    }

    stack.delete(v);
    return `{${parts.join(",")}}`;
  };

  return stringifyInner(value);
}

export function sha256HexFromUtf8(text: string): string {
  const h = createHash("sha256");
  h.update(text, "utf8");
  return h.digest("hex");
}

export function hashCanonicalJson(value: unknown): string {
  return sha256HexFromUtf8(canonicalJsonStringify(value));
}

