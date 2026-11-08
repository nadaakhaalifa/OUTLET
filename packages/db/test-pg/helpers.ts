import { randomUUID } from "node:crypto";
import pg from "pg";
import { brandClient } from "../src/index.js";
import type { DbRole, Queryable, RoleSqlClient } from "../src/index.js";

/** Real-Postgres suite switch: every file wraps its describe in describe.skipIf(!ENABLED). */
export const ENABLED = typeof process.env.DATABASE_URL_DIRECT === "string" && process.env.DATABASE_URL_DIRECT !== "";

export const url = (name: "DIRECT" | "APP" | "AUTH" | "WORKER" | "MIGRATOR"): string => {
  const v = process.env[`DATABASE_URL_${name}`];
  if (v === undefined || v === "") throw new Error(`DATABASE_URL_${name} is required for the real-Postgres suite`);
  return v;
};

export const MARKET = "EG";
/** Seeded by migration 0010 / used by the inventory fixtures. */
export const CAT = "00000000-0000-4000-8000-0000000c0011";

export const pool = (name: "DIRECT" | "APP" | "AUTH" | "WORKER" | "MIGRATOR", max: number, tag: string): pg.Pool =>
  new pg.Pool({ connectionString: url(name), max, application_name: tag, connectionTimeoutMillis: 30_000 });

/** Same adapter as apps/api platform/db.ts pgSqlClient: BEGIN/COMMIT on one pooled connection, ROLLBACK on throw. */
export const sqlClient = <R extends DbRole>(p: pg.Pool): RoleSqlClient<R> =>
  brandClient<R>({
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- matches the Queryable port signature
    query: async <Row extends object>(sql: string, params?: readonly unknown[]) => ({ rows: (await p.query(sql, params ? [...params] : [])).rows as Row[] }),
    transaction: async <T>(fn: (tx: Queryable) => Promise<T>): Promise<T> => {
      const conn = await p.connect();
      const tx: Queryable = {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- matches the Queryable port signature
        query: async <Row extends object>(sql: string, params?: readonly unknown[]) => ({ rows: (await conn.query(sql, params ? [...params] : [])).rows as Row[] }),
      };
      try {
        await conn.query("BEGIN");
        const out = await fn(tx);
        await conn.query("COMMIT");
        conn.release();
        return out;
      } catch (e) {
        try {
          await conn.query("ROLLBACK");
          conn.release();
        } catch {
          conn.release(true);
        }
        throw e;
      }
    },
  });

export interface Tenant {
  readonly sellerId: string;
  readonly storeId: string;
  readonly locationId: string;
  readonly userId: string;
  readonly productIds: string[];
  readonly cartId: string;
  readonly orderGroupId: string;
}

/** Superuser seed of one tenant: seller, store, location, 3 products, a user with a cart line, a store membership and an order group. */
export const seedTenant = async (admin: pg.Pool, label: string, nowIso = new Date().toISOString()): Promise<Tenant> => {
  const sellerId = randomUUID();
  const storeId = randomUUID();
  const locationId = randomUUID();
  const userId = randomUUID();
  const cartId = randomUUID();
  const sessionId = randomUUID();
  const orderGroupId = randomUUID();
  const productIds = [randomUUID(), randomUUID(), randomUUID()];
  const q = (sql: string, params: unknown[] = []): Promise<unknown> => admin.query(sql, params);
  await q(
    `INSERT INTO sellers (id, home_market_id, market_id, legal_type, legal_name_ar, legal_name_en, commercial_register_no, tax_card_no, governorate_code, governorate_name_ar, status)
     VALUES ($1,'EG','EG','company',$2,$3,$4,$5,'CAI','القاهرة','active')`,
    [sellerId, `شركة ${label}`, `Company ${label}`, `CR-${sellerId}`, `TX-${sellerId}`],
  );
  await q(`INSERT INTO stores (id, seller_id, market_id, slug, display_name_ar, kind, ships_from_country, status) VALUES ($1,$2,'EG',$3,$4,'local','EG','ACTIVE')`, [storeId, sellerId, `s-${storeId}`, `متجر ${label}`]);
  await q(`INSERT INTO inventory_locations (id, market_id, store_id) VALUES ($1,'EG',$2)`, [locationId, storeId]);
  await q(`INSERT INTO users (id, market_id, status, created_at, updated_at) VALUES ($1,'EG','active',$2,$2)`, [userId, nowIso]);
  let first: string | undefined;
  for (const pid of productIds) {
    await q(`INSERT INTO products (id, store_id, market_id, primary_category_id, condition_grade_code) VALUES ($1,$2,'EG',$3,'new_with_tags')`, [pid, storeId, CAT]);
    first ??= pid;
  }
  const skuId = randomUUID();
  await q(`INSERT INTO skus (id, product_id, store_id, market_id, seller_sku, price_minor, currency) VALUES ($1,$2,$3,'EG',$4,10000,'EGP')`, [skuId, first, storeId, `S-${skuId}`]);
  await q(`INSERT INTO carts (id, user_id, market_id, currency) VALUES ($1,$2,'EG','EGP')`, [cartId, userId]);
  await q(
    `INSERT INTO cart_lines (id, cart_id, user_id, market_id, sku_id, product_id, store_ref, qty, price_at_add_minor, currency) VALUES ($1,$2,$3,'EG',$4,$5,$6,1,10000,'EGP')`,
    [randomUUID(), cartId, userId, skuId, first, storeId],
  );
  await q(`INSERT INTO store_members (id, store_id, market_id, user_id, role_code, status, accepted_at) VALUES ($1,$2,'EG',$3,'owner','active',$4)`, [randomUUID(), storeId, userId, nowIso]);
  await q(
    `INSERT INTO checkout_sessions (id, user_id, market_id, currency, quote, quote_hash, payment_method, price_lock_expires_at) VALUES ($1,$2,'EG','EGP','{}'::jsonb,$3,'cod',$4)`,
    [sessionId, userId, Buffer.alloc(32, 1), nowIso],
  );
  await q(
    `INSERT INTO order_groups (id, user_id, market_id, currency, status, funds_flow, checkout_session_id, idempotency_key, payment_method, items_subtotal_minor, shipping_minor, shipping_vat_minor, vat_minor, total_minor, placed_at)
     VALUES ($1,$2,'EG','EGP','PENDING_PAYMENT','collect_payout',$3,$4,'cod',10000,0,0,0,10000,$5)`,
    [orderGroupId, userId, sessionId, randomUUID(), nowIso],
  );
  return { sellerId, storeId, locationId, userId, productIds, cartId, orderGroupId };
};
