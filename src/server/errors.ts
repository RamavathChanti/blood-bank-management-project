import "server-only";

export class RegistryError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
export function deny(code = "FORBIDDEN"): never { throw new RegistryError(403, code); }
export function validate<T>(parse: (input: unknown) => T, input: unknown): T {
  try { return parse(input); } catch { throw new RegistryError(400, "INVALID_INPUT"); }
}
