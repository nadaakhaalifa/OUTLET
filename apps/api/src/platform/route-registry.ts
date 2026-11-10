import { RequestMethod } from "@nestjs/common";
import type { Type } from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants.js";
import { Reflector } from "@nestjs/core";
import { isKillSwitchName } from "@outlet/flags";
import { ADMIN_POLICY, PUBLIC_ACTIONS, SELLER_POLICY, SHOPPER_ACTIONS, requiresReasonCode } from "@outlet/policy";
import { z } from "zod";
import { META } from "./decorators.js";
import type { AuthzMeta, ContractDef, DeprecationMeta, RateLimitMeta } from "./decorators.js";
import { MUTATING_METHODS } from "./http.js";
import { RATE_KEYS } from "./rate-limit/budgets.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RouteDef {
  readonly controller: string;
  readonly handler: string;
  readonly method: HttpMethod;
  /** Nest/Fastify form: `/v1/:market/stores/:store_slug`. */
  readonly path: string;
  /** OpenAPI form: `/v1/{market}/stores/{store_slug}`. */
  readonly openapiPath: string;
  readonly pathParams: readonly string[];
  readonly contract: ContractDef | undefined;
  readonly authz: AuthzMeta | undefined;
  readonly rateLimit: RateLimitMeta | undefined;
  readonly paginated: boolean;
  readonly reasonCode: boolean;
  readonly noIdempotency: string | undefined;
  readonly killSwitch: string | undefined;
  readonly deprecated: DeprecationMeta | undefined;
}

const METHODS: Partial<Record<number, HttpMethod>> = {
  [RequestMethod.GET]: "GET",
  [RequestMethod.POST]: "POST",
  [RequestMethod.PUT]: "PUT",
  [RequestMethod.PATCH]: "PATCH",
  [RequestMethod.DELETE]: "DELETE",
};

const reflector = new Reflector();

const joinPath = (...parts: readonly string[]): string =>
  `/${parts
    .flatMap((p) => p.split("/"))
    .filter((s) => s.length > 0)
    .join("/")}`;

const SELLER_ACTIONS: readonly string[] = [...new Set(Object.values(SELLER_POLICY).flat())];
const ADMIN_ACTIONS: readonly string[] = [...new Set(Object.values(ADMIN_POLICY).flat())];

export const routeKey = (r: Pick<RouteDef, "method" | "openapiPath">): string => `${r.method} ${r.openapiPath}`;

/** Own and inherited method names, like Nest's MetadataScanner.getAllMethodNames (accessors are never invoked). */
const methodNames = (proto: object): string[] => {
  const names = new Set<string>();
  for (let p: object | null = proto; p !== null && p !== Object.prototype; p = Object.getPrototypeOf(p) as object | null) {
    for (const name of Object.getOwnPropertyNames(p)) {
      if (name === "constructor") continue;
      const d = Object.getOwnPropertyDescriptor(p, name);
      if (typeof d?.value === "function") names.add(name);
    }
  }
  return [...names];
};

/** Reads the route table of the given controllers from Nest's own metadata plus ours. */
export const collectRoutes = (controllers: readonly Type[]): RouteDef[] => {
  const out: RouteDef[] = [];
  for (const ctrl of controllers) {
    const base: unknown = reflector.get(PATH_METADATA, ctrl);
    const basePath = typeof base === "string" ? base : "";
    const proto = ctrl.prototype as Record<string, unknown>;
    // Nest serves inherited handlers too (MetadataScanner walks the prototype chain), so the audit must see them.
    for (const name of methodNames(proto)) {
      const fn = proto[name];
      if (typeof fn !== "function") continue;
      const m: unknown = reflector.get(METHOD_METADATA, fn);
      if (typeof m !== "number") continue;
      const method = METHODS[m];
      if (method === undefined) throw new Error(`${ctrl.name}.${name}: unsupported HTTP method`);
      const sub: unknown = reflector.get(PATH_METADATA, fn);
      const path = joinPath(basePath, typeof sub === "string" ? sub : "");
      const get = (key: string): unknown => reflector.get<unknown>(key, fn);
      out.push({
        controller: ctrl.name,
        handler: name,
        method,
        path,
        openapiPath: path.replace(/:([A-Za-z0-9_]+)/g, "{$1}"),
        pathParams: [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((x) => x[1] ?? ""),
        contract: get(META.contract) as ContractDef | undefined,
        authz: get(META.authz) as AuthzMeta | undefined,
        rateLimit: get(META.rateLimit) as RateLimitMeta | undefined,
        paginated: get(META.paginated) as boolean | undefined === true,
        reasonCode: get(META.reasonCode) as boolean | undefined === true,
        noIdempotency: get(META.noIdempotency) as string | undefined,
        killSwitch: get(META.killSwitch) as string | undefined,
        deprecated: get(META.deprecated) as DeprecationMeta | undefined,
      });
    }
  }
  return out.sort((a, b) => (a.openapiPath === b.openapiPath ? a.method.localeCompare(b.method) : a.openapiPath.localeCompare(b.openapiPath)));
};

const isList = (s: z.ZodType): boolean => s instanceof z.ZodArray || (s instanceof z.ZodObject && s.shape.items instanceof z.ZodArray);

const MIN_SUNSET_MS = 183 * 24 * 60 * 60 * 1000;

/** BUILD-PROMPT §2 route rules, checked on the real route table. Returns every violation (empty = compliant). */
export const auditRoutes = (routes: readonly RouteDef[]): string[] => {
  const v: string[] = [];
  const seenOps = new Set<string>();
  const seenRoutes = new Set<string>();
  for (const r of routes) {
    const at = `${r.controller}.${r.handler} (${routeKey(r)})`;
    const bad = (msg: string): void => {
      v.push(`${at}: ${msg}`);
    };
    if (seenRoutes.has(routeKey(r))) bad("duplicate route");
    seenRoutes.add(routeKey(r));
    if (!r.path.startsWith("/v1/")) bad("every route is versioned under /v1/");
    const c = r.contract;
    if (c === undefined) bad("missing @Contract (schemas drive validation, serialisation and OpenAPI)");
    else {
      if (seenOps.has(c.operationId)) bad(`duplicate operationId ${c.operationId}`);
      seenOps.add(c.operationId);
      if (!Number.isInteger(c.maxQueries) || c.maxQueries < 0) bad("maxQueries must be a non-negative integer");
      const declared = Object.keys(c.params?.shape ?? {});
      const expected = r.pathParams.filter((p) => p !== "market");
      if (declared.sort().join() !== [...expected].sort().join()) bad(`params schema keys [${declared.join()}] must equal path params [${expected.join()}]`);
      if (r.method === "GET" && c.body !== undefined) bad("GET routes take no body");
      if (MUTATING_METHODS.includes(r.method) && r.method !== "DELETE" && c.body === undefined) bad("mutating routes declare a body schema");
      if (isList(c.response) && !r.paginated) bad("list responses must be @Paginated (keyset cursor, max 50)");
      if (r.paginated) {
        if (r.method !== "GET") bad("@Paginated is for GET routes");
        const shape = c.response instanceof z.ZodObject ? c.response.shape : undefined;
        if (!(shape?.items instanceof z.ZodArray) || shape.next_cursor === undefined) bad("paginated response must be { items, next_cursor }");
        const q = c.query?.shape ?? {};
        if (q.cursor === undefined || q.limit === undefined) bad("paginated query must include cursor and limit (CursorQuery)");
      }
    }
    const a = r.authz;
    if (a === undefined) bad("missing @Public() or @Authorize() (deny by default)");
    if (a?.kind !== "public" && !r.path.startsWith("/v1/:market/")) bad("authenticated routes live under /v1/:market/ (tokens are market-bound)");
    if (a?.kind === "public" && c?.cacheControl === undefined && r.method === "GET") bad("public GET routes declare cacheControl");
    if (a?.kind === "authorize") {
      if (c?.cacheControl !== undefined) bad("authenticated responses are always private, no-store");
      const knownAction = SHOPPER_ACTIONS.includes(a.action) || SELLER_ACTIONS.includes(a.action) || PUBLIC_ACTIONS.includes(a.action) || (a.tenant === "admin" && ADMIN_ACTIONS.includes(a.action));
      if (!knownAction) bad(`action ${a.action} is not grantable to shoppers or seller staff in @outlet/policy`);
      if (a.tenant === "admin" && !ADMIN_ACTIONS.includes(a.action)) bad(`admin-tenant action ${a.action} is not an admin action`);
      if (a.tenant === "store" && !SELLER_ACTIONS.includes(a.action)) bad(`store-tenant action ${a.action} is not a seller action`);
      if (requiresReasonCode(a.action) && !r.reasonCode) bad(`action ${a.action} requires @ReasonCode()`);
    }
    if (r.reasonCode && (a?.kind !== "authorize" || !requiresReasonCode(a.action))) bad("@ReasonCode() only on REQUIRES_REASON_CODE actions");
    const rl = r.rateLimit;
    if (rl === undefined) bad("missing @RateLimit() (every route needs a limit, API4)");
    else if ("exempt" in rl) {
      if (rl.exempt.trim().length === 0) bad("@NoRateLimit needs a reason");
      if (a?.kind !== "public" || r.method !== "GET") bad("@NoRateLimit only on public GET probes");
    } else {
      if (rl.keys.length === 0) bad("rate limit needs at least one key");
      if (rl.keys.some((k) => !RATE_KEYS.includes(k))) bad("unknown rate-limit key");
      if (rl.keys.every((k) => k === "ip" || k === "asn")) bad("never rate-limit on IP/ASN alone (CGNAT)");
      if (rl.keys.includes("store") && !(a?.kind === "authorize" && a.tenant === "store")) bad("store key only on store-tenant routes");
      if (rl.keys.includes("user") && a?.kind !== "authorize") bad("user key only on authenticated routes");
      if (!(rl.budget.limit > 0) || !(rl.budget.periodMs > 0)) bad("budget limit and period must be positive");
    }
    if (MUTATING_METHODS.includes(r.method)) {
      if (r.noIdempotency !== undefined && (r.method !== "POST" || r.noIdempotency.trim().length === 0)) bad("@NoIdempotency only on pure POSTs, with a reason");
    } else if (r.noIdempotency !== undefined) bad("@NoIdempotency on a non-mutating route");
    if (r.killSwitch !== undefined && !isKillSwitchName(r.killSwitch)) bad(`unknown kill switch ${r.killSwitch}`);
    const d = r.deprecated;
    if (d !== undefined && d.sunset.getTime() - d.deprecatedAt.getTime() < MIN_SUNSET_MS) bad("Sunset must be at least 6 months after deprecation");
  }
  return v;
};

export class RouteAuditError extends Error {
  constructor(readonly violations: readonly string[]) {
    super(`route audit failed:\n${violations.join("\n")}`);
    this.name = "RouteAuditError";
  }
}

export const assertRoutes = (routes: readonly RouteDef[]): void => {
  const v = auditRoutes(routes);
  if (v.length > 0) throw new RouteAuditError(v);
};

/** `GET /v1/:market/x/:id` (Fastify) → the registry's `GET /v1/{market}/x/{id}` key. */
export const servedRouteKey = (method: string, url: string): string => `${method} ${url.replace(/:([A-Za-z0-9_]+)/g, "{$1}")}`;

/**
 * Compares what the HTTP server actually registered (Fastify's onRoute) with the audited table, both ways: a route
 * that is served but never audited (inherited handler, adapter route) or audited but not served refuses startup.
 */
export const assertServedMatchesAudited = (served: readonly string[], audited: readonly RouteDef[]): void => {
  const a = new Set(audited.map(routeKey));
  const s = new Set(served);
  const v = [
    ...[...s].filter((k) => !a.has(k)).map((k) => `${k}: served but not audited`),
    ...[...a].filter((k) => !s.has(k)).map((k) => `${k}: audited but not served`),
  ];
  if (v.length > 0) throw new RouteAuditError(v);
};
