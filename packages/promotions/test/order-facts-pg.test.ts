import { randomUUID } from "node:crypto";
import { brandClient } from "@outlet/db";
import type { Queryable, SqlClient } from "@outlet/db";
import { createTestClient, roleClient } from "@outlet/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgOrderFacts, PromotionError, VoucherService } from "../src/index.js";
import { FakeAbuse, FakeKill } from "../src/testing.js";

let raw: SqlClient;
let close: () => Promise<void>;
let worker: PgOrderFacts;
let viaRaw: PgOrderFacts;

const seed = async (statuses: readonly string[]): Promise<string> => {
  const group = randomUUID();
  const user = randomUUID();
  await raw.query("SET session_replication_role = replica");
  for (const status of statuses) {
    await raw.query(
      `INSERT INTO seller_orders (id, order_group_id, store_id, user_id, market_id, currency, status, funds_flow, items_subtotal_minor, shipping_minor, shipping_vat_minor, vat_minor, total_minor,
         commission_bp_snapshot, commission_minor, commission_vat_minor, seller_net_minor)
       VALUES ($1,$2,$3,$4,'EG','EGP',$5,'psp_split',5000,300,37,651,5300,1500,750,105,4145)`,
      [randomUUID(), group, randomUUID(), user, status],
    );
  }
  await raw.query("SET session_replication_role = origin");
  return group;
};

beforeAll(async () => {
  const t = await createTestClient();
  raw = t.client;
  close = t.close;
  const base = roleClient(raw, "outlet_worker");
  worker = PgOrderFacts.forWorker(brandClient<"outlet_worker">({ query: (sql, params) => base.query(sql, params), transaction: (fn) => base.transaction((tx: Queryable) => fn(tx)) }), "EG");
  viaRaw = new PgOrderFacts((fn) => raw.transaction(fn));
});
afterAll(async () => { await close(); });

describe("PgOrderFacts.wholeOrderCancelledBeforeShipping", () => {
  for (const [name, make] of [["worker context (finance.reconcile read policy)", () => worker], ["injected transaction runner", () => viaRaw]] as const) {
    it(`${name}: true only when every seller order is CANCELLED or REJECTED_BY_SELLER`, async () => {
      const facts = make();
      expect(await facts.wholeOrderCancelledBeforeShipping(await seed(["CANCELLED"]))).toBe(true);
      expect(await facts.wholeOrderCancelledBeforeShipping(await seed(["CANCELLED", "REJECTED_BY_SELLER", "CANCELLED"]))).toBe(true);
      expect(await facts.wholeOrderCancelledBeforeShipping(await seed(["REJECTED_BY_SELLER"]))).toBe(true);
    });
    it(`${name}: false when any seller order is open, shipped, delivered, returned or closed`, async () => {
      const facts = make();
      for (const other of ["PENDING_PAYMENT", "PAID", "CONFIRMED_COD", "ACCEPTED", "PACKED", "SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED", "CLOSED", "RTO", "RETURNED_TO_SELLER", "DISPUTED", "VOIDED"]) {
        expect(await facts.wholeOrderCancelledBeforeShipping(await seed(["CANCELLED", other])), other).toBe(false);
        expect(await facts.wholeOrderCancelledBeforeShipping(await seed([other])), other).toBe(false);
      }
    });
    it(`${name}: false for an unknown order group`, async () => {
      expect(await make().wholeOrderCancelledBeforeShipping(randomUUID())).toBe(false);
    });
  }

  it("drives VoucherService.reinstate: refused for a partly shipped group, allowed once the whole group is cancelled", async () => {
    const base = roleClient(raw, "outlet_app");
    const app = brandClient<"outlet_app">({ query: (sql, params) => base.query(sql, params), transaction: (fn) => base.transaction((tx: Queryable) => fn(tx)) });
    const vouchers = new VoucherService({ client: app, marketId: "EG", kill: new FakeKill(), abuse: new FakeAbuse(), orderFacts: viaRaw });
    const user = randomUUID();
    const shipped = await seed(["CANCELLED", "SHIPPED"]);
    await expect(vouchers.reinstate(user, shipped)).rejects.toBeInstanceOf(PromotionError);
    const cancelled = await seed(["CANCELLED", "REJECTED_BY_SELLER"]);
    expect(await vouchers.reinstate(user, cancelled)).toBe(0); // nothing confirmed to give back, but the gate opened
  });
});
