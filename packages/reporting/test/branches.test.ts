import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Queryable, SqlClient } from "@outlet/db";
import { createTestClient, roleClient } from "@outlet/db/testing";
import { RollupConsumer, RollupService, ROLLUP_REQUESTED_EVENT } from "../src/index.js";
import { SNAPSHOT_READERS } from "../src/snapshots.js";
import type { SnapshotCtx } from "../src/snapshots.js";
import { relaxFks, seedGroup, seedRefund, seedStore } from "./helpers.js";

const NOW = new Date("2026-11-10T09:00:00Z");
let admin: SqlClient;
let close: () => Promise<void>;
const dayCount = async (): Promise<number> => (await admin.query<{ n: number }>("SELECT count(DISTINCT day)::int AS n FROM market_sales_daily")).rows[0]?.n ?? -1;

beforeAll(async () => {
  ({ client: admin, close } = await createTestClient());
  await relaxFks(admin);
});
afterAll(async () => close());
beforeEach(async () => {
  for (const t of ["market_sales_daily", "store_sales_daily", "admin_dashboard_snapshots", "seller_orders", "order_groups", "refunds", "stores", "inbox_processed"]) await admin.query(`DELETE FROM ${t}`);
});

describe("RollupConsumer scope defaults", () => {
  const E = (n: number): string => `018f0000-0000-7000-8000-0000000009${String(n).padStart(2, "0")}`;
  const mk = (): RollupConsumer => new RollupConsumer(roleClient(admin, "outlet_worker"), "EG", new RollupService({ client: roleClient(admin, "outlet_worker"), now: () => NOW }));

  it("nightly without days rolls up 90 market days; an explicit days value overrides the scope default", async () => {
    const c = mk(); // default logger branch
    expect(await c.handle({ id: E(1), type: ROLLUP_REQUESTED_EVENT, payload: { scope: "nightly" } })).toBe("processed");
    expect(await dayCount()).toBe(90);
    await admin.query("DELETE FROM market_sales_daily");
    expect(await c.handle({ id: E(2), type: ROLLUP_REQUESTED_EVENT, payload: { scope: "sales", days: 5 } })).toBe("processed");
    expect(await dayCount()).toBe(5);
  });
});

describe("RollupService", () => {
  it("defaults to the real clock and the markets-config market clock", async () => {
    const s = new RollupService({ client: roleClient(admin, "outlet_worker") });
    expect(s.today("EG")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const r = await s.run("EG", "2026-11-10");
    expect(r.market).toEqual([{ currency: "EGP", orders: 0, gmvMinor: 0n, refundedMinor: 0n }]);
  });

  it("keeps a non-market currency apart and a refund-only currency gets its own row", async () => {
    const a = await seedStore(admin);
    await seedGroup(admin, { currency: "USD", placedAt: "2026-11-10T07:00:00Z", paidAt: "2026-11-10T07:05:00Z", parts: [{ storeId: a, total: 900n }] });
    await seedGroup(admin, { currency: "EUR", placedAt: "2026-11-10T07:00:00Z", paidAt: "2026-11-10T07:05:00Z", parts: [{ storeId: a, total: 100n }] });
    await seedRefund(admin, { currency: "GBP", amount: 40n, status: "COMPLETED", completedAt: "2026-11-10T08:00:00Z" });
    const r = await new RollupService({ client: roleClient(admin, "outlet_worker"), now: () => NOW }).run("EG", "2026-11-10");
    expect(r.market).toEqual([
      { currency: "EGP", orders: 0, gmvMinor: 0n, refundedMinor: 0n },
      { currency: "EUR", orders: 1, gmvMinor: 100n, refundedMinor: 0n },
      { currency: "GBP", orders: 0, gmvMinor: 0n, refundedMinor: 40n },
      { currency: "USD", orders: 1, gmvMinor: 900n, refundedMinor: 0n },
    ]);
    // one store, two currencies: ordered by currency when the store id ties
    expect(r.stores.map((x) => x.currency)).toEqual(["EUR", "USD"]);
  });
});

describe("snapshot readers on a stubbed transaction", () => {
  const ctx = (rows: unknown[]): SnapshotCtx => ({ tx: { query: () => Promise.resolve({ rows }) } as unknown as Queryable, marketId: "EG", currency: "EGP", now: NOW });

  it("throws when an aggregate returns no row (never fabricates zeros)", async () => {
    await expect(SNAPSHOT_READERS.stores_moderation(ctx([]))).rejects.toThrow("snapshot aggregate returned no row");
  });

  it("normalises string timestamps and keeps null as null", async () => {
    const d = await SNAPSHOT_READERS.cod_awaiting_confirmation(ctx([{ n: 2, oldest: "2026-11-01T10:00:00+02:00" }]));
    expect(d).toEqual({ count: 2, oldest_at: "2026-11-01T08:00:00.000Z" });
    expect(await SNAPSHOT_READERS.cod_awaiting_confirmation(ctx([{ n: 0, oldest: null }]))).toEqual({ count: 0, oldest_at: null });
  });
});
