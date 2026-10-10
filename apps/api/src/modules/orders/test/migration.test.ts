import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTestDatabaseUpTo, lintMigration } from "@outlet/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";

const SQL = readFileSync(
  fileURLToPath(new URL("../../../../../../packages/db/migrations/0019_orders.sql", import.meta.url)),
  "utf8",
);
const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const STORE_A = "00000000-0000-4000-a000-00000000000a";
const STORE_B = "00000000-0000-4000-a000-00000000000b";
let db: PGlite;

const as = async <T>(role: string, userId: string, stores: string, fn: () => Promise<T>): Promise<T> => {
  await db.exec("BEGIN");
  try {
    await db.exec("SET LOCAL ROLE app_user");
    await db.query("select set_config('app.role',$1,true), set_config('app.user_id',$2,true), set_config('app.store_ids',$3,true)", [
      role,
      userId,
      stores,
    ]);
    const out = await fn();
    await db.exec("COMMIT");
    return out;
  } catch (e) {
    await db.exec("ROLLBACK");
    throw e;
  }
};

const count = async (table: string): Promise<number> =>
  Number((await db.query<{ n: string }>(`select count(*)::text as n from ${table}`)).rows[0]?.n);

beforeAll(async () => {
  db = await createTestDatabaseUpTo(19);
  await db.exec(`insert into users (id, status) values ('${U(1)}','active'), ('${U(2)}','active')`);
  await db.exec(`
    insert into order_groups (id, user_id, status, payment_method, payment_type, subtotal_amount, shipping_amount,
                              discount_amount, vat_amount, total_amount, idempotency_key, placed_at)
    values ('${U(100)}','${U(1)}','PAID','card','prepaid',100,0,0,0,100,'k1', now()),
           ('${U(101)}','${U(2)}','PAID','card','prepaid',100,0,0,0,100,'k2', now());
    insert into seller_orders (id, order_group_id, store_id, user_id, status, payment_type, subtotal_amount,
                               shipping_amount, discount_amount, vat_amount, total_amount, commission_rate_snapshot_bps)
    values ('${U(200)}','${U(100)}','${STORE_A}','${U(1)}','PAID','prepaid',100,0,0,0,100,1500),
           ('${U(201)}','${U(101)}','${STORE_B}','${U(2)}','PAID','prepaid',100,0,0,0,100,1500);
    insert into order_buyer_contacts (seller_order_id, store_id, first_name, phone_relay, governorate_code)
    values ('${U(200)}','${STORE_A}','Mona','+20100000099','EG-C'), ('${U(201)}','${STORE_B}','Omar',null,'EG-ALX');`);
}, 60_000);
afterAll(async () => {
  await db.close();
});

describe("0019_orders", () => {
  it("passes the expand-only migration linter", () => {
    expect(lintMigration(SQL)).toEqual([]);
  });

  it("class A/B2 RLS: tenants see their store, shoppers their own, strangers nothing", async () => {
    expect(await as("seller", U(50), STORE_A, () => count("seller_orders"))).toBe(1);
    expect(await as("seller", U(51), `${STORE_A},${STORE_B}`, () => count("seller_orders"))).toBe(2);
    expect(await as("customer", U(1), "", () => count("seller_orders"))).toBe(1);
    expect(await as("customer", U(1), "", () => count("order_groups"))).toBe(1);
    expect(await as("customer", U(99), "", () => count("seller_orders"))).toBe(0);
    expect(await as("seller", U(50), "", () => count("seller_orders"))).toBe(0);
    expect(await as("seller", U(50), STORE_A, () => count("order_lines"))).toBe(0);
  });

  it("buyer contacts: tenant and system only, never the shopper", async () => {
    expect(await as("seller", U(50), STORE_A, () => count("order_buyer_contacts"))).toBe(1);
    expect(await as("customer", U(1), "", () => count("order_buyer_contacts"))).toBe(0);
    expect(await as("system", "", "", () => count("order_buyer_contacts"))).toBe(2);
  });

  it("tenants cannot insert intake rows or edit another store's order", async () => {
    await expect(
      as("seller", U(50), STORE_A, () =>
        db.query(
          `insert into order_groups (id, user_id, status, payment_method, payment_type, subtotal_amount, shipping_amount,
                                     discount_amount, vat_amount, total_amount, idempotency_key, placed_at)
           values ('${U(300)}','${U(1)}','PAID','card','prepaid',1,0,0,0,1,'k3', now())`,
        ),
      ),
    ).rejects.toThrow();
    const upd = await as("seller", U(50), STORE_A, () =>
      db.query(`update seller_orders set status = 'ACCEPTED' where id = '${U(201)}' returning id`),
    );
    expect(upd.rows).toHaveLength(0);
  });

  it("enforces check constraints: money, currency, status, SLA indexable fields", async () => {
    const bad = (sql: string) => expect(db.query(sql)).rejects.toThrow();
    await bad(`update seller_orders set subtotal_amount = -1 where id = '${U(200)}'`);
    await bad(`update seller_orders set status = 'BOGUS' where id = '${U(200)}'`);
    await bad(`update seller_orders set commission_rate_snapshot_bps = 10001 where id = '${U(200)}'`);
    await bad(`update order_groups set currency = 'USD' where id = '${U(100)}'`);
    await bad(
      `insert into order_lines (id, seller_order_id, store_id, sku_id, product_id, qty, unit_price_amount, title_ar)
       values ('${U(400)}','${U(200)}','${STORE_A}','${U(1)}','${U(2)}',0,1,'x')`,
    );
  });

  it("history is unique per (order, command key)", async () => {
    await db.exec(`insert into order_status_history (id, seller_order_id, store_id, from_status, to_status, event,
                                                     actor_type, command_key)
                   values ('${U(500)}','${U(200)}','${STORE_A}','PAID','ACCEPTED','SELLER_ACCEPT','SELLER','accept:k')`);
    await expect(
      db.query(`insert into order_status_history (id, seller_order_id, store_id, from_status, to_status, event,
                                                  actor_type, command_key)
                values ('${U(501)}','${U(200)}','${STORE_A}','PAID','ACCEPTED','SELLER_ACCEPT','SELLER','accept:k')`),
    ).rejects.toThrow();
  });

  it("ownership columns are immutable", async () => {
    await expect(db.query(`update seller_orders set store_id = '${STORE_B}' where id = '${U(200)}'`)).rejects.toThrow(
      /immutable/,
    );
  });
});
