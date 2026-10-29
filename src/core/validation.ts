/** Small dependency-free boundary validators. Parsed records are detached from caller input. */
export type Parser<T> = (value: unknown, path?: string) => T;
export function invalid(path: string, message: string): never { throw new Error(`${path}: ${message}`); }
export const text: Parser<string> = (value, path = "value") => typeof value === "string" && value.trim() ? value.trim() : invalid(path, "expected non-empty text");
export const boolean: Parser<boolean> = (value, path = "value") => typeof value === "boolean" ? value : invalid(path, "expected boolean");
export function number(min = -Infinity, max = Infinity, integer = false): Parser<number> {
  return (value, path = "value") => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isInteger(value)) ? value : invalid(path, "number outside allowed range");
}
export function oneOf<const T extends readonly (string | number)[]>(values: T): Parser<T[number]> {
  return (value, path = "value") => values.includes(value as T[number]) ? value as T[number] : invalid(path, `expected ${values.join(", ")}`);
}
export function optional<T>(parse: Parser<T>): Parser<T | undefined> { return (value, path) => value === undefined ? undefined : parse(value, path); }
export function array<T>(parse: Parser<T>): Parser<readonly T[]> {
  return (value, path = "value") => Array.isArray(value) ? value.map((entry, i) => parse(entry, `${path}[${i}]`)) : invalid(path, "expected array");
}
type Shape = Record<string, Parser<unknown>>;
type Output<S extends Shape> = { readonly [K in keyof S as undefined extends ReturnType<S[K]> ? never : K]: ReturnType<S[K]> } & { readonly [K in keyof S as undefined extends ReturnType<S[K]> ? K : never]?: Exclude<ReturnType<S[K]>, undefined> };
export function object<S extends Shape>(shape: S): Parser<Output<S>> {
  return (value, path = "value") => {
    if (!value || typeof value !== "object" || Array.isArray(value)) invalid(path, "expected record");
    const input = value as Record<string, unknown>;
    for (const key of Object.keys(input)) if (!Object.hasOwn(shape, key)) invalid(`${path}.${key}`, "unknown field");
    const output: Record<string, unknown> = {};
    for (const [key, parse] of Object.entries(shape)) {
      const parsed = parse(input[key], `${path}.${key}`);
      if (parsed !== undefined) output[key] = parsed;
    }
    return output as Output<S>;
  };
}
export const dateOnly: Parser<string> = (value, path = "date") => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) invalid(path, "expected YYYY-MM-DD");
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) invalid(path, "invalid calendar date");
  return value;
};
export const instant: Parser<string> = (value, path = "instant") => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)) invalid(path, "expected timestamp with explicit timezone");
  dateOnly(value.slice(0, 10), path);
  const time = Date.parse(value);
  if (!Number.isFinite(time)) invalid(path, "invalid timestamp");
  return new Date(time).toISOString();
};
