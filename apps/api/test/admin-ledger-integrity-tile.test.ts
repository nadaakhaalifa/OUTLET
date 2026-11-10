import { randomUUID } from "node:crypto";
import type { SqlClient } from "@outlet/db";
import { createTestClient, roleClient } from "@outlet/db/testing";
import { createLogger } from "@outlet/logger";
import type { Principal } from "@outlet/policy";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DashboardService, PgDashboardReader } from "../src/modules/admin/index.js";
import type { AdminServices, DashboardReaderPort } from "../src/modules/admin/index.js";
import type { DashboardResponse } from "../src/modules/admin/dto-dashboard.js";
import { T0 } from "./harness.js";

const NOW = new Date(T0);
const market = (): { timezone: string; currency: string } => ({ timezone: "Africa/Cairo", currency: "EGP" });
const finance: Principal = { kind: "admin", userId: randomUUID(), marketId: "EG", roles: ["finance"], scopes: [] };
const ops: Principal = { kind: "admin", userId: randomUUID(), marketId: "EG", roles: ["support"], scopes: [] };
const base = { approvals: { countPending: () => Promise.resolve({ forMe: 0, soonestExpiresAt: null }) }, kyc: { count: () => Promise.resolve({ submitted: 0, needsInfo: 0, oldestAt: null }) } };
const reader = (o: Partial<DashboardReaderPort>): DashboardReaderPort => ({
  snapshots: () => Promise.resolve([]),
  salesDaily: () => Promise.resolve({ rows: [], firstDay: "2029-12-01", refreshedAt: NOW.toISOString() }),
  storeSalesTop: () => Promise.resolve({ items: [], other: { stores: 0, orders: 0, gmvMinor: 0n }, asOf: NOW.toISOString() }),
  ...o,
});
const tile = async (r: DashboardReaderPort, p: Principal = finance): Promise<{ status: string; reason?: string; as_of?: string; data?: unknown }> => {
  const s = new DashboardService({ access: {}, reconciliation: {}, ...base, dashboard: r } as unknown as AdminServices, { now: () => NOW, logger: createLogger({ write: () => undefined, level: "debug" }), market });
  const res: DashboardResponse = await s.build(p, "EG", { range: "7d" });
  return res.sections.money.ledger_integrity;
};
const hoursAgo = (h: number): string => new Date(NOW.getTime() - h * 3_600_000).toISOString();

describe("ledger_integrity tile states (DashboardService)", () => {
  it("not_connected without a reader method, and until the first run exists", async () => {
    expect(await tile(reader({}))).toMatchObject({ status: "unavailable", reason: "not_connected" });
    expect(await tile(reader({ ledgerIntegrity: () => Promise.resolve(null) }))).toMatchObject({ status: "unavailable", reason: "not_connected" });
  });
  it("ok with balanced / chain_ok / checked_at, and a mismatch is still ok-status data with balanced=false", async () => {
    const good = await tile(reader({ ledgerIntegrity: () => Promise.resolve({ checkedAt: hoursAgo(2), balanced: true, chainOk: true, totals: { EGP: "0" } }) }));
    expect(good).toMatchObject({ status: "ok", as_of: hoursAgo(2), data: { balanced: true, chain_ok: true, checked_at: hoursAgo(2) } });
    const bad = await tile(reader({ ledgerIntegrity: () => Promise.resolve({ checkedAt: hoursAgo(2), balanced: false, chainOk: false, totals: { EGP: "100" } }) }));
    expect(bad).toMatchObject({ status: "ok", data: { balanced: false, chain_ok: false } });
  });
  it("stale after 26 h (25 h is still fresh)", async () => {
    expect((await tile(reader({ ledgerIntegrity: () => Promise.resolve({ checkedAt: hoursAgo(25), balanced: true, chainOk: true, totals: {} }) }))).status).toBe("ok");
    expect(await tile(reader({ ledgerIntegrity: () => Promise.resolve({ checkedAt: hoursAgo(27), balanced: true, chainOk: true, totals: {} }) }))).toMatchObject({ status: "unavailable", reason: "stale" });
  });
  it("read_failed when the read throws; forbidden without finance.summary.read and the read is never made", async () => {
    expect(await tile(reader({ ledgerIntegrity: () => Promise.reject(new Error("boom")) }))).toMatchObject({ status: "unavailable", reason: "read_failed" });
    let called = false;
    const t = await tile(reader({ ledgerIntegrity: () => { called = true; return Promise.resolve(null); } }), ops);
    expect(t.status).toBe("forbidden");
    expect(called).toBe(false);
  });
});

describe("PgDashboardReader.ledgerIntegrity (real outlet_worker role, job admin.dashboard)", () => {
  let admin: SqlClient;
  let close: () => Promise<void>;
  beforeAll(async () => { ({ client: admin, close } = await createTestClient()); });
  afterAll(async () => close());
  beforeEach(async () => { await admin.query("DELETE FROM reconciliation_runs"); });
  const seed = (market: string, source: string, date: string, finished: string, status: string, details: unknown): Promise<unknown> =>
    admin.query("INSERT INTO reconciliation_runs (id, market_id, source, counterparty, business_date, mode, status, started_at, finished_at, details) VALUES ($1,$2,$3,'ledger',$4::date,'nightly',$5,$6::timestamptz,$6::timestamptz,$7::jsonb)", [randomUUID(), market, source, date, status, finished, JSON.stringify(details)]);
  const read = (m = "EG") => new PgDashboardReader(roleClient(admin, "outlet_worker")).ledgerIntegrity(m);
  const det = (balanced: boolean, chain: boolean, total = "0"): unknown => ({ version: 1, balanced, chain_ok: chain, totals: { EGP: total } });

  it("null when no ledger_integrity run exists (other sources and other markets do not count)", async () => {
    await seed("EG", "psp_settlement", "2030-01-10", "2030-01-10T01:00:00Z", "completed", {});
    await seed("AE", "ledger_integrity", "2030-01-10", "2030-01-10T01:00:00Z", "completed", det(true, true));
    expect(await read()).toBeNull();
  });
  it("returns the newest run by business date, with status mapped from details, and a failed run shows the mismatch", async () => {
    await seed("EG", "ledger_integrity", "2030-01-09", "2030-01-09T01:00:00Z", "completed", det(true, true));
    await seed("EG", "ledger_integrity", "2030-01-10", "2030-01-10T01:00:00Z", "failed", det(false, true, "100"));
    expect(await read()).toEqual({ checkedAt: "2030-01-10T01:00:00.000Z", balanced: false, chainOk: true, totals: { EGP: "100" } });
  });
  it("a run whose details do not parse is a read failure, never a made-up ok", async () => {
    await seed("EG", "ledger_integrity", "2030-01-10", "2030-01-10T01:00:00Z", "completed", { balanced: true });
    await expect(read()).rejects.toThrow();
  });
});
