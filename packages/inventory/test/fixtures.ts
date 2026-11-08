import { randomUUID } from "node:crypto";
import { brandClient } from "@outlet/db";
import type { Queryable, RoleSqlClient, SqlClient } from "@outlet/db";
import { createTestClient, roleClient } from "@outlet/db/testing";
import type { Principal } from "@outlet/policy";
import { InventoryService, RESERVE_PICK_SQL, ReservationService } from "../src/index.js";
import type { InventoryDeps } from "../src/index.js";
import { InMemorySoldOutFlags } from "../src/testing.js";

export const CAT = "00000000-0000-4000-8000-0000000c0011";

export const staff = (storeIds: readonly string[], roles: readonly string[] = ["owner"]): Principal => ({
  kind: "seller_staff", userId: randomUUID(), marketId: "EG", storeIds: [...storeIds], roles: [...roles], scopes: [],
});

export interface World {
  readonly raw: SqlClient;
  readonly app: RoleSqlClient<"outlet_app">;
  readonly deps: InventoryDeps;
  readonly flags: InMemorySoldOutFlags;
  readonly inv: InventoryService;
  readonly res: ReservationService;
  readonly storeA: string;
  readonly storeB: string;
  readonly locA: string;
  readonly locB: string;
  /** SKU ids in the order the reserve statement was issued. */
  readonly picks: string[];
  readonly statements: string[];
  /** Adds a SKU (with a level and pool) to a store: returns the sku id. */
  readonly sku: (store: "A" | "B", onHand: number) => Promise<string>;
  readonly clock: { t: number };
  readonly close: () => Promise<void>;
}

export const buildWorld = async (over: Partial<InventoryDeps> = {}): Promise<World> => {
  const { client: raw, close } = await createTestClient();
  const statements: string[] = [];
  const base = roleClient(raw, "outlet_app");
  const picks: string[] = [];
  const rec = (sql: string, params?: readonly unknown[]): void => { statements.push(sql); if (sql === RESERVE_PICK_SQL) picks.push(String(params?.[0])); };
  const app = brandClient<"outlet_app">({
    query: (sql, params) => { rec(sql, params); return base.query(sql, params); },
    transaction: (fn) => base.transaction((tx: Queryable) => fn({ query: (sql, params) => { rec(sql, params); return tx.query(sql, params); } })),
  });
  const sellerA = randomUUID();
  const sellerB = randomUUID();
  const storeA = randomUUID();
  const storeB = randomUUID();
  for (const [sid, n] of [[sellerA, "A"], [sellerB, "B"]] as const) {
    await raw.query(
      `INSERT INTO sellers (id, home_market_id, market_id, legal_type, legal_name_ar, legal_name_en, commercial_register_no, tax_card_no, governorate_code, governorate_name_ar, status)
       VALUES ($1,'EG','EG','company',$2,$3,$4,$5,'CAI','القاهرة','active')`,
      [sid, `شركة ${n}`, `Company ${n}`, `CR-${n}`, `TX-${n}`],
    );
  }
  for (const [id, sid, slug] of [[storeA, sellerA, "store-a"], [storeB, sellerB, "store-b"]] as const) {
    await raw.query(
      `INSERT INTO stores (id, seller_id, market_id, slug, display_name_ar, kind, ships_from_country, status) VALUES ($1,$2,'EG',$3,$4,'local','EG','ACTIVE')`,
      [id, sid, slug, `متجر ${slug}`],
    );
  }
  const locA = randomUUID();
  const locB = randomUUID();
  await raw.query(`INSERT INTO inventory_locations (id, market_id, store_id) VALUES ($1,'EG',$2), ($3,'EG',$4)`, [locA, storeA, locB, storeB]);
  const clock = { t: Date.parse("2030-01-01T00:00:00.000Z") };
  const flags = new InMemorySoldOutFlags();
  const deps: InventoryDeps = { client: app, marketId: "EG", now: () => new Date(clock.t), soldOut: flags, ...over };
  const inv = new InventoryService(deps);
  const sku = async (store: "A" | "B", onHand: number): Promise<string> => {
    const [sid, loc] = store === "A" ? [storeA, locA] : [storeB, locB];
    const product = randomUUID();
    const id = randomUUID();
    await raw.query(`INSERT INTO products (id, store_id, market_id, primary_category_id, condition_grade_code) VALUES ($1,$2,'EG',$3,'new_with_tags')`, [product, sid, CAT]);
    await raw.query(`INSERT INTO skus (id, product_id, store_id, market_id, seller_sku, price_minor, currency) VALUES ($1,$2,$3,'EG',$4,10000,'EGP')`, [id, product, sid, `S-${id}`]);
    if (onHand > 0) await inv.adjustOnHand(staff([sid]), { skuId: id, locationId: loc, storeId: sid, delta: onHand, idempotencyKey: `seed-${id}`, source: "seller_edit" });
    return id;
  };
  return { raw, app, deps, flags, inv, res: new ReservationService(deps), storeA, storeB, locA, locB, picks, statements, sku, clock, close };
};

/** Seeds a defect card for the SKU's product (superuser insert) and returns its id. */
export const defectCard = async (raw: SqlClient, sku: string): Promise<string> => {
  const id = randomUUID();
  await raw.query(
    `INSERT INTO defect_cards (id, product_id, store_id, market_id, version, grade_code, summary_ar, affects_function, defect_count, inspected_by, inspected_at)
     SELECT $1, product_id, store_id, 'EG', 1, 'open_box', 'خدش بسيط', false, 1, 'seller', now() FROM skus WHERE id = $2`,
    [id, sku],
  );
  return id;
};

export const counts = async (raw: SqlClient, sku: string): Promise<{ available: number; reserved: number; claimed: number; onHand: number; committed: number }> => {
  const u = (await raw.query<{ a: number; r: number; c: number }>(
    `SELECT (count(*) FILTER (WHERE state='available'))::int a, (count(*) FILTER (WHERE state='reserved'))::int r, (count(*) FILTER (WHERE state='claimed'))::int c FROM inventory_units WHERE sku_id=$1`, [sku])).rows[0];
  const l = (await raw.query<{ on_hand: number; committed: number }>("SELECT on_hand, committed FROM inventory_levels WHERE sku_id=$1", [sku])).rows[0];
  return { available: u?.a ?? 0, reserved: u?.r ?? 0, claimed: u?.c ?? 0, onHand: l?.on_hand ?? 0, committed: l?.committed ?? 0 };
};
