import { UncanonicalizableRequestError } from "./errors";
import { sha256Hex } from "./sha256";

export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | bigint
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

/**
 * Deterministic serialisation: object keys sorted by UTF-16 code unit, no whitespace,
 * bigint tagged so 1n and 1 differ (money is bigint minor units), -0 normalised to 0.
 * Array order is significant. undefined, NaN, Infinity, functions and cycles are rejected.
 */
export function canonicalize(value: unknown): string {
  return walk(value, new Set<object>());
}

function walk(value: unknown, seen: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
    case "bigint":
      return `{"$bigint":"${value.toString()}"}`;
    case "number":
      if (!Number.isFinite(value)) throw new UncanonicalizableRequestError("non-finite number");
      return JSON.stringify(Object.is(value, -0) ? 0 : value);
    case "object": {
      if (seen.has(value)) throw new UncanonicalizableRequestError("cyclic structure");
      seen.add(value);
      try {
        if (Array.isArray(value)) return `[${value.map((v: unknown) => walk(v, seen)).join(",")}]`;
        const proto: unknown = Object.getPrototypeOf(value);
        if (proto !== Object.prototype && proto !== null) {
          throw new UncanonicalizableRequestError("non-plain object");
        }
        const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
          a < b ? -1 : a > b ? 1 : 0,
        );
        return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${walk(v, seen)}`).join(",")}}`;
      } finally {
        seen.delete(value);
      }
    }
    default:
      throw new UncanonicalizableRequestError(`unsupported type: ${typeof value}`);
  }
}

export interface RequestFingerprintInput {
  readonly method: string;
  /** Route template, e.g. "POST /v1/orders". Never the raw URL with ids baked in unless they are part of the request. */
  readonly route: string;
  readonly query?: CanonicalValue;
  readonly body?: CanonicalValue;
}

/** SHA-256 hex of the canonical request. Excludes the key, headers and actor. */
export function hashRequest(input: RequestFingerprintInput): string {
  return sha256Hex(
    canonicalize({
      method: input.method.toUpperCase(),
      route: input.route,
      query: input.query ?? null,
      body: input.body ?? null,
    }),
  );
}
