// Reading JSON from outside (Hypha, Stripe, storage) without trusting its shape: each
// reader returns the field only when it has the expected type.

export type JsonObject = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function str(object: JsonObject, key: string): string | undefined {
  const value = object[key];
  return typeof value === "string" ? value : undefined;
}

export function num(object: JsonObject, key: string): number | undefined {
  const value = object[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function bool(object: JsonObject, key: string): boolean | undefined {
  const value = object[key];
  return typeof value === "boolean" ? value : undefined;
}

export function rec(object: JsonObject, key: string): JsonObject | undefined {
  const value = object[key];
  return isRecord(value) ? value : undefined;
}

/** A string-to-string map (Stripe's `metadata`). */
export function strings(object: JsonObject, key: string): Record<string, string> {
  const value = rec(object, key) ?? {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) if (typeof v === "string") out[k] = v;
  return out;
}

/** JSON text parsed, or `undefined` when it isn't JSON. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** A Response's JSON body, or `undefined`. */
export async function readJson(response: Response): Promise<unknown> {
  return parseJson(await response.text());
}
