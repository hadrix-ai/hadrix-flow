import { addPrefix, readValue, wrap } from "./a.js";

export function pipeline(input: string): string {
  const w = wrap(input);
  const inner = readValue(w);
  return addPrefix("p:", inner);
}

export class Box {
  value: string;

  constructor(value: string) {
    this.value = value;
  }

  get(): string {
    return this.value;
  }

  set(v: string): void {
    this.value = v;
  }
}

export function classFlow(x: string): string {
  const b = new Box(x);
  b.set(x + "!");
  return b.get();
}

export async function asyncFlow(x: string): Promise<string> {
  const p = Promise.resolve(x);
  const v = await p;
  return v;
}

export function optionalFlow(obj?: { value: string }): string {
  const v = obj?.value ?? "default";
  return v;
}

