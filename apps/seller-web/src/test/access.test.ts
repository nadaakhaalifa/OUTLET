import { describe, expect, it } from "vitest";
import { createSellerApi } from "../api/client";
import { SELLER_PERMISSION_KEYS } from "../api/schemas-access";
import type { BRAND_ROLES_FOR_TEST } from "./role-list";
import { FakeSession } from "../session/fake";
import { loadAccess, roleNavEnabled, type Access } from "../view-models/access";
import { navFor, navForAccess } from "../view-models/nav";
import { fakeTransport, json, UUID_A, UUID_B } from "./fake-transport";
import { NO_PERMISSIONS, permissionsFor } from "./permissions";

const NOW = Date.parse("2026-10-11T10:00:00Z");
const api = (routes: Parameters<typeof fakeTransport>[0]) => {
  const transport = fakeTransport(routes);
  const session = new FakeSession({ initial: { accessToken: "t", refreshToken: "r", accessExpiresAtMs: NOW + 600_000, secondFactorRequired: false } });
  return { api: createSellerApi({ transport, session, newIdempotencyKey: () => "k" }), calls: transport.calls };
};
const me = (role: (typeof BRAND_ROLES_FOR_TEST)[number], status: "active" | "suspended" | "paused" | "draft" = "active", off = false) => ({
  user_id: UUID_B,
  membership: { store_id: UUID_A, role, store_status: status, permissions: off ? NO_PERMISSIONS : permissionsFor(role) },
  server_time: "2026-10-11T10:00:00Z",
});
const hrefs = (a: Access) => navForAccess(a).map((i) => i.href);

describe("release flag", () => {
  it("is blocked unless the env mirror says on", () => {
    expect(roleNavEnabled({})).toBe(false);
    expect(roleNavEnabled({ SELLER_RELEASE_ROLE_NAV: "off" })).toBe(false);
    expect(roleNavEnabled({ SELLER_RELEASE_ROLE_NAV: "ON" })).toBe(true);
  });
  it("flag blocked: no API call, every link shows", async () => {
    const t = api({});
    const a = await loadAccess({ api: t.api, enabled: false, storeIdHint: UUID_A });
    expect(a).toEqual({ kind: "open" });
    expect(t.calls).toEqual([]);
    expect(hrefs(a)).toEqual(navFor(null).map((i) => i.href));
  });
});

describe("loadAccess (flag on)", () => {
  it("uses the store id hint and the server answer, never a client-side role", async () => {
    const t = api({ [`GET /v1/seller/stores/${UUID_A}/me`]: () => json(me("warehouse")) });
    const a = await loadAccess({ api: t.api, enabled: true, storeIdHint: UUID_A });
    expect(a).toMatchObject({ kind: "granted", role: "warehouse", storeStatus: "active", storeId: UUID_A });
    expect(t.calls.map((c) => c.path)).toEqual([`/v1/seller/stores/${UUID_A}/me`]);
  });
  it("without a hint, resolves the store first", async () => {
    const t = api({
      "GET /v1/seller/store": () => json({ id: UUID_A, slug: "s", name: { ar: "م" }, status: "active", legal_identity: { legal_name: "L" }, kyc_status: "APPROVED" }),
      [`GET /v1/seller/stores/${UUID_A}/me`]: () => json(me("owner")),
    });
    expect((await loadAccess({ api: t.api, enabled: true, storeIdHint: null })).kind).toBe("granted");
  });
  it("404 for the store is one no_access state (foreign, removed and missing look the same)", async () => {
    const t = api({ [`GET /v1/seller/stores/${UUID_B}/me`]: () => json({ title: "Not found" }, 404) });
    const a = await loadAccess({ api: t.api, enabled: true, storeIdHint: UUID_B });
    expect(a).toEqual({ kind: "no_access" });
    expect(navForAccess(a)).toEqual([]);
  });
  it("5xx, offline, malformed body and missing API fail closed to the dashboard only", async () => {
    for (const routes of [
      { [`GET /v1/seller/stores/${UUID_A}/me`]: () => json({}, 503) },
      { [`GET /v1/seller/stores/${UUID_A}/me`]: () => "network" as const },
      { [`GET /v1/seller/stores/${UUID_A}/me`]: () => json({ nope: true }) },
    ]) {
      const a = await loadAccess({ api: api(routes).api, enabled: true, storeIdHint: UUID_A });
      expect(a).toEqual({ kind: "unavailable" });
      expect(hrefs(a)).toEqual(["/dashboard"]);
    }
    expect(await loadAccess({ api: null, enabled: true, storeIdHint: UUID_A })).toEqual({ kind: "unavailable" });
  });
  it("suspended store: status is carried and the permissions the server sent (all false) hide every link", async () => {
    const t = api({ [`GET /v1/seller/stores/${UUID_A}/me`]: () => json(me("owner", "suspended", true)) });
    const a = await loadAccess({ api: t.api, enabled: true, storeIdHint: UUID_A });
    expect(a).toMatchObject({ kind: "granted", storeStatus: "suspended" });
    expect(hrefs(a)).toEqual([]);
  });
  it("a body with an unknown or missing permission key is a contract failure (fail closed)", async () => {
    const bad = me("owner");
    const { "analytics.export": _x, ...rest } = bad.membership.permissions;
    const t = api({ [`GET /v1/seller/stores/${UUID_A}/me`]: () => json({ ...bad, membership: { ...bad.membership, permissions: rest } }) });
    expect(await loadAccess({ api: t.api, enabled: true, storeIdHint: UUID_A })).toEqual({ kind: "unavailable" });
  });
});

describe("nav by permission", () => {
  const nav = (role: (typeof BRAND_ROLES_FOR_TEST)[number]) => navFor(permissionsFor(role)).map((i) => i.href);
  it("warehouse role shows exactly the permitted items and Finance is absent", () => {
    expect(nav("warehouse")).toEqual([
      "/dashboard", "/catalog", "/orders", "/returns", "/drops", "/insights", "/media", "/forecasts", "/channels", "/hub", "/price-trust",
    ]);
    expect(nav("warehouse")).not.toContain("/finance");
  });
  it("role matrix nav snapshot", () => {
    expect(nav("finance")).toEqual(["/dashboard", "/catalog", "/orders", "/finance", "/drops", "/insights", "/media", "/forecasts", "/channels", "/hub", "/price-trust"]);
    expect(nav("support")).toEqual(["/dashboard", "/catalog", "/orders", "/returns", "/drops", "/insights", "/media", "/forecasts", "/channels", "/hub", "/price-trust"]);
    expect(nav("catalog")).toEqual(["/catalog", "/drops", "/insights", "/media", "/forecasts", "/channels", "/price-trust"]);
    expect(nav("manager")).toEqual(navFor(null).map((i) => i.href));
    expect(nav("owner")).toEqual(navFor(null).map((i) => i.href));
  });
  it("no role name appears in nav.ts (permission-keyed only)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../view-models/nav.ts", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(src).not.toMatch(/fulfilment|"warehouse"|"support"|"owner"/);
  });
  it("every permission key is listed once", () => {
    expect(new Set(SELLER_PERMISSION_KEYS).size).toBe(20);
  });
});
