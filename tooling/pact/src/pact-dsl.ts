/**
 * Minimal Pact specification v3 JSON generator (no native core, no network).
 * Output is consumable by pact-broker / @pact-foundation/pact-core verifiers.
 * Matchers supported: type (like), eachLike (min), regex, integer-by-type via like(1).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const MATCHER = Symbol("pact-matcher");

type Rule = { match: "type"; min?: number } | { match: "regex"; regex: string };

interface Matched<T = unknown> {
  readonly [MATCHER]: true;
  readonly example: T;
  readonly rule: Rule;
  readonly inner?: unknown;
}

export const like = <T>(example: T): Matched<T> => ({ [MATCHER]: true, example, rule: { match: "type" } });
export const regex = (example: string, pattern: string): Matched<string> => ({
  [MATCHER]: true,
  example,
  rule: { match: "regex", regex: pattern },
});
export const eachLike = <T>(example: T, min = 1): Matched<T[]> => ({
  [MATCHER]: true,
  example: Array.from({ length: min }, () => example),
  rule: { match: "type", min },
  inner: example,
});

const isMatched = (v: unknown): v is Matched =>
  typeof v === "object" && v !== null && (v as Record<symbol, unknown>)[MATCHER] === true;

export type MatchingRules = Record<string, { combine: "AND"; matchers: Rule[] }>;

/** Strips matchers to plain example data and collects JSONPath rules, rooted at `root` (e.g. `$.body`). */
export function render(value: unknown, root: string, rules: MatchingRules): unknown {
  if (isMatched(value)) {
    rules[root] = { combine: "AND", matchers: [value.rule] };
    if (value.inner !== undefined) {
      const arr = value.example as unknown[];
      return arr.map((_, i) => render(value.inner, `${root}[${i}]`, i === 0 ? rules : {}));
    }
    return render(value.example, root, rules);
  }
  if (Array.isArray(value)) return value.map((v, i) => render(v, `${root}[${i}]`, rules));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = render(v, `${root}.${k}`, rules);
    return out;
  }
  return value;
}

export interface RequestSpec {
  readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** Concrete path (no matchers). Use providerState params for ids. */
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

export interface ResponseSpec {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string | Matched<string>>>;
  readonly body?: unknown;
}

export interface InteractionSpec {
  /** Stable id used by the provider verifier to find setup and OpenAPI operation. */
  readonly description: string;
  readonly providerState: string;
  /** OpenAPI operation to validate the real response against, `METHOD /v1/path/{param}`. */
  readonly openapi: string;
  /** Mobile port or Zod schema this expectation was derived from (documentation). */
  readonly derivedFrom: string;
  readonly request: RequestSpec;
  readonly response: ResponseSpec;
}

export interface PactInteraction {
  description: string;
  providerStates: { name: string }[];
  request: { method: string; path: string; query?: Record<string, string>; headers?: Record<string, string>; body?: unknown; matchingRules?: MatchingRules };
  response: { status: number; headers?: Record<string, string>; body?: unknown; matchingRules?: MatchingRules };
  metadata: { openapi: string; derivedFrom: string };
}

export interface PactFile {
  consumer: { name: string };
  provider: { name: string };
  interactions: PactInteraction[];
  metadata: { pactSpecification: { version: "3.0.0" }; client: { name: string; version: string } };
}

export function buildPact(consumer: string, provider: string, specs: readonly InteractionSpec[]): PactFile {
  return {
    consumer: { name: consumer },
    provider: { name: provider },
    interactions: specs.map((s) => {
      const reqRules: MatchingRules = {};
      const resRules: MatchingRules = {};
      const resHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(s.response.headers ?? {})) {
        resHeaders[k] = render(v, `$.header.${k}`, resRules) as string;
      }
      const reqBody = s.request.body === undefined ? undefined : render(s.request.body, "$.body", reqRules);
      const resBody = s.response.body === undefined ? undefined : render(s.response.body, "$.body", resRules);
      return {
        description: s.description,
        providerStates: [{ name: s.providerState }],
        request: {
          method: s.request.method,
          path: s.request.path,
          ...(s.request.query !== undefined ? { query: { ...s.request.query } } : {}),
          ...(s.request.headers !== undefined ? { headers: { ...s.request.headers } } : {}),
          ...(reqBody !== undefined ? { body: reqBody } : {}),
          ...(Object.keys(reqRules).length > 0 ? { matchingRules: reqRules } : {}),
        },
        response: {
          status: s.response.status,
          ...(Object.keys(resHeaders).length > 0 ? { headers: resHeaders } : {}),
          ...(resBody !== undefined ? { body: resBody } : {}),
          ...(Object.keys(resRules).length > 0 ? { matchingRules: resRules } : {}),
        },
        metadata: { openapi: s.openapi, derivedFrom: s.derivedFrom },
      };
    }),
    metadata: { pactSpecification: { version: "3.0.0" }, client: { name: "outlet-pact-dsl", version: "0.1.0" } },
  };
}

export function writePact(file: string, pact: PactFile): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(pact, null, 2)}\n`);
}

// ---- verifier side ------------------------------------------------------------------------------

/** Applies Pact matching rules (type / regex / min) of `expected` against `actual`. Returns mismatches. */
export function matchBody(expected: unknown, actual: unknown, rules: MatchingRules | undefined, path = "$.body"): string[] {
  const rule = rules?.[path]?.matchers[0];
  const out: string[] = [];
  const typeOf = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
  if (rule?.match === "regex") {
    if (typeof actual !== "string" || !new RegExp(rule.regex).test(actual)) out.push(`${path}: does not match /${rule.regex}/`);
    return out;
  }
  if (typeOf(expected) !== typeOf(actual)) {
    out.push(`${path}: expected ${typeOf(expected)}, got ${typeOf(actual)}`);
    return out;
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (rule?.match === "type") {
      const min = rule.min ?? 0;
      if (actual.length < min) out.push(`${path}: expected at least ${min} items, got ${actual.length}`);
      for (let i = 0; i < actual.length; i++) out.push(...matchBody(expected[0], actual[i], rules, `${path}[0]`).map((m) => m.replace(`${path}[0]`, `${path}[${i}]`)));
      return out;
    }
    if (actual.length !== expected.length) out.push(`${path}: expected ${expected.length} items, got ${actual.length}`);
    expected.forEach((e, i) => out.push(...matchBody(e, actual[i], rules, `${path}[${i}]`)));
    return out;
  }
  if (expected !== null && typeof expected === "object") {
    // Pact semantics: extra keys in the actual body are allowed; every expected key must be present.
    for (const [k, v] of Object.entries(expected)) {
      const a = (actual as Record<string, unknown>)[k];
      if (!(k in (actual as object))) out.push(`${path}.${k}: missing`);
      else out.push(...matchBody(v, a, rules, `${path}.${k}`));
    }
    return out;
  }
  if (rule?.match === "type") return out;
  if (expected !== actual) out.push(`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  return out;
}
