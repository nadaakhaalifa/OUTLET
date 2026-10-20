import { createTestDatabaseUpTo } from "@outlet/db";
import { afterAll, describe, expect, it } from "vitest";
import { createPgliteDatabase, type PgliteInstance } from "../../../platform/db";
import { FakeKeyer, OrderLinePurchased, SellerOrderPlacedAnalytics, StaticGate, AnalyticsProducers } from "../../analytics-ingest";
import { TestClock, GROUP_1, ORDER_A, ORDER_B, SHOPPER_A, STORE_A, STORE_B, T0 } from "../test/fixtures";
import { FakeOrderIntake } from "./fake-intake";
import { PlaceOrders } from "../application/intake";
import { KyselyOrderRepository, type OrdersDb } from "./kysely-store";

const open: { destroy(): Promise<void> }[] = [];
afterAll(async () => {
  await Promise.all(open.map((d) => d.destroy()));
});

const LEGACY_KEYS = ["accept_by_ms", "order_group_id", "payment_type", "seller_order_id", "store_id", "total_amount"];

async function freshOrders(on: boolean, consent: boolean | null) {
  const raw = await createTestDatabaseUpTo(19);
  const db: OrdersDb = createPgliteDatabase<Record<string, never>>(raw as unknown as PgliteInstance);
  open.push(db);
  await raw.query(`insert into users (id, status) values ($1, 'active') on conflict do nothing`, [SHOPPER_A]);
  if (consent !== null) {
    await raw.query(
      `insert into consent_records (subject_type, subject_id, purpose, version, granted, method) values ('user', $1, 'analytics', 1, $2, 'settings')`,
      [SHOPPER_A, consent],
    );
  }
  const gate = new StaticGate(on);
  const producers = new AnalyticsProducers({ gate, keyer: new FakeKeyer() });
  const clock = new TestClock();
  const repo = new KyselyOrderRepository(db, clock, "app_user", producers);
  const intake = new FakeOrderIntake(new PlaceOrders(repo, clock));
  const outbox = async () =>
    (await raw.query<{ t: string; p: Record<string, unknown> }>(`select event_type as t, payload as p from outbox_events order by occurred_at, event_type, id`)).rows;
  const place = () =>
    intake.placeOrder({
      groupId: GROUP_1, userId: SHOPPER_A, paidAtMs: T0,
      stores: [{ sellerOrderId: ORDER_A, storeId: STORE_A, lines: 2 }, { sellerOrderId: ORDER_B, storeId: STORE_B }],
    });
  return { raw, db, gate, repo, clock, outbox, place, intake };
}

describe("order producers (seller_order.placed, order_line.purchased)", () => {
  it("BLOCKED by default: the order commits and NO analytics event or field is appended", async () => {
    const c = await freshOrders(false, true);
    await c.place();
    const rows = await c.outbox();
    expect(rows.map((r) => r.t)).toEqual(["seller_order.placed", "seller_order.placed"]);
    for (const r of rows) expect(Object.keys(r.p).sort()).toEqual(LEGACY_KEYS);
    const n = await c.raw.query<{ n: string }>(`select count(*)::text as n from order_groups`);
    expect(n.rows[0]?.n).toBe("1");
  });

  it("a throwing gate counts as blocked and never fails the order", async () => {
    const c = await freshOrders(true, true);
    const producers = new AnalyticsProducers({
      gate: { enabled: async () => { throw new Error("flag backend down"); } },
      keyer: new FakeKeyer(),
    });
    const repo = new KyselyOrderRepository(c.db, c.clock, "app_user", producers);
    const intake = new FakeOrderIntake(new PlaceOrders(repo, c.clock));
    await intake.placeOrder({ groupId: GROUP_1, userId: SHOPPER_A, paidAtMs: T0, stores: [{ sellerOrderId: ORDER_A, storeId: STORE_A }] });
    expect((await c.outbox()).map((r) => r.t)).toEqual(["seller_order.placed"]);
  });

  it("ALLOWED with consent: one placed event per seller order and one purchased event per line, same transaction", async () => {
    const c = await freshOrders(true, true);
    await c.place();
    const rows = await c.outbox();
    const types = rows.map((r) => r.t).sort();
    expect(types).toEqual(["order_line.purchased", "order_line.purchased", "order_line.purchased", "seller_order.placed", "seller_order.placed"]);
    const placed = rows.filter((r) => r.t === "seller_order.placed");
    for (const r of placed) {
      expect(SellerOrderPlacedAnalytics.safeParse({ placed_at_ms: r.p["placed_at_ms"], lines: r.p["lines"], shopper_key: r.p["shopper_key"] }).success).toBe(true);
      expect(r.p["shopper_key"]).toMatch(/^[0-9a-f]{64}$/);
      expect(r.p["accept_by_ms"]).toBeDefined(); // the legacy fields are untouched
    }
    const purchased = rows.filter((r) => r.t === "order_line.purchased").map((r) => OrderLinePurchased.parse(r.p));
    expect(purchased).toHaveLength(3);
    // store A: line0 qty 1, line1 qty 2, unit 25,000 piastres, 15% commission; store B: one line qty 1
    const gross = purchased.map((p) => `${p.qty}:${p.gross_minor}:${p.commission_minor}`).sort();
    expect(gross).toEqual(["1:25000:3750", "1:25000:3750", "2:50000:7500"]);
    for (const p of purchased) {
      expect(p.currency).toBe("EGP");
      expect(p.size_label).toBe("M");
      expect(p.governorate).toBe("EG-C");
      expect(typeof p.gross_minor).toBe("string");
    }
    expect(JSON.stringify(rows)).not.toContain(SHOPPER_A); // no user id anywhere in the payloads
  });

  it("shopper_key is null without the analytics consent (facts are still written) and after withdrawal", async () => {
    for (const consent of [null, false]) {
      const c = await freshOrders(true, consent);
      await c.place();
      const rows = await c.outbox();
      expect(rows).toHaveLength(5);
      for (const r of rows) expect(r.p["shopper_key"]).toBeNull();
    }
    const c = await freshOrders(true, true);
    await c.raw.query(
      `insert into consent_records (subject_type, subject_id, purpose, version, granted, method) values ('user', $1, 'analytics', 1, false, 'settings')`,
      [SHOPPER_A],
    );
    await c.place();
    for (const r of await c.outbox()) expect(r.p["shopper_key"]).toBeNull();
  });

  it("replay idempotency: placing the same group again appends nothing", async () => {
    const c = await freshOrders(true, true);
    await c.place();
    const before = (await c.outbox()).length;
    await c.place();
    expect((await c.outbox()).length).toBe(before);
  });

  it("atomicity: when the transaction aborts, no order and no analytics event remain", async () => {
    const c = await freshOrders(true, true);
    await expect(
      c.intake.placeOrder({
        groupId: GROUP_1, userId: SHOPPER_A, paidAtMs: T0,
        // second seller order reuses the first id: the PK violation aborts AFTER the first order's events were appended
        stores: [{ sellerOrderId: ORDER_A, storeId: STORE_A, lines: 2 }, { sellerOrderId: ORDER_A, storeId: STORE_B }],
      }),
    ).rejects.toThrow();
    expect(await c.outbox()).toEqual([]);
    const n = await c.raw.query<{ n: string }>(`select count(*)::text as n from order_groups`);
    expect(n.rows[0]?.n).toBe("0");
  });
});

