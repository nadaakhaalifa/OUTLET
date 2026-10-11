/** Tiny OpenAPI 3.1 reader + JSON-schema subset validator for contract checks (no codegen, no network). */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "../../..");
const req = createRequire(resolve(REPO_ROOT, "package.json"));
const YAML = req("yaml") as { parse(s: string): unknown };

type Json = Record<string, unknown>;

export interface OpenApiDoc {
  readonly paths: Record<string, Record<string, Json>>;
  readonly components: { schemas: Record<string, Json>; responses: Record<string, Json>; headers: Record<string, Json> };
}

let cached: OpenApiDoc | null = null;
export function loadOpenApi(): OpenApiDoc {
  cached ??= YAML.parse(readFileSync(resolve(REPO_ROOT, "docs/api/openapi.yaml"), "utf8")) as OpenApiDoc;
  return cached;
}

function deref(doc: OpenApiDoc, node: unknown): Json {
  let cur = node as Json;
  for (let i = 0; i < 20 && typeof cur?.["$ref"] === "string"; i++) {
    const parts = (cur["$ref"] as string).replace(/^#\//, "").split("/");
    let t: unknown = doc;
    for (const p of parts) t = (t as Json)[p];
    cur = t as Json;
  }
  return cur;
}

/** `GET /v1/products/{productId}` -> operation object. */
export function operation(doc: OpenApiDoc, key: string): Json {
  const [method, path] = key.split(" ") as [string, string];
  const op = doc.paths[path]?.[method.toLowerCase()];
  if (op === undefined) throw new Error(`OpenAPI has no operation ${key}`);
  return op;
}

export interface ResponseDoc {
  readonly headers: Record<string, Json>;
  readonly schema: Json | null;
  readonly mediaType: string | null;
}

export function responseDoc(doc: OpenApiDoc, key: string, status: number): ResponseDoc | null {
  const responses = operation(doc, key)["responses"] as Record<string, Json>;
  const raw = responses[String(status)] ?? responses["default"];
  if (raw === undefined) return null;
  const r = deref(doc, raw);
  const content = (r["content"] ?? {}) as Record<string, Json>;
  const mediaType = Object.keys(content)[0] ?? null;
  const schema = mediaType === null ? null : (content[mediaType]?.["schema"] as Json | undefined) ?? null;
  const headers: Record<string, Json> = {};
  for (const [k, v] of Object.entries((r["headers"] ?? {}) as Record<string, Json>)) headers[k.toLowerCase()] = deref(doc, v);
  return { headers, schema, mediaType };
}

export function declaredStatuses(doc: OpenApiDoc, key: string): string[] {
  return Object.keys(operation(doc, key)["responses"] as Json);
}

/** Returns a list of violations (empty = valid). Supports $ref, allOf/oneOf/anyOf, enum, nullable via type arrays. */
export function validate(doc: OpenApiDoc, schema: unknown, value: unknown, path = "$"): string[] {
  const s = deref(doc, schema);
  const errs: string[] = [];
  if (s["allOf"] !== undefined) {
    // additionalProperties:false inside allOf members is unsatisfiable by composition; validate members loosely.
    for (const m of s["allOf"] as unknown[]) errs.push(...validate(doc, stripClosed(deref(doc, m)), value, path));
    return errs;
  }
  for (const key of ["oneOf", "anyOf"] as const) {
    if (s[key] !== undefined) {
      const branches = (s[key] as unknown[]).map((b) => validate(doc, b, value, path));
      return branches.some((b) => b.length === 0) ? [] : [`${path}: matches no ${key} branch (${branches[0]?.[0] ?? "?"})`];
    }
  }
  const types = s["type"] === undefined ? null : ([] as unknown[]).concat(s["type"]);
  const actual = value === null ? "null" : Array.isArray(value) ? "array" : Number.isInteger(value) ? "integer" : typeof value;
  if (types !== null) {
    const ok = types.some((t) => t === actual || (t === "number" && actual === "integer"));
    if (!ok) return [`${path}: expected ${types.join("|")}, got ${actual}`];
  }
  if (s["enum"] !== undefined && !(s["enum"] as unknown[]).includes(value)) errs.push(`${path}: ${JSON.stringify(value)} not in enum`);
  if (typeof value === "string" && typeof s["pattern"] === "string" && !new RegExp(s["pattern"]).test(value)) errs.push(`${path}: does not match pattern`);
  if (Array.isArray(value) && s["items"] !== undefined) value.forEach((v, i) => errs.push(...validate(doc, s["items"], v, `${path}[${i}]`)));
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const o = value as Json;
    const props = (s["properties"] ?? {}) as Record<string, unknown>;
    for (const r of (s["required"] ?? []) as string[]) if (!(r in o)) errs.push(`${path}.${r}: required but missing`);
    for (const [k, v] of Object.entries(o)) {
      if (k in props) errs.push(...validate(doc, props[k], v, `${path}.${k}`));
      else if (s["additionalProperties"] === false) errs.push(`${path}.${k}: not allowed by schema (additionalProperties:false)`);
    }
  }
  return errs;
}

function stripClosed(s: Json): Json {
  if (s["additionalProperties"] === false) {
    const { additionalProperties: _drop, ...rest } = s;
    return rest;
  }
  return s;
}
