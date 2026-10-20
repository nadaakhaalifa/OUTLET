import type { PGlite } from "@electric-sql/pglite";
import { lintMigration } from "@outlet/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATION_SQL, freshFulfillmentDatabase } from "./pglite-fixture";

const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const STORE_A = "00000000-0000-4000-a000-000000000001";
const STORE_B = "00000000-0000-4000-a000-000000000002";

let db: PGlite;

const asRole = async <T>(role: string, storeIds: string[], fn: () => Promise<T>): Promise<T> => {
  await db.exec("BEGIN");
  try {
    await db.exec("SET LOCAL ROLE app_user");
    await db.query("SELECT set_config('app.role', $1, true), set_config('app.store_ids', $2, true)", [role, storeIds.join(",")]);
    const out = await fn();
    await db.exec("COMMIT");
    return out;
  } catch (e) {
    await db.exec("ROLLBACK");
    throw e;
  }
};

const insertShipment = (id: number, order: number, store = STORE_A) =>
  db.query(
    `INSERT INTO shipments (id, store_id, seller_order_id, seller_order_ids, courier_code, parcel_weight_g, created_at)
     VALUES ($1, $2, $3, ARRAY[$3::uuid], 'bosta', 500, now())`,
    [U(id), store, U(order)],
  );

beforeAll(async () => {
  db = await freshFulfillmentDatabase();
}, 60_000);
afterAll(async () => {
  await db.close();
});

describe("0022_fulfillment", () => {
  it("passes the expand-only migration linter", () => {
    expect(lintMigration(MIGRATION_SQL)).toEqual([]);
  });

  it("enforces one live shipment per seller order but allows a re-ship after cancel", async () => {
    await insertShipment(1, 1);
    await expect(insertShipment(2, 1)).rejects.toThrow(/duplicate key|unique/i);
    await db.query(`UPDATE shipments SET status = 'CANCELLED' WHERE id = $1`, [U(1)]);
    await insertShipment(2, 1);
  });

  it("requires COD amount and status to agree, and a delivered shipment to carry delivered_at", async () => {
    await expect(
      db.query(
        `INSERT INTO shipments (id, store_id, seller_order_id, seller_order_ids, courier_code, parcel_weight_g, created_at, cod_amount)
         VALUES ($1,$2,$3,ARRAY[$3::uuid],'bosta',500,now(),1000)`,
        [U(10), STORE_A, U(10)],
      ),
    ).rejects.toThrow(/shipments_cod_chk/);
    await expect(
      db.query(`UPDATE shipments SET status = 'DELIVERED' WHERE id = $1`, [U(2)]),
    ).rejects.toThrow(/shipments_delivered_chk/);
    await expect(
      db.query(
        `INSERT INTO shipments (id, store_id, seller_order_id, seller_order_ids, courier_code, parcel_weight_g, created_at, attempts_made)
         VALUES ($1,$2,$3,ARRAY[$3::uuid],'bosta',500,now(),4)`,
        [U(11), STORE_A, U(11)],
      ),
    ).rejects.toThrow();
  });

  it("keeps two AWBs from colliding per courier but lets different couriers reuse one", async () => {
    await db.query(`UPDATE shipments SET awb = 'AWB-0001' WHERE id = $1`, [U(2)]);
    await insertShipment(3, 3);
    await expect(db.query(`UPDATE shipments SET awb = 'AWB-0001' WHERE id = $1`, [U(3)])).rejects.toThrow(/unique|duplicate/i);
    await db.query(`UPDATE shipments SET awb = 'AWB-0001', courier_code = 'aramex' WHERE id = $1`, [U(3)]);
  });

  it("makes shipment_events append-only and unique per courier event id", async () => {
    await db.query(
      `INSERT INTO shipment_events (id, shipment_id, courier_event_id, kind, outcome, from_status, to_status, occurred_at, recorded_at)
       VALUES ($1,$2,'e1','picked_up','APPLIED','LABEL_CREATED','PICKED_UP',now(),now())`,
      [U(20), U(2)],
    );
    await expect(
      db.query(
        `INSERT INTO shipment_events (id, shipment_id, courier_event_id, kind, outcome, from_status, to_status, occurred_at, recorded_at)
         VALUES ($1,$2,'e1','picked_up','APPLIED','LABEL_CREATED','PICKED_UP',now(),now())`,
        [U(21), U(2)],
      ),
    ).rejects.toThrow(/unique|duplicate/i);
    await expect(db.query(`UPDATE shipment_events SET kind = 'x' WHERE id = $1`, [U(20)])).rejects.toThrow(/append-only/);
    await expect(db.query(`DELETE FROM shipment_events WHERE id = $1`, [U(20)])).rejects.toThrow(/append-only/);
  });

  it("dedups raw courier events per courier and caps the stored body", async () => {
    const ins = (id: number, evt: string, body = "{}") =>
      db.query(
        `INSERT INTO courier_events_raw (id, courier_code, courier_event_id, body, received_at) VALUES ($1,'bosta',$2,$3,now())`,
        [U(id), evt, body],
      );
    await ins(30, "raw-1");
    await expect(ins(31, "raw-1")).rejects.toThrow(/unique|duplicate/i);
    await expect(ins(32, "raw-big", "x".repeat(262_145))).rejects.toThrow();
  });

  it("enforces remittance uniqueness per courier reference", async () => {
    const ins = (id: number) =>
      db.query(
        `INSERT INTO cod_remittances (id, courier_code, courier_ref, remittance_date, total_amount, status, received_at)
         VALUES ($1,'bosta','CR-1','2026-10-01',100,'MATCHED',now())`,
        [U(id)],
      );
    await ins(40);
    await expect(ins(41)).rejects.toThrow(/unique|duplicate/i);
  });
});

describe("0022_fulfillment row level security", () => {
  it("lets a store see only its own shipments and events", async () => {
    await insertShipment(50, 50, STORE_B);
    const a = await asRole("seller", [STORE_A], async () => (await db.query<{ id: string }>(`SELECT id FROM shipments`)).rows.map((r) => r.id));
    expect(a).toContain(U(2));
    expect(a).not.toContain(U(50));
    const b = await asRole("seller", [STORE_B], async () => (await db.query<{ id: string }>(`SELECT id FROM shipments`)).rows.map((r) => r.id));
    expect(b).toEqual([U(50)]);
    const ev = await asRole("seller", [STORE_B], async () => (await db.query(`SELECT 1 FROM shipment_events`)).rows.length);
    expect(ev).toBe(0);
    const evA = await asRole("seller", [STORE_A], async () => (await db.query(`SELECT 1 FROM shipment_events`)).rows.length);
    expect(evA).toBe(1);
  });

  it("denies sellers any write and any access to raw events, jobs and remittances", async () => {
    await expect(
      asRole("seller", [STORE_A], () => db.query(`UPDATE shipments SET attempts_made = 1 WHERE id = $1`, [U(2)])),
    ).resolves.toMatchObject({ affectedRows: 0 });
    await expect(asRole("seller", [STORE_A], () => insertShipment(60, 60))).rejects.toThrow(/row-level security/);
    for (const t of ["courier_events_raw", "courier_awb_jobs", "cod_remittances", "cod_remittance_lines"]) {
      const n = await asRole("seller", [STORE_A], async () => (await db.query(`SELECT 1 FROM ${t}`)).rows.length);
      expect(n, t).toBe(0);
    }
  });

  it("gives the system role and finance the access the module needs", async () => {
    const sys = await asRole("system", [], async () => (await db.query(`SELECT 1 FROM courier_events_raw`)).rows.length);
    expect(sys).toBeGreaterThan(0);
    const fin = await asRole("finance", [], async () => (await db.query(`SELECT 1 FROM cod_remittances`)).rows.length);
    expect(fin).toBe(1);
    const finRaw = await asRole("finance", [], async () => (await db.query(`SELECT 1 FROM courier_events_raw`)).rows.length);
    expect(finRaw).toBe(0);
  });
});
