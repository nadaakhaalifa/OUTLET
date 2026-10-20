/**
 * The same HTTP flow against the Postgres adapter on PGlite: create, courier down, retry, signed
 * webhooks twice, COD remittance. Proves the SQL adapter and the policy layer agree end to end.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import { createPgliteDatabase, type PgliteInstance } from "../../../platform/db";
import { KyselyFulfillmentRepository, type FulfillmentDb } from "../adapters/kysely-store";
import {
  PRINCIPALS,
  STORE_A,
  bearer,
  codOrder,
  createFulfillmentHarness,
  idemKey,
  remittanceBody,
  trackingBody,
  type FulfillmentHarness,
} from "./harness";
import { freshFulfillmentDatabase } from "./pglite-fixture";

let h: FulfillmentHarness;
let db: Kysely<Record<string, never>>;
let repo: KyselyFulfillmentRepository;

beforeAll(async () => {
  const raw = await freshFulfillmentDatabase();
  db = createPgliteDatabase<Record<string, never>>(raw as unknown as PgliteInstance);
  const fdb: FulfillmentDb = db;
  repo = new KyselyFulfillmentRepository(fdb);
  h = await createFulfillmentHarness({ repository: repo });
}, 60_000);
afterAll(async () => {
  await h.close();
  await db.destroy();
});

const owner = bearer(PRINCIPALS.ownerA);
const T = (s: number): number => 1_800_000_000_000 + s * 1000;

describe("fulfillment over Postgres", () => {
  it("creates, tracks to delivered, replays and records a COD remittance", async () => {
    const order = codOrder(1, STORE_A, 250_000n);
    h.orders.add(order);
    const created = await h
      .http()
      .post("/v1/seller/shipments")
      .set(owner)
      .set("Idempotency-Key", idemKey())
      .send({ seller_order_ids: [order.id], parcel: { weight_g: 1200, pieces: 2 } });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ status: "label_ready", cod_amount: { amount: "250000", currency: "EGP" } });
    const id = created.body.id as string;
    const awb = created.body.awb as string;

    const bodies = [
      trackingBody("pg-1", awb, "Picked up", T(1)),
      trackingBody("pg-2", awb, "Out for delivery", T(2)),
      trackingBody("pg-3", awb, "Delivery failed", T(3), "no answer"),
      trackingBody("pg-4", awb, "Out for delivery", T(4)),
      trackingBody("pg-5", awb, "Delivered", T(5)),
    ];
    for (const b of bodies) expect((await h.webhook(b)).status).toBe(200);
    const once = (await h.http().get(`/v1/seller/shipments/${id}`).set(owner)).body;
    expect(once).toMatchObject({ status: "delivered", attempts: 1, delivered_at: new Date(T(5)).toISOString() });
    for (const b of bodies) expect((await h.webhook(b)).body.duplicate).toBe(true);
    expect((await h.http().get(`/v1/seller/shipments/${id}`).set(owner)).body).toEqual(once);

    const rem = await h.webhook(remittanceBody("pg-r1", "CR-PG-1", [{ awb, collected: 250_000, fee: 3_000 }]));
    expect(rem.status).toBe(200);
    expect(await repo.getShipment(id)).toMatchObject({ state: "COD_REMITTED", codStatus: "REMITTED" });
    expect(await repo.findRemittance("bosta", "CR-PG-1")).toMatchObject({ status: "MATCHED" });
  });

  it("holds the AWB job across a courier outage and finishes it later", async () => {
    h.courier.mode = "down";
    const order = codOrder(2, STORE_A, 100_000n);
    h.orders.add(order);
    const r = await h
      .http()
      .post("/v1/seller/shipments")
      .set(owner)
      .set("Idempotency-Key", idemKey())
      .send({ seller_order_ids: [order.id] });
    expect(r.body).toMatchObject({ status: "label_pending", label_status: "pending" });
    h.courier.mode = "up";
    h.clock.advance(31_000);
    expect(await h.worker.runDue()).toMatchObject({ created: 1 });
    const g = await h.http().get(`/v1/seller/shipments/${r.body.id}`).set(owner);
    expect(g.body.status).toBe("label_ready");
  });
});
