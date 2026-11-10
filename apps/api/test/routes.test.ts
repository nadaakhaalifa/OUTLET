import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONTROLLERS } from "../src/controllers.js";
import { auditRoutes, collectRoutes, routeKey } from "../src/platform/route-registry.js";
import { createTestApp } from "./harness.js";
import type { TestApp } from "./harness.js";
import { expectNegativeAuthz, expectPolicyPrincipalDenials, expectQueryCount } from "./negative-authz.js";
import { ROUTE_FIXTURES } from "./route-fixtures.js";

const ROUTES = collectRoutes(CONTROLLERS);

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

describe("production route table", () => {
  it("passes the route audit (policy, rate limit, contract, pagination, reason codes)", () => {
    expect(auditRoutes(ROUTES)).toEqual([]);
  });

  it("every route has a fixture, and no fixture is stale", () => {
    expect(ROUTES.map(routeKey).filter((k) => !(k in ROUTE_FIXTURES))).toEqual([]);
    expect(Object.keys(ROUTE_FIXTURES).filter((k) => !ROUTES.some((r) => routeKey(r) === k))).toEqual([]);
  });

  it("the running app serves exactly the audited routes (checked against Fastify's own registrations)", () => {
    const fastify = t.app.getHttpAdapter().getInstance();
    for (const r of ROUTES) expect(fastify.hasRoute({ method: r.method, url: r.path }), `${routeKey(r)} not registered`).toBe(true);
    // createApp already refused any registered route missing from the audit (onRoute), so no extras exist either.
    expect(t.routes.map(routeKey)).toEqual(ROUTES.map(routeKey));
  });
});

describe.each(ROUTES.map((r) => [routeKey(r), r] as const))("%s", (key, route) => {
  const fx = ROUTE_FIXTURES[key];
  it("negative authorization (anonymous 401, wrong role 403, other tenant 404)", async () => {
    if (fx === undefined) throw new Error(`no fixture for ${key}`);
    const cases = await expectNegativeAuthz(t, route, fx);
    expect(cases.length).toBeGreaterThan(0);
  });
  it("admin and system principals are denied without grants (policy level)", () => {
    expectPolicyPrincipalDenials(route);
  });
  it("query count within maxQueries", async () => {
    if (fx === undefined) throw new Error(`no fixture for ${key}`);
    await expectQueryCount(t, route, fx);
  });
});
