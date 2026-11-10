import { randomUUID } from "node:crypto";
import { createLogger } from "@outlet/logger";
import type { Principal } from "@outlet/policy";
import { describe, expect, it } from "vitest";
import { DashboardService } from "../src/modules/admin/index.js";
import type { AdminServices, DashboardReaderPort } from "../src/modules/admin/index.js";
import type { DashboardResponse } from "../src/modules/admin/dto-dashboard.js";
import { T0 } from "./harness.js";

const NOW = new Date(T0);
const ASOF = NOW.toISOString();
const market = (): { timezone: string; currency: string } => ({ timezone: "Africa/Cairo", currency: "EGP" });
const admin = (role: string): Principal => ({ kind: "admin", userId: randomUUID(), marketId: "EG", roles: [role], scopes: [] });

interface Tile { key: string; status: string; reason?: string; data?: Record<string, unknown> }
const tiles = (r: DashboardResponse): Record<string, Tile> => {
  const out: Record<string, Tile> = {};
  for (const s of Object.values(r.sections)) for (const t of Object.values(s)) out[(t as Tile).key] = t as Tile;
  return out;
};
const reader = (o: Partial<DashboardReaderPort> = {}): DashboardReaderPort => ({
  snapshots: () => Promise.resolve([]),
  salesDaily: () => Promise.resolve({ rows: [], firstDay: "2029-12-01", refreshedAt: ASOF }),
  storeSalesTop: () => Promise.resolve({ items: [], other: { stores: 0, orders: 0, gmvMinor: 0n }, asOf: ASOF }),
  ...o,
});
const base = { approvals: { countPending: () => Promise.resolve({ forMe: 0, soonestExpiresAt: null }) }, kyc: { count: () => Promise.resolve({ submitted: 0, needsInfo: 0, oldestAt: null }) } };
const svc = (services: Record<string, unknown>, logs: string[] = []): DashboardService =>
  new DashboardService({ access: {}, reconciliation: {}, ...base, ...services } as unknown as AdminServices, { now: () => NOW, logger: createLogger({ write: (l) => logs.push(l), level: "debug" }), market });

describe("dashboard branches", () => {
  it("a rejected read that is not an Error is logged as 'unknown' and only its own tiles fail", async () => {
    const logs: string[] = [];
    const res = await svc({
      dashboard: reader({
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the point: a reader that rejects with a non-Error value
        storeSalesTop: () => Promise.reject("plain string"),
      }),
    }, logs).build(admin("finance"), "EG", { range: "7d" });
    const t = tiles(res);
    expect(t.top_stores).toMatchObject({ status: "unavailable", reason: "read_failed" });
    expect(t.gmv_today?.status).toBe("ok");
    expect(logs.join("\n")).toContain('"error":"unknown"');
    expect(logs.join("\n")).toContain('"tile":"top_stores"');
  });

  it("without a dashboard reader the sales, snapshot and top-store tiles are not connected, not zero", async () => {
    const t = tiles(await svc({}).build(admin("finance"), "EG", { range: "30d" }));
    for (const k of ["orders_today", "gmv_today", "sales_series", "top_stores", "refunds_waiting", "payouts"]) expect(t[k], k).toMatchObject({ status: "unavailable", reason: "not_connected" });
  });

  it("with no ops services, or ops without elevations and attention, the platform tiles are not connected", async () => {
    const none = tiles(await svc({}).build(admin("finance"), "EG", { range: "7d" }));
    expect(none.kill_switches).toMatchObject({ status: "unavailable", reason: "not_connected" });
    expect(none.attention_open).toMatchObject({ status: "unavailable", reason: "not_connected" });
    expect(none.elevations_active).toMatchObject({ status: "unavailable", reason: "not_connected" });
    const partial = tiles(await svc({ ops: { flags: { list: () => Promise.resolve([]) } } }).build(admin("finance"), "EG", { range: "7d" }));
    expect(partial.elevations_active).toMatchObject({ status: "unavailable", reason: "not_connected" });
    expect(partial.attention_open).toMatchObject({ status: "unavailable", reason: "not_connected" });
    expect(partial.kill_switches).toMatchObject({ status: "ok", data: { engaged_money: [], engaged_ui: [] } });
  });

  it("a quiet today inside the covered window reads as 0 (not a missing tile), and an engaged UI switch is listed apart from money switches", async () => {
    const flags = [
      { key: "drops.enabled", marketId: null, enabled: false, rules: {}, version: 1 },
      { key: "payments.cod.enabled", marketId: "EG", enabled: false, rules: {}, version: 1 },
      { key: "search.engine.enabled", marketId: "EG", enabled: true, rules: {}, version: 1 },
    ];
    const res = await svc({ dashboard: reader({ salesDaily: () => Promise.resolve({ rows: [{ day: "2029-12-30", orders: 3, gmvMinor: 700n, refundedMinor: 0n }], firstDay: "2029-12-01", refreshedAt: ASOF }) }), ops: { flags: { list: () => Promise.resolve(flags) } } }).build(admin("finance"), "EG", { range: "7d" });
    const t = tiles(res);
    expect(t.orders_today).toMatchObject({ status: "ok", data: { count: 0 } });
    expect(t.gmv_today).toMatchObject({ status: "ok", data: { gmv: { amount_minor: "0", currency: "EGP" }, refunded: { amount_minor: "0" }, gmv_7d: { amount_minor: "700" } } });
    const series = t.orders_today?.data?.series_14d as { day: string; value: number }[];
    expect(series).toHaveLength(14);
    expect(series.find((p) => p.day === "2029-12-30")?.value).toBe(3);
    expect(series.at(-1)).toEqual({ day: "2030-01-01", value: 0 });
    expect(t.kill_switches).toMatchObject({ status: "ok" });
  });

  it("kill switches: the market row wins over the global one, UI and money classes are split", async () => {
    const flags = [
      { key: "drops.enabled", marketId: null, enabled: false, rules: {}, version: 1 },
      { key: "payments.cod.enabled", marketId: "EG", enabled: false, rules: {}, version: 1 },
      { key: "search.engine.enabled", marketId: null, enabled: false, rules: {}, version: 1 },
      { key: "search.engine.enabled", marketId: "EG", enabled: true, rules: {}, version: 1 },
    ];
    const t = tiles(await svc({ ops: { flags: { list: () => Promise.resolve(flags) } } }).build(admin("finance"), "EG", { range: "7d" }));
    expect(t.kill_switches).toMatchObject({ status: "ok", data: { engaged_ui: ["drops.enabled"], engaged_money: ["payments.cod.enabled"] } });
    // a role without kill_switch.read never reaches the flag read: the tile is forbidden
    const calls: string[] = [];
    const sup = tiles(await svc({ ops: { flags: { list: () => { calls.push("flags"); return Promise.resolve(flags); } } } }).build(admin("support"), "EG", { range: "7d" }));
    expect(sup.kill_switches).toEqual({ key: "kill_switches", status: "forbidden" });
    expect(calls).toEqual([]);
  });
});
