export function id<T>(x: T): T {
  return x;
}

export function addPrefix(prefix: string, value: string): string {
  const combined = prefix + value;
  return combined;
}

export function wrap(value: string): { value: string } {
  return { value };
}

export function readValue(obj: { value: string }): string {
  return obj.value;
}

