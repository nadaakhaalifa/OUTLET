import { SELLER_POLICY, SELLER_ROLES, SHOPPER_ACTIONS, authorize } from "@outlet/policy";
import type { Principal } from "@outlet/policy";
import type { InjectOptions } from "fastify";
import { expect } from "vitest";
import type { RouteDef } from "../src/platform/route-registry.js";
import { bearer, idemKey } from "./harness.js";
import type { TestApp } from "./harness.js";
import type { RouteFixture } from "./route-fixtures.js";

export interface AuthzCase {
  readonly name: string;
  readonly req: InjectOptions;
  readonly status: number;
  readonly code?: string;
}

const withHeaders = (req: InjectOptions, change: (h: Record<string, string>) => Record<string, string>): InjectOptions => {
  const h = { ...((req.headers ?? {}) as Record<string, string>) };
  return { ...req, headers: change(h) };
};

const without = (name: string) => (h: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(h).filter(([k]) => k !== name));
const withoutAuth = without("authorization");

/**
 * The negative-authorization matrix for one route (BUILD-PROMPT §2: other tenant → 404, wrong role → 403, plus 401
 * for missing/invalid credentials). Generated from the route's own metadata, so it cannot drift from the guards.
 */
export const negativeAuthzCases = async (t: TestApp, route: RouteDef, fx: RouteFixture): Promise<AuthzCase[]> => {
  const cases: AuthzCase[] = [];
  const h = await fx.happy(t);
  const happy = h.req;
  const url = typeof happy.url === "string" ? happy.url : "";
  if (route.pathParams.includes("market")) {
    cases.push({ name: "unknown market → 404", req: { ...happy, url: url.replace(/^\/v1\/[a-z]{2}\//, "/v1/zz/") }, status: 404, code: "unknown-market" });
  }
  const authz = route.authz;
  if (authz === undefined) throw new Error(`${route.path}: no authz metadata`);
  if (authz.kind === "public") {
    // Public routes ignore credentials entirely, so a cache can never mix principals and a bad token is not a 401 here.
    cases.push({ name: "credentials on a public route are ignored", req: withHeaders(happy, (x) => ({ ...x, authorization: "Bearer not-a-jwt" })), status: h.status });
    const objectParams = route.pathParams.filter((p) => p !== "market");
    if (objectParams.length > 0) {
      if (fx.missing === undefined) throw new Error(`${route.method} ${route.openapiPath}: public route with ids needs a 'missing' fixture`);
      cases.push({ name: "missing or non-public object → 404", req: fx.missing(t), status: 404 });
    }
    return cases;
  }
  cases.push({ name: "anonymous → 401", req: withHeaders(happy, withoutAuth), status: 401, code: "unauthenticated" });
  cases.push({ name: "malformed bearer → 401", req: withHeaders(happy, (h) => ({ ...h, authorization: "Bearer not-a-jwt" })), status: 401, code: "invalid-token" });
  cases.push({ name: "expired token → 401", req: withHeaders(happy, (h) => h), status: 401, code: "invalid-token" });
  const expired = await t.mint({ expiresInS: -60 });
  const last = cases[cases.length - 1];
  if (last !== undefined) cases[cases.length - 1] = { ...last, req: withHeaders(happy, (h) => ({ ...h, ...bearer(expired) })) };
  const foreignKey = await t.mint({ kid: "unknown-kid" });
  cases.push({ name: "unknown signing key → 401", req: withHeaders(happy, (h) => ({ ...h, ...bearer(foreignKey) })), status: 401, code: "invalid-token" });

  if (authz.tenant === "store") {
    const store = t.seed.storeA;
    const wrongRole = SELLER_ROLES.find((r) => !SELLER_POLICY[r].includes(authz.action));
    if (wrongRole !== undefined) {
      const { token } = await t.seller(store, [wrongRole]);
      cases.push({ name: `member with role ${wrongRole} → 403`, req: withHeaders(happy, (h) => ({ ...h, ...bearer(token), "idempotency-key": idemKey(t) })), status: 403, code: "forbidden" });
    }
    const allowed = SELLER_ROLES.find((r) => SELLER_POLICY[r].includes(authz.action)) ?? "owner";
    const noPasskey = await t.seller(store, [allowed], ["otp"]);
    cases.push({ name: "member without passkey → 403", req: withHeaders(happy, (h) => ({ ...h, ...bearer(noPasskey.token) })), status: 403, code: "passkey-required" });
    const otherStore = await t.seller(store, [allowed]);
    cases.push({ name: "X-Store-Id of a store the caller is not a member of → 404", req: withHeaders(happy, (h) => ({ ...h, ...bearer(otherStore.token), "x-store-id": t.seed.storeB })), status: 404 });
    const shopper = await t.mint({ amr: ["otp", "passkey"] });
    cases.push({ name: "shopper (no membership) → 404", req: withHeaders(happy, (h) => ({ ...h, ...bearer(shopper) })), status: 404 });
    if (route.pathParams.some((p) => p !== "market")) {
      if (fx.otherTenant === undefined) throw new Error(`${route.method} ${route.openapiPath}: store-tenant route with ids needs an 'otherTenant' fixture (store A member → store B's object)`);
      cases.push({ name: "member of store A → store B's object → 404", req: await fx.otherTenant(t), status: 404 });
    }
    cases.push({ name: "missing X-Store-Id → 400", req: withHeaders(happy, without("x-store-id")), status: 400, code: "store-scope-required" });
  } else {
    if (!SHOPPER_ACTIONS.includes(authz.action)) {
      const shopper = await t.mint();
      cases.push({ name: "shopper on a non-shopper action → 403", req: withHeaders(happy, (h) => ({ ...h, ...bearer(shopper) })), status: 403 });
    }
    if (route.pathParams.some((p) => p !== "market")) {
      if (fx.otherTenant === undefined) throw new Error(`${route.method} ${route.openapiPath}: user-tenant route with ids needs an 'otherTenant' fixture`);
      cases.push({ name: "another user's object → 404", req: await fx.otherTenant(t), status: 404 });
    }
  }
  return cases;
};

/** Runs every case and asserts status (and problem code where fixed). Returns the cases for reporting. */
export const expectNegativeAuthz = async (t: TestApp, route: RouteDef, fx: RouteFixture): Promise<AuthzCase[]> => {
  const cases = await negativeAuthzCases(t, route, fx);
  for (const c of cases) {
    const res = await t.inject(c.req);
    expect.soft(res.statusCode, `${route.method} ${route.openapiPath}: ${c.name} (${res.body})`).toBe(c.status);
    if (c.status >= 400) expect.soft(res.headers["content-type"], `${c.name}: problem content type`).toContain("application/problem+json");
    if (c.code !== undefined) expect.soft((JSON.parse(res.body) as { code?: string }).code, c.name).toBe(c.code);
  }
  return cases;
};

/** Business statements on the app pool for one request must stay within the route's declared maxQueries. */
export const expectQueryCount = async (t: TestApp, route: RouteDef, fx: RouteFixture): Promise<number> => {
  const h = await fx.happy(t);
  if (h.warmup === true) await t.inject(h.req);
  t.counter.reset();
  const res = await t.inject(h.req);
  expect(res.statusCode, `${route.method} ${route.openapiPath} happy path: ${res.body}`).toBe(h.status);
  const max = route.contract?.maxQueries ?? 0;
  expect(t.counter.count, `${route.method} ${route.openapiPath} ran ${String(t.counter.count)} statements (max ${String(max)}):\n${t.counter.statements.join("\n---\n")}`).toBeLessThanOrEqual(max);
  return t.counter.count;
};

/**
 * Admin and system principals cannot be minted over HTTP yet (tokens verify as shoppers; the admin session is a tracked
 * TODO in ADR-0012), so their negative cases run against the same pure policy the PolicyGuard calls: a system principal
 * needs the exact scope, an admin needs a granting role, and super_admin grants nothing without break-glass.
 * Returns the number of cases checked.
 */
export const expectPolicyPrincipalDenials = (route: RouteDef): number => {
  const authz = route.authz;
  if (authz?.kind !== "authorize") return 0;
  const marketId = "EG";
  const resource = { type: "probe", marketId, storeId: "00000000-0000-4000-8000-0000000000a1", ownerUserId: "00000000-0000-4000-8000-0000000000b1" };
  const deny = (name: string, p: Principal, reason: "forbidden"): void => {
    const d = authorize(p, authz.action, resource);
    expect.soft(d, `${route.method} ${route.openapiPath}: ${name}`).toEqual({ effect: "deny", reason });
  };
  deny("system without the action scope → 403", { kind: "system", marketId, roles: [], scopes: [] }, "forbidden");
  deny("system with another scope → 403", { kind: "system", marketId, roles: [], scopes: ["unrelated.action"] }, "forbidden");
  deny("admin without roles → 403", { kind: "admin", userId: "a", marketId, roles: [], scopes: [] }, "forbidden");
  deny("super_admin without break-glass → 403", { kind: "admin", userId: "a", marketId, roles: ["super_admin"], scopes: [] }, "forbidden");
  const wrongMarket = authorize({ kind: "system", marketId: "ZZ", roles: [], scopes: [authz.action] }, authz.action, resource);
  expect.soft(wrongMarket, "system principal of another market → 404").toEqual({ effect: "deny", reason: "not_found" });
  return 5;
};
