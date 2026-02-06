import { asyncFlow, classFlow, optionalFlow, pipeline } from "./b.js";
import { id } from "./a.js";

export async function main(arg: string): Promise<string> {
  const a = id(arg);
  const b = pipeline(a);
  const c = classFlow(b);
  const d = optionalFlow({ value: c });
  const e = await asyncFlow(d);
  return e;
}

void main("x");

