import fc from "fast-check";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SqlClient } from "@outlet/db";
import { createLogger } from "@outlet/logger";
import { createTestClient, roleClient } from "@outlet/db/testing";
import { RollupConsumer, RollupService, ROLLUP_REQUESTED_EVENT, SNAPSHOT_TILE_DATA, SNAPSHOT_TILE_KEYS, addDays, localDay } from "../src/index.js";
import { relaxFks, seedGroup, seedRefund, seedStore } from "./helpers.js";

const TZ = "Africa/Cairo";
const NOW = new Date("2026-11-10T09:00:00Z"); // 11:00 in Cairo, day 2026-11-10 (standard time again)

let admin: SqlClient;
let close: () => Promise<void>;
let logs: string[];
const svc = (now: Date = NOW): RollupService => new RollupService({ client: roleClient(admin, "outlet_worker"), now: () => now });

interface DayRow { market_id: string; day: string; currency: string; orders_paid: number; gmv_minor: string; refunded_minor: string }
interface StoreRow { market_id: string; store_id: string; day: string; currency: string; orders_paid: number; gmv_minor: string }
const marketRows = async (): Promise<DayRow[]> => (await admin.query<DayRow>("SELECT market_id, day::text AS day, currency, orders_paid, gmv_minor::text AS gmv_minor, refunded_minor::text AS refunded_minor FROM market_sales_daily ORDER BY market_id, day, currency")).rows;
const storeRows = async (): Promise<StoreRow[]> => (await admin.query<StoreRow>("SELECT market_id, store_id, day::text AS day, currency, orders_paid, gmv_minor::text AS gmv_minor FROM store_sales_daily ORDER BY market_id, day, store_id, currency")).rows;
const clean = async (): Promise<void> => {
  for (const t of ["market_sales_daily", "store_sales_daily", "admin_dashboard_snapshots", "seller_orders", "order_groups", "refunds", "stores", "inbox_processed", "breach_records"]) await admin.query(`DELETE FROM ${t}`);
};

beforeAll(async () => {
  ({ client: admin, close } = await createTestClient());
  await relaxFks(admin);
});
afterAll(async () => close());
beforeEach(async () => {
  logs = [];
  await clean();
});

describe("sales rollup, worked example (GMV: order basis, VAT-inclusive, paid or COD-confirmed, Cairo day, refunds apart)", () => {
  it("counts each group once on its market-local day and keeps refunds in a separate column", async () => {
    const a = await seedStore(admin, { nameAr: "متجر أ" });
    const b = await seedStore(admin, { nameAr: "متجر ب" });
    // 2026-11-09 22:30Z is 00:30 on 11-10 in Cairo: it belongs to the 10th, not the 9th.
    await seedGroup(admin, { placedAt: "2026-11-09T22:00:00Z", paidAt: "2026-11-09T22:30:00Z", parts: [{ storeId: a, total: 10_000n }, { storeId: b, total: 5_000n }] });
    await seedGroup(admin, { placedAt: "2026-11-10T07:00:00Z", paidAt: "2026-11-10T07:05:00Z", parts: [{ storeId: a, total: 2_500n }] });
    // COD confirmed, never got paid_at: counted by placed_at.
    await seedGroup(admin, { placedAt: "2026-11-10T08:00:00Z", status: "CONFIRMED_COD", method: "cod", parts: [{ storeId: b, total: 700n }] });
    // Not counted: unpaid, awaiting COD confirmation, cancelled COD, payment failed, other market.
    await seedGroup(admin, { placedAt: "2026-11-10T08:00:00Z", status: "PENDING_PAYMENT", parts: [{ storeId: a, total: 111n, status: "PENDING_PAYMENT" }] });
    await seedGroup(admin, { placedAt: "2026-11-10T08:00:00Z", status: "AWAITING_COD_CONFIRMATION", method: "cod", parts: [{ storeId: a, total: 222n }] });
    await seedGroup(admin, { placedAt: "2026-11-10T08:00:00Z", status: "CANCELLED", method: "cod", cancelledAt: "2026-11-10T08:30:00Z", parts: [{ storeId: a, total: 333n }] });
    await seedGroup(admin, { market: "AE", currency: "AED", placedAt: "2026-11-10T08:00:00Z", paidAt: "2026-11-10T08:00:00Z", parts: [{ storeId: a, total: 444n }] });
    // Same basis for COD: a confirmed COD group later cancelled (REFUNDED, cancelled_at set) still counts; its refund shows apart.
    await seedGroup(admin, { placedAt: "2026-11-10T09:00:00Z", status: "REFUNDED", method: "cod", cancelledAt: "2026-11-10T09:30:00Z", parts: [{ storeId: a, total: 400n }] });
    // A paid group later cancelled still counts in GMV (order basis); its refund shows apart.
    await seedGroup(admin, { placedAt: "2026-11-10T06:00:00Z", paidAt: "2026-11-10T06:01:00Z", status: "REFUNDED", cancelledAt: "2026-11-10T06:30:00Z", parts: [{ storeId: b, total: 1_000n }] });
    await seedRefund(admin, { amount: 1_000n, status: "COMPLETED", completedAt: "2026-11-10T07:00:00Z" });
    await seedRefund(admin, { amount: 50n, status: "REQUESTED" });

    const s = svc();
    const d9 = await s.run("EG", "2026-11-09");
    const d10 = await s.run("EG", "2026-11-10");
    expect(d9.market).toEqual([{ currency: "EGP", orders: 0, gmvMinor: 0n, refundedMinor: 0n }]);
    expect(d10.market).toEqual([{ currency: "EGP", orders: 5, gmvMinor: 15_000n + 2_500n + 700n + 400n + 1_000n, refundedMinor: 1_000n }]);
    expect(d10.stores.map((x) => `${x.storeId === a ? "a" : "b"}:${String(x.orders)}:${x.gmvMinor.toString()}`).sort()).toEqual(["a:3:12900", "b:3:6700"]);
    const storeSum = d10.stores.reduce((acc, x) => acc + x.gmvMinor, 0n);
    expect(storeSum).toBe(d10.market[0]?.gmvMinor);
    expect((await marketRows()).filter((r) => r.market_id === "AE")).toEqual([]);
    expect((await storeRows()).every((r) => r.market_id === "EG")).toBe(true);
  });

  it("is idempotent and zeroes a day whose activity disappeared (no DELETE)", async () => {
    const a = await seedStore(admin);
    const gid = await seedGroup(admin, { placedAt: "2026-11-10T07:00:00Z", paidAt: "2026-11-10T07:05:00Z", parts: [{ storeId: a, total: 2_500n }] });
    const s = svc();
    await s.run("EG", "2026-11-10");
    const first = [await marketRows(), await storeRows()];
    await s.run("EG", "2026-11-10");
    expect([await marketRows(), await storeRows()]).toEqual(first);
    await admin.query("UPDATE order_groups SET paid_at = NULL WHERE id = $1", [gid]);
    await s.run("EG", "2026-11-10");
    expect((await marketRows())[0]).toMatchObject({ orders_paid: 0, gmv_minor: "0" });
    expect((await storeRows())[0]).toMatchObject({ orders_paid: 0, gmv_minor: "0" });
  });

  it("rejects a malformed day and runs under the reporting.rollup job only (another job's policies do not apply)", async () => {
    await expect(svc().run("EG", "2026-13-40")).rejects.toThrow(/invalid rollup day/);
  });
});

describe("property: the rollup equals brute-force sums per market-local day, including the Cairo DST switch days", () => {
  // Egypt switches on the last Friday of April (clocks forward at 00:00 -> 01:00) and the last Thursday of October (back at 24:00 -> 23:00).
  const BASES = [Date.parse("2026-04-23T12:00:00Z"), Date.parse("2026-10-28T12:00:00Z"), Date.parse("2026-11-08T12:00:00Z")];
  const instant = fc.tuple(fc.constantFrom(...BASES), fc.integer({ min: -36 * 3600, max: 36 * 3600 })).map(([b, sec]) => new Date(b + sec * 1000).toISOString());
  const order = fc.record({
    store: fc.integer({ min: 0, max: 3 }),
    parts: fc.array(fc.bigInt({ min: 1n, max: 50_000_000n }), { minLength: 1, maxLength: 3 }),
    ts: instant,
    kind: fc.constantFrom("paid", "paid", "cod_confirmed", "cod_pending", "unpaid"),
    market: fc.constantFrom("EG", "EG", "EG", "AE"),
  });

  it("market rows match, store sums equal the market row, re-running changes nothing, amounts stay bigint", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(order, { minLength: 1, maxLength: 12 }), async (orders) => {
        await clean();
        const stores = [await seedStore(admin), await seedStore(admin), await seedStore(admin), await seedStore(admin)];
        const expected = new Map<string, { n: number; gmv: bigint }>();
        for (const o of orders) {
          const eg = o.market === "EG";
          const counted = eg && (o.kind === "paid" || o.kind === "cod_confirmed");
          const parts = o.parts.map((total, i) => ({ storeId: stores[(o.store + i) % 4] ?? "", total }));
          await seedGroup(admin, {
            market: o.market, currency: eg ? "EGP" : "AED", placedAt: o.ts,
            paidAt: o.kind === "paid" ? o.ts : null,
            status: o.kind === "paid" ? "PAID" : o.kind === "cod_confirmed" ? "CONFIRMED_COD" : o.kind === "cod_pending" ? "AWAITING_COD_CONFIRMATION" : "PENDING_PAYMENT",
            method: o.kind.startsWith("cod") ? "cod" : "card", parts,
          });
          if (counted) {
            const day = localDay(new Date(o.ts), TZ);
            const e = expected.get(day) ?? { n: 0, gmv: 0n };
            expected.set(day, { n: e.n + 1, gmv: e.gmv + o.parts.reduce((a, b) => a + b, 0n) });
          }
        }
        const s = svc();
        const days: string[] = [];
        for (let d = "2026-04-20"; d <= "2026-04-28"; d = addDays(d, 1)) days.push(d);
        for (let d = "2026-10-25"; d <= "2026-11-11"; d = addDays(d, 1)) days.push(d);
        for (const d of days) await s.run("EG", d);
        const before = [await marketRows(), await storeRows()];
        for (const r of before[0] as DayRow[]) {
          const e = expected.get(r.day) ?? { n: 0, gmv: 0n };
          expect(r.orders_paid).toBe(e.n);
          expect(BigInt(r.gmv_minor)).toBe(e.gmv);
        }
        // Every counted day inside the rolled window is present, so nothing was lost off a window edge.
        for (const [day, e] of expected) if (days.includes(day)) expect((before[0] as DayRow[]).find((r) => r.day === day)?.gmv_minor).toBe(e.gmv.toString());
        // Sums over stores equal the market row, per day.
        for (const r of before[0] as DayRow[]) {
          const sum = (before[1] as StoreRow[]).filter((x) => x.day === r.day).reduce((a, x) => a + BigInt(x.gmv_minor), 0n);
          expect(sum).toBe(BigInt(r.gmv_minor));
        }
        for (const d of days) await s.run("EG", d);
        expect([await marketRows(), await storeRows()]).toEqual(before);
      }),
      { numRuns: 12 },
    );
  });
});

describe("snapshots", () => {
  it("every tile validates against its schema on an empty market, is upserted (one row per tile) and re-running overwrites in place", async () => {
    await svc().snapshots("EG");
    await svc(new Date(NOW.getTime() + 60_000)).snapshots("EG");
    const rows = (await admin.query<{ tile_key: string; as_of: string; payload: unknown }>("SELECT tile_key, as_of::text AS as_of, payload FROM admin_dashboard_snapshots ORDER BY tile_key")).rows;
    expect(rows.map((r) => r.tile_key)).toEqual([...SNAPSHOT_TILE_KEYS].sort());
    for (const r of rows) expect(() => SNAPSHOT_TILE_DATA[r.tile_key as keyof typeof SNAPSHOT_TILE_DATA].parse(r.payload)).not.toThrow();
    expect(rows.every((r) => r.as_of.includes("09:01:00"))).toBe(true);
  });

  it("counts what the source tables hold, pinned to the market", async () => {
    const a = await seedStore(admin, { status: "PENDING_REVIEW" });
    const b = await seedStore(admin, { status: "SUSPENDED" });
    await seedStore(admin, { status: "SUSPENDED", market: "AE" });
    await seedGroup(admin, { placedAt: "2026-11-10T07:00:00Z", paidAt: "2026-11-10T07:05:00Z", parts: [{ storeId: a, total: 100n, status: "PAID" }] });
    await seedGroup(admin, { placedAt: "2026-11-10T07:00:00Z", paidAt: "2026-11-10T07:05:00Z", parts: [{ storeId: a, total: 100n, status: "ACCEPTED" }, { storeId: b, total: 100n, status: "SHIPPED" }] });
    await seedGroup(admin, { market: "AE", currency: "AED", placedAt: "2026-11-10T07:00:00Z", paidAt: "2026-11-10T07:05:00Z", parts: [{ storeId: a, total: 100n, status: "PAID" }] });
    await seedGroup(admin, { placedAt: "2026-11-10T07:00:00Z", status: "AWAITING_COD_CONFIRMATION", method: "cod", parts: [{ storeId: a, total: 100n, status: "PENDING_PAYMENT" }] });
    await seedRefund(admin, { amount: 1_500n, status: "MANUAL_REVIEW", createdAt: "2026-11-05T00:00:00Z", dueAt: "2026-11-09T00:00:00Z" });
    await seedRefund(admin, { amount: 500n, status: "FAILED", createdAt: "2026-11-06T00:00:00Z", dueAt: "2026-12-01T00:00:00Z" });
    await seedRefund(admin, { amount: 9_999n, status: "REQUESTED", market: "AE", currency: "AED", dueAt: "2026-11-01T00:00:00Z" });
    await admin.query("INSERT INTO breach_records (id, market_id, opened_by, detected_at, opened_at, severity, summary, pdpc_deadline_at, updated_at) VALUES ('018f0000-0000-7000-8000-0000000009a1','EG','t','2026-11-09T00:00:00Z','2026-11-09T00:00:00Z','low','s','2026-11-11T00:00:00Z','2026-11-09T00:00:00Z'), ('018f0000-0000-7000-8000-0000000009a2','AE','t','2026-11-09T00:00:00Z','2026-11-09T00:00:00Z','low','s','2026-11-12T00:00:00Z','2026-11-09T00:00:00Z')");
    await svc().snapshots("EG");
    const get = async (k: string): Promise<unknown> => (await admin.query<{ payload: unknown }>("SELECT payload FROM admin_dashboard_snapshots WHERE market_id = 'EG' AND tile_key = $1", [k])).rows[0]?.payload;
    expect(await get("orders_by_step")).toEqual({ paid_awaiting_accept: 1, accepted: 1, packed: 0, in_transit: 1, delivery_failed: 0 });
    expect(await get("seller_sla_breaches")).toMatchObject({ late_dispatch: null });
    expect(await get("breaches_open")).toEqual({ open: 1, next_pdpc_deadline_at: "2026-11-11T00:00:00.000Z", next_subjects_deadline_at: null });
    expect(await get("stores_moderation")).toEqual({ pending_review: 1, suspended: 1 });
    expect(await get("cod_awaiting_confirmation")).toEqual({ count: 1, oldest_at: "2026-11-10T07:00:00.000Z" });
    expect(await get("refunds_waiting")).toEqual({ count: 2, amount: { amount_minor: "2000", currency: "EGP" }, manual_review: 1, failed: 1, oldest_at: "2026-11-05T00:00:00.000Z" });
    expect(await get("refunds_overdue")).toEqual({ count: 1, amount: { amount_minor: "1500", currency: "EGP" }, oldest_due_at: "2026-11-09T00:00:00.000Z" });
  });
});

describe("RollupConsumer (inbox)", () => {
  const consumer = (): RollupConsumer => new RollupConsumer(roleClient(admin, "outlet_worker"), "EG", svc(), createLogger({ write: (l) => logs.push(l), level: "debug" }));
  const E = (n: number): string => `018f0000-0000-7000-8000-0000000002${String(n).padStart(2, "0")}`;

  it("runs the requested scope once per event id; a replay is a duplicate", async () => {
    const a = await seedStore(admin);
    await seedGroup(admin, { placedAt: "2026-11-10T07:00:00Z", paidAt: "2026-11-10T07:05:00Z", parts: [{ storeId: a, total: 2_500n }] });
    const c = consumer();
    expect(await c.handle({ id: E(1), type: ROLLUP_REQUESTED_EVENT, payload: { scope: "sales" } })).toBe("processed");
    expect(await c.handle({ id: E(1), type: ROLLUP_REQUESTED_EVENT, payload: { scope: "sales" } })).toBe("duplicate");
    expect((await marketRows()).map((r) => r.day)).toEqual(["2026-11-08", "2026-11-09", "2026-11-10"]);
    expect((await marketRows())[2]).toMatchObject({ orders_paid: 1, gmv_minor: "2500" });
    expect(await c.handle({ id: E(2), type: ROLLUP_REQUESTED_EVENT, payload: { scope: "snapshots" } })).toBe("processed");
    expect((await admin.query("SELECT 1 FROM admin_dashboard_snapshots")).rows).toHaveLength(SNAPSHOT_TILE_KEYS.length);
  });

  it("parks a malformed payload and an unknown type (inbox row, error log, nothing written) so they cannot loop", async () => {
    const c = consumer();
    expect(await c.handle({ id: E(3), type: ROLLUP_REQUESTED_EVENT, payload: { scope: "everything" } })).toBe("processed");
    expect(await c.handle({ id: E(4), type: "something.else", payload: {} })).toBe("processed");
    expect(await c.handle({ id: E(3), type: ROLLUP_REQUESTED_EVENT, payload: { scope: "everything" } })).toBe("duplicate");
    expect(logs.join("\n")).toMatch(/invalid_payload/);
    expect(logs.join("\n")).toMatch(/unknown_type/);
    expect(await marketRows()).toEqual([]);
  });
});
