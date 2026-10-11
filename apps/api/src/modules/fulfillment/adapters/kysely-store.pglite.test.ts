import { afterAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import { createPgliteDatabase, type PgliteInstance } from "../../../platform/db";
import { KyselyFulfillmentRepository, type FulfillmentDb } from "./kysely-store";
import { freshFulfillmentDatabase } from "../test/pglite-fixture";
import {
  U,
  describeFulfillmentRepositoryContract,
  outboxEvent,
  shipment,
} from "../test/repository-contract";
import { money } from "../domain/bridge";

const open: Kysely<Record<string, never>>[] = [];

const fresh = async () => {
  const raw = await freshFulfillmentDatabase();
  const db: FulfillmentDb = createPgliteDatabase<Record<string, never>>(raw as unknown as PgliteInstance);
  open.push(db);
  const count = async (type: string): Promise<number> => {
    const r = await raw.query<{ n: string }>(`select count(*)::text as n from outbox_events where event_type = $1`, [type]);
    return Number(r.rows[0]?.n ?? "0");
  };
  return { raw, repo: new KyselyFulfillmentRepository(db), outboxCount: count };
};

afterAll(async () => {
  await Promise.all(open.map((d) => d.destroy()));
});

describeFulfillmentRepositoryContract("kysely/pglite", fresh);

describe("KyselyFulfillmentRepository specifics", () => {
  it("stores COD amounts as exact bigint piastres", async () => {
    const c = await fresh();
    const s = shipment(1, { codAmount: money(9_007_199_254_740_993n), codStatus: "PENDING" });
    await c.repo.createShipment(s, { nextAttemptAtMs: 1_800_000_000_000 }, [outboxEvent("shipment.created", s.id)]);
    const r = await c.raw.query<{ a: string }>(`select cod_amount::text as a from shipments`);
    expect(r.rows[0]?.a).toBe("9007199254740993");
    expect((await c.repo.getShipment(s.id))?.codAmount?.amount).toBe(9_007_199_254_740_993n);
  });

  it("rolls the whole create back when the outbox write fails", async () => {
    const c = await fresh();
    const s = shipment(1);
    const bad = { id: U(1), type: "NOT A VALID TYPE", aggregateId: s.id, payload: {} };
    await expect(c.repo.createShipment(s, { nextAttemptAtMs: 1 }, [bad])).rejects.toThrow();
    expect(await c.repo.getShipment(s.id)).toBeNull();
    expect(await c.repo.getJob(s.id)).toBeNull();
  });

  it("keeps the raw body verbatim", async () => {
    const c = await fresh();
    const body = '{"id":"e1","note":"مرحبا \\u0000"}';
    await c.repo.recordRaw({ id: U(5), courierCode: "bosta", courierEventId: "e1", awb: null, body, receivedAtMs: 1 });
    const r = await c.raw.query<{ body: string }>(`select body from courier_events_raw`);
    expect(r.rows[0]?.body).toBe(body);
  });
});
