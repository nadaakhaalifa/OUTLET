import { randomUUID } from "node:crypto";
import { brandClient } from "@outlet/db";
import type { Queryable, RoleSqlClient } from "@outlet/db";
import { roleClient } from "@outlet/db/testing";
import { createLogger } from "@outlet/logger";
import { ADMIN_POLICY, ADMIN_ROLES } from "@outlet/policy";
import type { Principal } from "@outlet/policy";
import { RollupService, SNAPSHOT_TILE_KEYS } from "@outlet/reporting";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DashboardService, PgDashboardReader, STALE_AFTER_MS } from "../src/modules/admin/index.js";
import type { AdminServices, DashboardReaderPort } from "../src/modules/admin/index.js";
import { DashboardResponse } from "../src/modules/admin/dto-dashboard.js";
import { seedApproval, seedAttention, seedElevation, seedKycCase } from "./admin-fixtures.js";
import { bearer, createTestApp, T0 } from "./harness.js";
import type { TestApp } from "./harness.js";

const NOW = new Date(T0);
const ISO = (d: Date): string => d.toISOString();
const logs: string[] = [];
const logger = createLogger({ write: (l) => logs.push(l), level: "debug" });
const market = (): { timezone: string; currency: string } => ({ timezone: "Africa/Cairo", currency: "EGP" });

/** The action(s) behind every tile, written out here on purpose (not imported): a change in the production map must break this test visibly. */
const TILE_ACTION: Readonly<Record<string, string>> = {
  orders_today: "order.read", gmv_today: "finance.summary.read", sales_series: "order.read|finance.summary.read", orders_by_step: "order.read", top_stores: "finance.summary.read",
  verified_discount_share: "price_integrity.read", seller_sla_breaches: "order.read", cod_awaiting_confirmation: "order.read", returns_pipeline: "return.read", disputes_open: "dispute.decide",
  refunds_waiting: "refund.approve", refunds_overdue: "refund.approve", payouts: "payout.read", recon_unmatched: "finance.summary.read", cod_unremitted: "finance.summary.read",
  ledger_integrity: "finance.summary.read", kyc_queue: "seller_kyc.review", stores_moderation: "store.read", price_enforcement: "price_integrity.read", listings_by_status: "listing.read",
  breaches_open: "breach.manage", dsar_queue: "breach.manage", attention_open: "attention.read", approvals_pending: "approval.read", elevations_active: "elevation.request", kill_switches: "kill_switch.read",
};
const NOT_CONNECTED = new Set(["cod_unremitted", "ledger_integrity"]);

interface AnyTile { key: string; status: string; reason?: string; data?: unknown; as_of?: string }
const tilesOf = (r: DashboardResponse): Record<string, AnyTile> => {
  const out: Record<string, AnyTile> = {};
  for (const section of Object.values(r.sections)) for (const t of Object.values(section)) out[(t as AnyTile).key] = t as AnyTile;
  return out;
};

const snapshotPayloads: Readonly<Record<string, unknown>> = {
  orders_by_step: { paid_awaiting_accept: 2, accepted: 1, packed: 0, in_transit: 3, delivery_failed: 0 },
  seller_sla_breaches: { late_accept: 1, late_dispatch: 0, oldest_at: "2029-12-31T10:00:00.000Z" },
  cod_awaiting_confirmation: { count: 4, oldest_at: null },
  returns_pipeline: { requested: 1, in_transit: 0, awaiting_inspection: 2, inspection_overdue: 1 },
  disputes_open: { open: 1, past_sla: 0, oldest_at: null },
  refunds_waiting: { count: 2, amount: { amount_minor: "2000", currency: "EGP" }, manual_review: 1, failed: 0, oldest_at: null },
  refunds_overdue: { count: 0, amount: { amount_minor: "0", currency: "EGP" }, oldest_due_at: null },
  payouts: { due_count: 1, due_net: { amount_minor: "500", currency: "EGP" }, on_hold_count: 0, on_hold_net: { amount_minor: "0", currency: "EGP" }, failed: 0, open_holds: 0 },
  recon_unmatched: { open: 1, escalated: 0, aged_over_3d: 0, oldest_at: null },
  stores_moderation: { pending_review: 1, suspended: 0 },
  price_enforcement: { active: 2, pending_review: 0, suspensions_awaiting_review: 0 },
  verified_discount_share: { verified: 3, live_skus: 10 },
  listings_by_status: { published: 9, in_review: 1, paused: 0, blocked: 0 },
  breaches_open: { open: 0, next_pdpc_deadline_at: null, next_subjects_deadline_at: null },
  dsar_queue: { open: 1, due_7d: 1, overdue: 0 },
};

/** Fake readers that record every call, so a forbidden tile can be shown to cost nothing. */
const fakes = (o: { asOf?: Date; throwOn?: string; noDashboard?: boolean } = {}): { services: AdminServices; calls: string[] } => {
  const calls: string[] = [];
  const asOf = ISO(o.asOf ?? NOW);
  const hit = <T>(name: string, v: T): Promise<T> => {
    calls.push(name);
    return o.throwOn === name ? Promise.reject(new Error("boom")) : Promise.resolve(v);
  };
  const dashboard: DashboardReaderPort = {
    snapshots: (_m, keys) => { calls.push(`snapshots:${[...keys].sort().join(",")}`); return o.throwOn === "snapshots" ? Promise.reject(new Error("boom")) : Promise.resolve(keys.map((k) => ({ key: k, asOf, version: 1, payload: snapshotPayloads[k] }))); },
    salesDaily: () => hit("sales", { rows: [{ day: "2030-01-01", orders: 4, gmvMinor: 12_345n, refundedMinor: 100n }, { day: "2029-12-31", orders: 2, gmvMinor: 5_000n, refundedMinor: 0n }], firstDay: "2029-12-30", refreshedAt: asOf }),
    storeSalesTop: () => hit("top", { items: [{ storeId: randomUUID(), nameAr: "متجر", nameEn: null, orders: 4, gmvMinor: 12_345n }], other: { stores: 0, orders: 0, gmvMinor: 0n }, asOf }),
  };
  const services = {
    access: {}, reconciliation: {},
    approvals: { countPending: () => hit("approvals", { forMe: 2, soonestExpiresAt: "2030-01-02T00:00:00.000Z" }) },
    kyc: { count: () => hit("kyc", { submitted: 3, needsInfo: 1, oldestAt: null }) },
    ...(o.noDashboard === true ? {} : { dashboard }),
    ops: {
      flags: { list: () => hit("flags", [{ key: "payments.cod.enabled", marketId: "EG", enabled: false, rules: {}, version: 1 }]) },
      audit: {},
      elevations: { countActive: () => hit("elevations", { active: 1, pending: 2 }) },
      attention: { countOpen: () => hit("attention", { open: 2, acked: 1, byKind: { "refund.attention": 3 }, oldestAt: "2029-12-31T10:00:00.000Z" }) },
    },
  } as unknown as AdminServices;
  return { services, calls };
};

const principal = (role: string, breakGlass?: boolean): Principal => ({ kind: "admin", userId: randomUUID(), marketId: "EG", roles: [role], scopes: [], ...(breakGlass === undefined ? {} : { breakGlass }) });
const build = (services: AdminServices, p: Principal, range: "7d" | "30d" | "90d" = "30d", now: Date = NOW): Promise<DashboardResponse> =>
  new DashboardService(services, { now: () => now, logger, market }).build(p, "EG", { range });

describe("DashboardService role matrix (expected statuses come from ADMIN_POLICY)", () => {
  const cases: [string, Principal][] = [...ADMIN_ROLES.map((r): [string, Principal] => [r, principal(r)]), ["super_admin (break-glass)", principal("super_admin", true)]];
  for (const [name, p] of cases) {
    it(`${name}: exactly the policy's tiles are ok, the rest forbidden, the shape always validates`, async () => {
      const { services } = fakes();
      const res = await build(services, p);
      expect(() => DashboardResponse.parse(res)).not.toThrow();
      const role = p.roles[0] ?? "";
      const live = role !== "super_admin" || p.breakGlass === true;
      const granted = (action: string): boolean => live && ADMIN_POLICY[role as (typeof ADMIN_ROLES)[number]].includes(action);
      const tiles = tilesOf(res);
      expect(Object.keys(tiles).sort()).toEqual(Object.keys(TILE_ACTION).sort());
      for (const [key, actions] of Object.entries(TILE_ACTION)) {
        const allowed = actions.split("|").some(granted);
        const want = !allowed ? "forbidden" : NOT_CONNECTED.has(key) ? "unavailable" : "ok";
        expect(tiles[key]?.status, `${name} ${key}`).toBe(want);
        if (want === "unavailable") expect(tiles[key]?.reason).toBe("not_connected");
      }
    });
  }

  it("finance sees GMV (orders, GMV, top stores); ops sees orders but gmv_today is forbidden and the GMV series is null", async () => {
    const fin = tilesOf(await build(fakes().services, principal("finance")));
    expect(fin.gmv_today).toMatchObject({ status: "ok", data: { gmv: { amount_minor: "12345", currency: "EGP" }, refunded: { amount_minor: "100", currency: "EGP" }, gmv_7d: { amount_minor: "17345", currency: "EGP" } } });
    expect(fin.top_stores?.status).toBe("ok");
    const ops = tilesOf(await build(fakes().services, principal("ops")));
    expect(ops.gmv_today).toEqual({ key: "gmv_today", status: "forbidden" });
    expect(ops.top_stores).toEqual({ key: "top_stores", status: "forbidden" });
    expect(ops.orders_today).toMatchObject({ status: "ok", data: { count: 4 } });
    expect(ops.sales_series).toMatchObject({ status: "ok", data: { gmv: null, total_gmv: null, total_orders: 6 } });
  });

  it("a forbidden tile issues ZERO reads: ops never touches the GMV, top-store, refund, payout or privacy reads; marketing reads nothing from the rollups", async () => {
    const o = fakes();
    await build(o.services, principal("ops"));
    expect(o.calls).toContain("sales");
    expect(o.calls).not.toContain("top");
    const snap = o.calls.find((c) => c.startsWith("snapshots:")) ?? "";
    expect(snap).toBe("snapshots:cod_awaiting_confirmation,listings_by_status,orders_by_step,price_enforcement,returns_pipeline,seller_sla_breaches,stores_moderation,verified_discount_share");
    expect(o.calls.filter((c) => ["flags", "attention", "kyc", "approvals", "elevations"].includes(c)).sort()).toEqual(["approvals", "attention", "elevations", "kyc"]);
    const m = fakes();
    await build(m.services, principal("marketing"));
    expect(m.calls.sort()).toEqual(["approvals", "elevations"]);
  });

  it("super_admin without break-glass is forbidden everywhere and reads nothing", async () => {
    const o = fakes();
    const res = await build(o.services, principal("super_admin"));
    expect(Object.values(tilesOf(res)).every((t) => t.status === "forbidden")).toBe(true);
    expect(o.calls).toEqual([]);
  });

  it("the widest real role set (finance + ops tiles) stays within the 10-statement budget", async () => {
    const o = fakes();
    await build(o.services, { ...principal("finance"), roles: ["finance", "ops", "trust_safety", "security"] });
    expect(o.calls.length).toBeLessThanOrEqual(10);
  });
});

describe("DashboardService failure and freshness rules (never a made-up zero)", () => {
  it("a reader that throws makes only its tiles unavailable/read_failed and logs the tile key; the others stay ok", async () => {
    logs.length = 0;
    const res = tilesOf(await build(fakes({ throwOn: "kyc" }).services, principal("ops")));
    expect(res.kyc_queue).toEqual({ key: "kyc_queue", status: "unavailable", reason: "read_failed" });
    expect(res.orders_by_step?.status).toBe("ok");
    expect(logs.join("\n")).toMatch(/kyc_queue/);
    const sales = tilesOf(await build(fakes({ throwOn: "sales" }).services, principal("finance")));
    expect(sales.gmv_today).toMatchObject({ status: "unavailable", reason: "read_failed" });
    expect(sales.recon_unmatched?.status).toBe("ok");
    const snap = tilesOf(await build(fakes({ throwOn: "snapshots" }).services, principal("finance")));
    expect(snap.payouts).toMatchObject({ status: "unavailable", reason: "read_failed" });
  });

  it("a snapshot older than 15 minutes is unavailable/stale (sales and snapshots alike); exactly at the limit still shows", async () => {
    const old = new Date(NOW.getTime() - STALE_AFTER_MS - 1000);
    const stale = tilesOf(await build(fakes({ asOf: old }).services, principal("finance")));
    for (const k of ["orders_today", "gmv_today", "payouts", "top_stores", "sales_series"]) expect(stale[k], k).toMatchObject({ status: "unavailable", reason: "stale" });
    expect(stale.approvals_pending?.status).toBe("ok");
    const edge = tilesOf(await build(fakes({ asOf: new Date(NOW.getTime() - STALE_AFTER_MS) }).services, principal("finance")));
    expect(edge.payouts?.status).toBe("ok");
  });

  it("no rollup composed or never run: snapshot and sales tiles are not_connected, live tiles still answer", async () => {
    const none = tilesOf(await build(fakes({ noDashboard: true }).services, principal("ops")));
    expect(none.orders_today).toEqual({ key: "orders_today", status: "unavailable", reason: "not_connected" });
    expect(none.orders_by_step).toEqual({ key: "orders_by_step", status: "unavailable", reason: "not_connected" });
    expect(none.kyc_queue?.status).toBe("ok");
    const empty: AdminServices = { ...fakes().services, dashboard: { snapshots: () => Promise.resolve([]), salesDaily: () => Promise.resolve({ rows: [], firstDay: null, refreshedAt: null }), storeSalesTop: () => Promise.resolve({ items: [], other: { stores: 0, orders: 0, gmvMinor: 0n }, asOf: null }) } };
    const e = tilesOf(await build(empty, principal("finance")));
    expect(e.orders_today).toMatchObject({ status: "unavailable", reason: "not_connected" });
    expect(e.payouts).toMatchObject({ status: "unavailable", reason: "not_connected" });
    expect(e.top_stores).toMatchObject({ status: "unavailable", reason: "not_connected" });
  });

  it("an unreadable snapshot payload or an unknown version is read_failed, not shown", async () => {
    const svc = fakes().services;
    const bad: AdminServices = { ...svc, dashboard: { ...(svc.dashboard!), snapshots: (_m, keys) => Promise.resolve(keys.map((k) => ({ key: k, asOf: ISO(NOW), version: k === "payouts" ? 2 : 1, payload: k === "orders_by_step" ? { nope: 1 } : snapshotPayloads[k] }))) } };
    const t = tilesOf(await build(bad, principal("finance")));
    expect(t.orders_by_step).toMatchObject({ status: "unavailable", reason: "read_failed" });
    expect(t.payouts).toMatchObject({ status: "unavailable", reason: "read_failed" });
    expect(t.refunds_waiting?.status).toBe("ok");
  });

  it("series start at the first rolled-up day (nothing before it is invented) and quiet days inside the window are zero", async () => {
    const o = fakes();
    const svc = o.services.dashboard!;
    const sparse: AdminServices = { ...o.services, dashboard: { ...svc, salesDaily: () => Promise.resolve({ rows: [{ day: "2029-12-30", orders: 1, gmvMinor: 10n, refundedMinor: 0n }, { day: "2030-01-01", orders: 3, gmvMinor: 30n, refundedMinor: 0n }], firstDay: "2029-12-30", refreshedAt: ISO(NOW) }) } };
    const t = tilesOf(await build(sparse, principal("finance"), "7d"));
    expect(t.sales_series).toMatchObject({ data: { orders: [{ day: "2029-12-30", value: 1 }, { day: "2029-12-31", value: 0 }, { day: "2030-01-01", value: 3 }], total_orders: 4, total_gmv: { amount_minor: "40", currency: "EGP" } } });
    expect(t.orders_today).toMatchObject({ data: { count: 3, series_14d: [{ day: "2029-12-30", value: 1 }, { day: "2029-12-31", value: 0 }, { day: "2030-01-01", value: 3 }] } });
  });

  it("kill switches: only registered switches whose effective row is disabled, split by class", async () => {
    const t = tilesOf(await build(fakes().services, principal("security")));
    expect(t.kill_switches).toMatchObject({ status: "ok", data: { engaged_money: ["payments.cod.enabled"], engaged_ui: [] } });
  });
});

describe("GET /v1/eg/admin/dashboard (HTTP, real readers on the test database)", () => {
  let t: TestApp;
  const wrapped = (): { client: RoleSqlClient<"outlet_worker">; statements: string[] } => {
    const statements: string[] = [];
    const base = roleClient(t.raw, "outlet_worker");
    const rec = (q: Queryable): Queryable => ({
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- matches the Queryable port signature
      query: <Row extends object>(sql: string, params?: readonly unknown[]) => { if (!sql.startsWith("SELECT set_config(")) statements.push(sql); return q.query<Row>(sql, params); },
    });
    return { statements, client: brandClient<"outlet_worker">({ query: (sql, p) => rec(base).query(sql, p), transaction: (fn) => base.transaction((tx) => fn(rec(tx))) }) };
  };
  const get = async (token: string, url = "/v1/eg/admin/dashboard"): Promise<{ status: number; body: unknown }> => {
    const r = await t.inject({ method: "GET", url, headers: bearer(token) });
    return { status: r.statusCode, body: JSON.parse(r.body) as unknown };
  };

  beforeAll(async () => {
    t = await createTestApp();
    // One real order through the real rollup, so the route is checked end to end (FKs relaxed only while seeding).
    await t.raw.query("SET session_replication_role = replica");
    const store = randomUUID();
    await t.raw.query("INSERT INTO stores (id, seller_id, market_id, slug, display_name_ar, display_name_en, kind, ships_from_country, status) VALUES ($1,$2,'EG','dash-store','متجر اللوحة','Dash Shop','local','EG','PENDING_REVIEW')", [store, randomUUID()]);
    const g = randomUUID();
    await t.raw.query(
      `INSERT INTO order_groups (id, user_id, market_id, currency, status, funds_flow, checkout_session_id, idempotency_key, payment_method, items_subtotal_minor, shipping_minor, shipping_vat_minor, vat_minor, total_minor, placed_at, paid_at)
       VALUES ($1,$2,'EG','EGP','PAID','collect_payout',$3,$4,'card',25000,0,0,0,25000,'2029-12-31T20:00:00Z','2029-12-31T20:05:00Z')`, [g, randomUUID(), randomUUID(), randomUUID()]);
    await t.raw.query(
      `INSERT INTO seller_orders (id, order_group_id, store_id, user_id, market_id, currency, status, funds_flow, items_subtotal_minor, shipping_minor, shipping_vat_minor, vat_minor, total_minor, commission_bp_snapshot, commission_minor, commission_vat_minor, seller_net_minor)
       VALUES ($1,$2,$3,$4,'EG','EGP','PAID','collect_payout',25000,0,0,0,25000,0,0,0,25000)`, [randomUUID(), g, store, randomUUID()]);
    await t.raw.query("SET session_replication_role = DEFAULT");
    const roll = new RollupService({ client: roleClient(t.raw, "outlet_worker"), now: () => NOW });
    await roll.run("EG", "2029-12-31");
    await roll.run("EG", "2030-01-01");
    await roll.snapshots("EG");
    await seedKycCase(t.raw, "SUBMITTED");
    await seedAttention(t.raw);
    await seedApproval(t.raw);
    await seedElevation(t.raw);
  });
  afterAll(async () => t.close());

  it("finance: GMV from the rollup (Cairo day), top stores, snapshot counts; cod_unremitted and ledger_integrity are not connected; every tile validates against the contract", async () => {
    const { token } = await t.admin(["finance"]);
    const r = await get(token);
    expect(r.status).toBe(200);
    const res = DashboardResponse.parse(r.body);
    const tiles = tilesOf(res);
    // 2029-12-31T20:05Z is 22:05 on 12-31 in Cairo (UTC+2): the order is on the 31st, today (01-01, 02:00 Cairo) has none.
    expect(res.today).toBe("2030-01-01");
    expect(tiles.gmv_today).toMatchObject({ status: "ok", data: { gmv: { amount_minor: "0" }, gmv_7d: { amount_minor: "25000", currency: "EGP" } } });
    expect(tiles.sales_series).toMatchObject({ status: "ok", data: { total_orders: 1, total_gmv: { amount_minor: "25000", currency: "EGP" } } });
    expect(tiles.top_stores).toMatchObject({ status: "ok", data: { items: [{ name_ar: "متجر اللوحة", name_en: "Dash Shop", orders: 1, gmv: { amount_minor: "25000" } }], other: { stores: 0 } } });
    expect(tiles.recon_unmatched).toMatchObject({ status: "ok", data: { open: 0, escalated: 0 } });
    expect(tiles.stores_moderation).toEqual({ key: "stores_moderation", status: "forbidden" });
    expect(tiles.orders_by_step).toMatchObject({ status: "ok" });
    expect(tiles.cod_unremitted).toEqual({ key: "cod_unremitted", status: "unavailable", reason: "not_connected" });
    expect(tiles.attention_open).toMatchObject({ status: "ok", data: { open: 1, acked: 0, by_kind: { "refund.attention": 1 } } });
    expect(tiles.approvals_pending).toMatchObject({ status: "ok" });
  });

  it("ops: orders and queues but no money (gmv_today forbidden, GMV series null); kyc and attention counts are live", async () => {
    const { token } = await t.admin(["ops"]);
    const tiles = tilesOf(DashboardResponse.parse((await get(token)).body));
    expect(tiles.gmv_today).toEqual({ key: "gmv_today", status: "forbidden" });
    expect(tiles.top_stores?.status).toBe("forbidden");
    expect(tiles.sales_series).toMatchObject({ status: "ok", data: { gmv: null, total_gmv: null, total_orders: 1 } });
    expect(tiles.kyc_queue).toMatchObject({ status: "ok", data: { submitted: 1, needs_info: 0 } });
    expect(tiles.orders_by_step).toMatchObject({ status: "ok", data: { paid_awaiting_accept: 1 } });
    expect(tiles.stores_moderation).toMatchObject({ status: "ok", data: { pending_review: 1, suspended: 0 } });
  });

  it("support: orders/returns and approvals, nothing financial; marketing: an almost empty Home", async () => {
    const sup = tilesOf(DashboardResponse.parse((await get((await t.admin(["support"])).token)).body));
    expect(Object.entries(sup).filter(([, v]) => v.status === "ok").map(([k]) => k).sort()).toEqual(["approvals_pending", "cod_awaiting_confirmation", "elevations_active", "orders_by_step", "orders_today", "returns_pipeline", "sales_series", "seller_sla_breaches"]);
    const mk = tilesOf(DashboardResponse.parse((await get((await t.admin(["marketing"])).token)).body));
    expect(Object.entries(mk).filter(([, v]) => v.status === "ok").map(([k]) => k).sort()).toEqual(["approvals_pending", "elevations_active"]);
  });

  it("shopper and seller principals get 403, no token 401, an unknown range 400, another market 404", async () => {
    const shopper = await t.shopper();
    expect((await get(shopper.token)).status).toBe(403);
    const seller = await t.seller(t.seed.storeA, ["owner"]);
    expect((await get(seller.token)).status).toBe(403);
    expect((await t.inject({ method: "GET", url: "/v1/eg/admin/dashboard" })).statusCode).toBe(401);
    const { token } = await t.admin(["finance"]);
    for (const range of ["1y", "7", "", "30D"]) expect((await get(token, `/v1/eg/admin/dashboard?range=${range}`)).status, range).toBe(400);
    expect((await get(token, "/v1/eg/admin/dashboard?range=7d&extra=1")).status).toBe(400);
    expect((await get(token, "/v1/zz/admin/dashboard")).status).toBe(404);
    expect((await get(token, "/v1/eg/admin/dashboard?range=90d")).status).toBe(200);
  });

  it("stale snapshots read as unavailable/stale over HTTP once the clock moves 20 minutes on", async () => {
    const fin = await t.admin(["finance"]);
    t.clock.now += 20 * 60_000;
    try {
      const token = await t.mint({ userId: fin.userId, amr: ["otp", "passkey"] });
      const tiles = tilesOf(DashboardResponse.parse((await get(token)).body));
      expect(tiles.payouts).toMatchObject({ status: "unavailable", reason: "stale" });
      expect(tiles.gmv_today).toMatchObject({ status: "unavailable", reason: "stale" });
      expect(tiles.approvals_pending?.status).toBe("ok");
    } finally {
      t.clock.now -= 20 * 60_000;
    }
  });

  it("statement budget: finance and ops stay within 10 statements counting the worker pool as well as the app pool", async () => {
    const { client, statements } = wrapped();
    const svc = new DashboardService({ ...fakes().services, dashboard: new PgDashboardReader(client) }, { now: () => NOW, logger, market });
    await svc.build({ ...principal("finance"), roles: ["finance", "ops"] }, "EG", { range: "90d" });
    expect(statements.length).toBeLessThanOrEqual(4); // snapshots, sales, top stores, stored ledger_integrity run
    expect(statements.every((s) => /admin_dashboard_snapshots|market_sales_daily|store_sales_daily|reconciliation_runs/.test(s))).toBe(true);
    // live readers are fakes here; the real ones run (and are counted by the route fixture) in routes.test.ts.
  });

  it("the snapshot payload table agrees with the tile list the service reads", () => {
    expect(SNAPSHOT_TILE_KEYS.slice().sort()).toEqual(Object.keys(snapshotPayloads).sort());
  });
});
