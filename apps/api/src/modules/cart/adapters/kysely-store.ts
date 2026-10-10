import { sql, type Kysely } from "kysely";
import { z } from "zod";
import { money } from "../domain/bridge";
import type { CartLineRecord, CartRecord, CartRepository, LineSource } from "../domain/ports";

/** Raw SQL only, rows validated with Zod (same approach as the inventory adapter, ADR-0020). */
export type CartDb = Kysely<Record<string, never>>;

const Int = z.string().regex(/^-?\d+$/);
const Ms = Int.transform((s) => Number(s));
const Amount = Int.transform((s) => BigInt(s));
const SOURCES = ["pdp", "search", "stylist", "wishlist", "feed", "bag_suggestion", "reorder"] as const;

const CartRow = z.object({ id: z.string(), user_id: z.string(), version: z.number().int(), updated_ms: Ms });
const LineRow = z.object({
  id: z.string(),
  sku_id: z.string(),
  store_id: z.string(),
  qty: z.number().int(),
  price_at_add: Amount,
  threshold_at_add: Amount.nullable(),
  state: z.enum(["IN_BAG", "SAVED_FOR_LATER"]),
  source: z.enum(SOURCES).nullable(),
  unavailable_ms: Ms.nullable(),
  added_ms: Ms,
});

const iso = (ms: number): string => new Date(ms).toISOString();
const isoOrNull = (ms: number | null): string | null => (ms === null ? null : iso(ms));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const toLine = (raw: unknown): CartLineRecord => {
  const r = LineRow.parse(raw);
  return {
    id: r.id,
    skuId: r.sku_id,
    storeId: r.store_id,
    qty: r.qty,
    priceAtAdd: money(r.price_at_add),
    thresholdAtAdd: r.threshold_at_add === null ? null : money(r.threshold_at_add),
    state: r.state,
    source: r.source satisfies LineSource | null,
    unavailableSinceMs: r.unavailable_ms,
    addedAtMs: r.added_ms,
  };
};

/**
 * Postgres adapter. Each call is one transaction under the `system` DB role (authorization is the
 * policy guard and the owner-derived resolver; RLS stays on for every other role). Optimistic
 * concurrency is the `carts.version` column: `save` is a compare-and-set, and the lines are
 * replaced in the same transaction, so a lost update can never write lines. Prices are bigint
 * piastres, read as text. `updated_at` is maintained by the touch trigger (0002).
 */
export class KyselyCartRepository implements CartRepository {
  constructor(private readonly db: CartDb) {}

  private async tx<T>(run: (trx: CartDb) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      await sql`select set_config('app.role', 'system', true)`.execute(trx);
      return run(trx as unknown as CartDb);
    });
  }

  private async load(trx: CartDb, userId: string): Promise<CartRecord | null> {
    const c = await sql<unknown>`
      select id::text as id, user_id::text as user_id, version,
             floor(extract(epoch from updated_at) * 1000)::text as updated_ms
        from carts where user_id = ${userId}::uuid`.execute(trx);
    const head = c.rows[0];
    if (head === undefined) return null;
    const cart = CartRow.parse(head);
    const ls = await sql<unknown>`
      select id::text as id, sku_id::text as sku_id, store_id::text as store_id, qty,
             price_at_add_amount::text as price_at_add, threshold_at_add_amount::text as threshold_at_add,
             state, source, floor(extract(epoch from unavailable_since) * 1000)::text as unavailable_ms,
             floor(extract(epoch from added_at) * 1000)::text as added_ms
        from cart_lines where cart_id = ${cart.id}::uuid order by added_at, id`.execute(trx);
    return {
      id: cart.id,
      userId: cart.user_id,
      version: cart.version,
      updatedAtMs: cart.updated_ms,
      lines: ls.rows.map(toLine),
    };
  }

  async getOrCreate(userId: string, newId: string, nowMs: number): Promise<CartRecord> {
    return this.tx(async (trx) => {
      await sql`
        insert into carts (id, user_id, version, created_at, updated_at)
        values (${newId}::uuid, ${userId}::uuid, 0, ${iso(nowMs)}::timestamptz, ${iso(nowMs)}::timestamptz)
        on conflict (user_id) do nothing`.execute(trx);
      const cart = await this.load(trx, userId);
      if (cart === null) throw new Error("cart vanished after upsert");
      return cart;
    });
  }

  async save(cart: CartRecord, expectedVersion: number, _nowMs: number): Promise<boolean> {
    return this.tx(async (trx) => {
      const bumped = await sql<{ id: string }>`
        update carts set version = version + 1
         where id = ${cart.id}::uuid and user_id = ${cart.userId}::uuid and version = ${expectedVersion}
        returning id::text as id`.execute(trx);
      if (bumped.rows.length === 0) return false;
      const keep = cart.lines.map((l) => l.id);
      await sql`
        delete from cart_lines where cart_id = ${cart.id}::uuid and not (id::text = any (${keep}::text[]))`.execute(trx);
      for (const l of cart.lines) {
        // A different line id for an existing SKU replaces it (UNIQUE (cart_id, sku_id)).
        await sql`
          delete from cart_lines where cart_id = ${cart.id}::uuid and sku_id = ${l.skuId}::uuid and id <> ${l.id}::uuid`.execute(trx);
        await sql`
          insert into cart_lines (id, cart_id, sku_id, store_id, qty, price_at_add_amount, threshold_at_add_amount,
                                  state, source, unavailable_since, added_at)
          values (${l.id}::uuid, ${cart.id}::uuid, ${l.skuId}::uuid, ${l.storeId}::uuid, ${l.qty},
                  ${l.priceAtAdd.amount.toString()}::bigint,
                  ${l.thresholdAtAdd === null ? null : l.thresholdAtAdd.amount.toString()}::bigint,
                  ${l.state}, ${l.source}, ${isoOrNull(l.unavailableSinceMs)}::timestamptz, ${iso(l.addedAtMs)}::timestamptz)
          on conflict (id) do update set
            sku_id = excluded.sku_id, store_id = excluded.store_id, qty = excluded.qty,
            price_at_add_amount = excluded.price_at_add_amount,
            threshold_at_add_amount = excluded.threshold_at_add_amount,
            state = excluded.state, source = excluded.source,
            unavailable_since = excluded.unavailable_since, added_at = excluded.added_at
          where cart_lines.cart_id = ${cart.id}::uuid`.execute(trx);
      }
      return true;
    });
  }

  async setUnavailableSince(
    userId: string,
    changes: readonly { readonly lineId: string; readonly sinceMs: number | null }[],
  ): Promise<void> {
    if (changes.length === 0) return;
    await this.tx(async (trx) => {
      for (const ch of changes) {
        if (!UUID.test(ch.lineId)) continue;
        await sql`
          update cart_lines set unavailable_since = ${isoOrNull(ch.sinceMs)}::timestamptz
           where id = ${ch.lineId}::uuid
             and cart_id in (select id from carts where user_id = ${userId}::uuid)`.execute(trx);
      }
    });
  }

  async findLineOwner(lineId: string): Promise<string | null> {
    if (!UUID.test(lineId)) return null;
    return this.tx(async (trx) => {
      const r = await sql<{ user_id: string }>`
        select c.user_id::text as user_id from cart_lines l join carts c on c.id = l.cart_id
         where l.id = ${lineId}::uuid`.execute(trx);
      return r.rows[0]?.user_id ?? null;
    });
  }
}
