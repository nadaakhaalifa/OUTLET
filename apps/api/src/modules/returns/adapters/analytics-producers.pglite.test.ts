import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTestDatabaseUpTo } from "@outlet/db";
import { afterAll, describe, expect, it } from "vitest";
import { createPgliteDatabase, type PgliteInstance } from "../../../platform/db";
import { AnalyticsProducers, FakeKeyer, ReturnLineReceived, StaticGate } from "../../analytics-ingest";
import { record, U } from "../test/repository-contract";
import { KyselyReturnRepository, type ReturnsDb } from "./kysely-store";

const T0 = 1_800_000_000_000;
const RETURNS_SQL = readFileSync(
  fileURLToPath(new URL("../../../../../../packages/db/migrations/0020_returns.sql", import.meta.url)),
  "utf8",
);
const open: ReturnsDb[] = [];
afterAll(async () => {
  await Promise.all(open.map((d) => d.destroy()));
});

const USER = U(1);
const LINE = { id: U(2000), sellerOrderId: U(3000), storeId: "00000000-0000-4000-a000-000000000001", productId: U(4001), skuId: U(4002) };

/** Orders schema (0019) plus 0020, with one bare order line (the FK to seller_orders is dropped for the seed). */
async function setup(on: boolean, consent: boolean | null) {
  const raw = await createTestDatabaseUpTo(19);
  await raw.exec(RETURNS_SQL);
  await raw.exec(`alter table order_lines drop constraint order_lines_seller_order_id_fkey`);
  await raw.query(`insert into users (id, status) values ($1, 'active')`, [USER]);
  await raw.query(
    `insert into order_lines (id, seller_order_id, store_id, sku_id, product_id, qty, unit_price_amount, title_ar, position) values ($1, $2, $3, $4, $5, 3, 25000, 'x', 0)`,
    [LINE.id, LINE.sellerOrderId, LINE.storeId, LINE.skuId, LINE.productId],
  );
  if (consent !== null) {
    await raw.query(`insert into consent_records (subject_type, subject_id, purpose, version, granted, method) values ('user', $1, 'analytics', 1, $2, 'settings')`, [USER, consent]);
  }
  const db: ReturnsDb = createPgliteDatabase<Record<string, never>>(raw as unknown as PgliteInstance);
  open.push(db);
  const repo = new KyselyReturnRepository(db, new AnalyticsProducers({ gate: new StaticGate(on), keyer: new FakeKeyer() }));
  const base = record(1, { userId: USER, orderLineId: LINE.id, sellerOrderId: LINE.sellerOrderId, storeId: LINE.storeId, qty: 1, reason: "too_small" });
  expect((await repo.createIfCapacity(base, 3)).kind).toBe("created");
  const received = { ...base, state: "RECEIVED" as const, receivedAtMs: T0 + 5_000, inspectionDueAtMs: T0 + 100_000, version: 1 };
  const events = async () =>
    (await raw.query<{ p: Record<string, unknown> }>(`select payload as p from outbox_events where event_type = 'return_line.received'`)).rows.map((r) => r.p);
  return { repo, received, events, raw };
}

describe("return producer (return_line.received)", () => {
  it("BLOCKED: the RECEIVED transition commits and appends no analytics event", async () => {
    const { repo, received, events } = await setup(false, true);
    expect(await repo.save(received, 0)).toBe(true);
    expect(await events()).toEqual([]);
    expect((await repo.findById(received.id))?.state).toBe("RECEIVED");
  });

  it("ALLOWED: exactly one event, once even when saved again", async () => {
    const { repo, received, events } = await setup(true, true);
    expect(await repo.save(received, 0)).toBe(true);
    expect(await repo.save({ ...received, inspectionNote: "x", version: 2 }, 1)).toBe(true);
    const ev = await events();
    expect(ev).toHaveLength(1);
    const p = ReturnLineReceived.parse(ev[0]);
    expect([p.order_line_id, p.product_id, p.sku_id, p.reason, p.qty]).toEqual([LINE.id, LINE.productId, LINE.skuId, "too_small", 1]);
    expect(p.shopper_key).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(ev)).not.toContain(USER);
  });

  it("shopper_key is null without consent", async () => {
    const none = await setup(true, null);
    await none.repo.save(none.received, 0);
    expect(ReturnLineReceived.parse((await none.events())[0]).shopper_key).toBeNull();
  });

  it("shopper_key is null after the consent was withdrawn", async () => {
    const withdrawn = await setup(true, false);
    await withdrawn.repo.save(withdrawn.received, 0);
    expect(ReturnLineReceived.parse((await withdrawn.events())[0]).shopper_key).toBeNull();
  });

  it("does not emit for a transition that is not RECEIVED", async () => {
    const { repo, received, events } = await setup(true, true);
    expect(await repo.save({ ...received, state: "IN_TRANSIT", receivedAtMs: null, version: 1 }, 0)).toBe(true);
    expect(await events()).toEqual([]);
  });

  it("emits nothing and still commits when the order line is unknown (analytics never blocks the transition)", async () => {
    const { repo, received, events } = await setup(true, true);
    expect(await repo.save({ ...received, orderLineId: U(9999) }, 0)).toBe(true);
    expect(await events()).toEqual([]);
  });

  it("atomicity: when the event cannot be written, the state change rolls back with it", async () => {
    const { repo, received, events, raw } = await setup(true, true);
    await raw.exec(`alter table outbox_events add constraint no_return_events check (event_type <> 'return_line.received')`);
    await expect(repo.save(received, 0)).rejects.toThrow();
    expect((await repo.findById(received.id))?.state).toBe("REQUESTED");
    expect(await events()).toEqual([]);
  });
});
