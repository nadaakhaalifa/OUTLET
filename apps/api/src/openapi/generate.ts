import { z } from "zod";
import type { RateKey } from "../platform/rate-limit/budgets.js";
import { KEY_MULTIPLIER } from "../platform/rate-limit/budgets.js";
import { MUTATING_METHODS } from "../platform/http.js";
import type { RouteDef } from "../platform/route-registry.js";

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };
type Obj = Record<string, Json>;

const ref = (to: string): Obj => ({ $ref: to });

const schemaOf = (s: z.ZodType, io: "input" | "output"): Obj => {
  const js = z.toJSONSchema(s, { target: "draft-2020-12", io, unrepresentable: "any" }) as Obj;
  delete js.$schema;
  return js;
};

const problem = (description: string): Obj => ({ description, content: { "application/problem+json": { schema: ref("#/components/schemas/Problem") } } });

const COMPONENTS: Obj = {
  securitySchemes: {
    shopperJwt: { type: "http", scheme: "bearer", bearerFormat: "JWT", description: "User access JWT (ES256, 10 min, audience outlet:{market}, amr claim)." },
    sellerJwt: {
      type: "http",
      scheme: "bearer",
      bearerFormat: "JWT",
      description: "Same user token; seller routes also need a passkey in amr, an active store membership for X-Store-Id and a role allowed by x-authz.",
    },
  },
  parameters: {
    Market: { name: "market", in: "path", required: true, schema: { type: "string", pattern: "^[a-z]{2}(-[a-z0-9]{2,3})?$" } },
    IdempotencyKey: {
      name: "Idempotency-Key",
      in: "header",
      required: true,
      description: "Client UUIDv7 minted within ±24 h. Same key + other body → 422; in flight → 409; replay → stored response with Idempotent-Replayed: true.",
      schema: { type: "string", format: "uuid", pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" },
    },
    StoreScope: { name: "X-Store-Id", in: "header", required: true, description: "Active store; not a member → 404.", schema: { type: "string", format: "uuid" } },
    DeviceId: { name: "X-Device-Id", in: "header", required: true, description: "Install id (UUID) used as a rate-limit key.", schema: { type: "string", format: "uuid" } },
    ReasonCode: { name: "X-Reason-Code", in: "header", required: true, schema: { type: "string", pattern: "^[a-z_]{3,40}(:[A-Za-z0-9-]{1,40})?$" } },
    Cursor: { name: "cursor", in: "query", required: false, description: "Opaque keyset cursor from next_cursor. No OFFSET.", schema: { type: "string", maxLength: 512 } },
    Limit: { name: "limit", in: "query", required: false, description: "Page size 1-50 (default 20).", schema: { type: "integer", minimum: 1, maximum: 50, default: 20 } },
  },
  schemas: {
    Problem: {
      type: "object",
      description: "RFC 9457 Problem Details. No stack traces.",
      required: ["type", "title", "status", "code", "request_id"],
      properties: {
        type: { type: "string", format: "uri" },
        title: { type: "string" },
        status: { type: "integer" },
        code: { type: "string" },
        request_id: { type: "string" },
        detail: { type: "string" },
        retry_after_s: { type: "integer" },
        errors: { type: "array", maxItems: 50, items: { type: "object", required: ["path", "code"], properties: { path: { type: "string" }, code: { type: "string" }, message_key: { type: "string" } } } },
      },
    },
  },
};

const rateLimitDoc = (r: RouteDef): Json => {
  const rl = r.rateLimit;
  if (rl === undefined) return null;
  if ("exempt" in rl) return { exempt: rl.exempt };
  return rl.keys.map((k) => ({ budget: rl.budget.name, key: k, limit: rl.budget.limit * KEY_MULTIPLIER[k], window_s: rl.budget.periodMs / 1000, layer: "app", source: rl.budget.source }));
};

const operation = (r: RouteDef): Obj => {
  const c = r.contract;
  if (c === undefined || r.authz === undefined || r.rateLimit === undefined) throw new Error(`route ${r.method} ${r.path} is not audited`);
  const isPublic = r.authz.kind === "public";
  const storeTenant = r.authz.kind === "authorize" && r.authz.tenant === "store";
  const mutating = MUTATING_METHODS.includes(r.method) && r.noIdempotency === undefined;
  const rateKeys: readonly RateKey[] = "exempt" in r.rateLimit ? [] : r.rateLimit.keys;
  const params: Json[] = [];
  if (r.pathParams.includes("market")) params.push(ref("#/components/parameters/Market"));
  for (const [name, s] of Object.entries(c.params?.shape ?? {})) params.push({ name, in: "path", required: true, schema: schemaOf(s as z.ZodType, "input") });
  for (const [name, s] of Object.entries(c.query?.shape ?? {})) {
    if (r.paginated && name === "cursor") params.push(ref("#/components/parameters/Cursor"));
    else if (r.paginated && name === "limit") params.push(ref("#/components/parameters/Limit"));
    else params.push({ name, in: "query", required: !(s as z.ZodType).safeParse(undefined).success, schema: schemaOf(s as z.ZodType, "input") });
  }
  if (mutating) params.push(ref("#/components/parameters/IdempotencyKey"));
  if (storeTenant) params.push(ref("#/components/parameters/StoreScope"));
  if (rateKeys.includes("device")) params.push(ref("#/components/parameters/DeviceId"));
  if (r.reasonCode) params.push(ref("#/components/parameters/ReasonCode"));

  const status = String(c.status ?? (r.method === "POST" ? 201 : 200));
  const responses: Obj = {
    [status]: { description: "OK", content: { "application/json": { schema: schemaOf(c.response, "output") } } },
    "400": problem("Malformed request or unknown field (strict DTO)."),
  };
  if (!isPublic) {
    responses["401"] = problem("Missing, invalid, expired or other-market token.");
    responses["403"] = problem("Wrong role, missing passkey or reason code.");
  }
  responses["404"] = problem("Not found or not owned.");
  if (mutating) {
    responses["409"] = problem("Idempotency key in flight or state conflict.");
    responses["422"] = problem("Idempotency key reused with another body, or a business rule.");
  }
  if (rateKeys.length > 0) responses["429"] = problem("Rate limited; Retry-After is set.");
  responses["503"] = problem("Timeout, dependency down or kill switch.");

  const op: Obj = {
    operationId: c.operationId,
    summary: c.summary,
    ...(c.tags === undefined ? {} : { tags: [...c.tags] }),
    security: isPublic ? [] : [{ [storeTenant ? "sellerJwt" : "shopperJwt"]: [] }],
    parameters: params,
    responses,
    "x-authz":
      r.authz.kind === "public"
        ? { principal: "anonymous", tenant: "none" }
        : { action: r.authz.action, principal: storeTenant ? "seller_staff" : "shopper", tenant: r.authz.tenant, ...(r.reasonCode ? { reason_code: "required" } : {}) },
    "x-rate-limit": rateLimitDoc(r),
    "x-max-queries": c.maxQueries,
  };
  if (c.body !== undefined) op.requestBody = { required: true, content: { "application/json": { schema: schemaOf(c.body, "input") } } };
  if (mutating) op["x-idempotency"] = { header: "required", mode: "store" };
  if (r.noIdempotency !== undefined) op["x-idempotency"] = { header: "none", reason: r.noIdempotency };
  if (r.paginated) op["x-paginated"] = "keyset";
  if (r.killSwitch !== undefined) op["x-kill-switch"] = r.killSwitch;
  if (c.cacheControl !== undefined) op["x-cache-control"] = c.cacheControl;
  if (r.deprecated !== undefined) {
    op.deprecated = true;
    op["x-sunset"] = r.deprecated.sunset.toISOString();
  }
  return op;
};

/** OpenAPI 3.1 document generated from the audited route table (deterministic: routes are sorted). */
export const buildOpenApi = (routes: readonly RouteDef[]): Obj => {
  const paths: Record<string, Obj> = {};
  for (const r of routes) {
    const p = (paths[r.openapiPath] ??= {});
    p[r.method.toLowerCase()] = operation(r);
  }
  return {
    openapi: "3.1.0",
    info: { title: "Outlex API (generated)", version: "0.1.0", summary: "Generated from apps/api route metadata. Do not edit; run pnpm --filter api openapi." },
    paths,
    components: COMPONENTS,
  };
};
