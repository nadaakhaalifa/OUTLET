import { sql, type Kysely } from "kysely";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { WishlistEvent, WishlistRepository } from "../domain/ports";
import { WISHLIST_INTENTS, type Money, type Wishlist, type WishlistItem } from "../domain/types";

/** Raw SQL only, rows validated with Zod (same approach as the inventory adapter, ADR-0020). */
export type WishlistDb = Kysely<Record<string, never>>;

const Int = z.string().regex(/^-?\d+$/);
const Ms = Int.transform((s) => Number(s));
const Amount = Int.transform((s) => BigInt(s));

const ListRow = z.object({
  id: z.string(),
  user_id: z.string(),
  intent: z.enum(WISHLIST_INTENTS),
  title: z.string(),
  target_date: z.string().nullable(),
  budget_amount: Amount.nullable(),
  cool_off_enabled: z.boolean(),
  gift_nickname: z.string().nullable(),
  gift_occasion: z.string().nullable(),
  gift_date: z.string().nullable(),
  share_token_hash: z.string().nullable(),
  share_created_ms: Ms.nullable(),
  share_expires_ms: Ms.nullable(),
  share_revoked_ms: Ms.nullable(),
  share_hide_prices: z.boolean(),
  created_ms: Ms,
  updated_ms: Ms,
});

const ItemRow = z.object({
  id: z.string(),
  wishlist_id: z.string(),
  user_id: z.string(),
  product_id: z.string(),
  sku_pref_id: z.string().nullable(),
  added_amount: Amount,
  note: z.string().nullable(),
  cool_off_ms: Ms.nullable(),
  added_ms: Ms,
});

const LIST_COLS = sql`
  id::text as id, user_id::text as user_id, intent, title, target_date::text as target_date,
  budget_amount::text as budget_amount, cool_off_enabled, gift_nickname, gift_occasion,
  gift_date::text as gift_date, encode(share_token_hash, 'hex') as share_token_hash,
  floor(extract(epoch from share_created_at) * 1000)::text as share_created_ms,
  floor(extract(epoch from share_expires_at) * 1000)::text as share_expires_ms,
  floor(extract(epoch from share_revoked_at) * 1000)::text as share_revoked_ms,
  share_hide_prices,
  floor(extract(epoch from created_at) * 1000)::text as created_ms,
  floor(extract(epoch from updated_at) * 1000)::text as updated_ms`;

const ITEM_COLS = sql`
  id::text as id, wishlist_id::text as wishlist_id, user_id::text as user_id, product_id::text as product_id,
  sku_pref_id::text as sku_pref_id, added_amount::text as added_amount, note,
  floor(extract(epoch from cool_off_until) * 1000)::text as cool_off_ms,
  floor(extract(epoch from added_at) * 1000)::text as added_ms`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (ms: number): string => new Date(ms).toISOString();
const isoOrNull = (ms: number | null): string | null => (ms === null ? null : iso(ms));
const egp = (amount: bigint): Money => ({ amount, currency: "EGP" });

const toList = (raw: unknown): Wishlist => {
  const r = ListRow.parse(raw);
  return {
    id: r.id,
    userId: r.user_id,
    intent: r.intent,
    title: r.title,
    targetDate: r.target_date,
    budget: r.budget_amount === null ? null : egp(r.budget_amount),
    giftFor:
      r.gift_nickname === null ? null : { nickname: r.gift_nickname, occasion: r.gift_occasion, date: r.gift_date },
    coolOffEnabled: r.cool_off_enabled,
    share:
      r.share_token_hash === null || r.share_created_ms === null
        ? null
        : {
            tokenHash: r.share_token_hash,
            createdAtMs: r.share_created_ms,
            expiresAtMs: r.share_expires_ms,
            revokedAtMs: r.share_revoked_ms,
            hidePrices: r.share_hide_prices,
          },
    createdAtMs: r.created_ms,
    updatedAtMs: r.updated_ms,
  };
};

const toItem = (raw: unknown): WishlistItem => {
  const r = ItemRow.parse(raw);
  return {
    id: r.id,
    wishlistId: r.wishlist_id,
    userId: r.user_id,
    productId: r.product_id,
    skuPref: r.sku_pref_id,
    addedPrice: egp(r.added_amount),
    note: r.note,
    coolOffUntilMs: r.cool_off_ms,
    addedAtMs: r.added_ms,
  };
};

/**
 * Postgres adapter. Each call is one transaction under the `system` DB role (authorization is the
 * policy guard; RLS stays on for every other role). Share-token hashes are stored as 32-byte
 * bytea and exposed as lowercase hex; amounts are bigint end to end (read as text).
 * `updated_at` is maintained by the touch trigger (0002), so after `save` it is the database clock.
 */
export class KyselyWishlistRepository implements WishlistRepository {
  /** `ids` supplies time-ordered outbox ids; without it a random UUID is used. */
  constructor(
    private readonly db: WishlistDb,
    private readonly ids: { uuidV7(): string } = { uuidV7: () => randomUUID() },
  ) {}

  /** Appends outbox rows INSIDE the caller's transaction (same commit as the state change). */
  private async emit(trx: WishlistDb, events: readonly WishlistEvent[]): Promise<void> {
    for (const e of events) {
      const body = e.type === "wishlist.alert_due" ? { alert: e.alert } : e.type === "wishlist.shared"
        ? { user_id: e.userId, expires_at_ms: e.expiresAtMs, hide_prices: e.hidePrices }
        : { user_id: e.userId };
      const aggregateId = e.type === "wishlist.alert_due" ? e.alert.wishlistId : e.wishlistId;
      const payload = JSON.stringify({ wishlist_id: aggregateId, ...body });
      await sql`
        insert into outbox_events (id, aggregate_type, aggregate_id, event_type, ordering_key, payload)
        values (${this.ids.uuidV7()}::uuid, 'wishlist', ${aggregateId}::uuid, ${e.type},
                ${`wishlist:${aggregateId}`}, ${payload}::jsonb)`.execute(trx);
    }
  }

  private async tx<T>(run: (trx: WishlistDb) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      await sql`select set_config('app.role', 'system', true)`.execute(trx);
      return run(trx as unknown as WishlistDb);
    });
  }

  async countByUser(userId: string): Promise<number> {
    return this.tx(async (trx) => {
      const r = await sql<{ n: string }>`select count(*)::text as n from wishlists where user_id = ${userId}::uuid`.execute(trx);
      return Number(r.rows[0]?.n ?? 0);
    });
  }

  async insert(l: Wishlist): Promise<void> {
    const s = l.share;
    await this.tx(async (trx) => {
      await sql`
        insert into wishlists (id, user_id, intent, title, target_date, budget_amount, budget_currency,
          cool_off_enabled, gift_nickname, gift_occasion, gift_date, share_token_hash, share_created_at,
          share_expires_at, share_revoked_at, share_hide_prices, created_at, updated_at)
        values (${l.id}::uuid, ${l.userId}::uuid, ${l.intent}, ${l.title}, ${l.targetDate}::date,
          ${l.budget === null ? null : l.budget.amount.toString()}::bigint, ${l.budget === null ? null : l.budget.currency},
          ${l.coolOffEnabled}, ${l.giftFor?.nickname ?? null}, ${l.giftFor?.occasion ?? null}, ${l.giftFor?.date ?? null}::date,
          decode(${s?.tokenHash ?? null}::text, 'hex'), ${isoOrNull(s?.createdAtMs ?? null)}::timestamptz,
          ${isoOrNull(s?.expiresAtMs ?? null)}::timestamptz, ${isoOrNull(s?.revokedAtMs ?? null)}::timestamptz,
          ${s?.hidePrices ?? false}, ${iso(l.createdAtMs)}::timestamptz, ${iso(l.updatedAtMs)}::timestamptz)`.execute(trx);
    });
  }

  async get(id: string): Promise<Wishlist | null> {
    if (!UUID.test(id)) return null;
    return this.tx(async (trx) => {
      const r = await sql<unknown>`select ${LIST_COLS} from wishlists where id = ${id}::uuid`.execute(trx);
      const row = r.rows[0];
      return row === undefined ? null : toList(row);
    });
  }

  /** Owner-scoped (never touches another user's row); revocation of the same token is monotonic. */
  async save(l: Wishlist, events: readonly WishlistEvent[] = []): Promise<void> {
    const s = l.share;
    await this.tx(async (trx) => {
      await sql`
        update wishlists set
          intent = ${l.intent}, title = ${l.title}, target_date = ${l.targetDate}::date,
          budget_amount = ${l.budget === null ? null : l.budget.amount.toString()}::bigint,
          budget_currency = ${l.budget === null ? null : l.budget.currency},
          cool_off_enabled = ${l.coolOffEnabled},
          gift_nickname = ${l.giftFor?.nickname ?? null}, gift_occasion = ${l.giftFor?.occasion ?? null},
          gift_date = ${l.giftFor?.date ?? null}::date,
          share_token_hash = decode(${s?.tokenHash ?? null}::text, 'hex'),
          share_created_at = ${isoOrNull(s?.createdAtMs ?? null)}::timestamptz,
          share_expires_at = ${isoOrNull(s?.expiresAtMs ?? null)}::timestamptz,
          share_revoked_at = case
            when share_token_hash is not null and share_token_hash = decode(${s?.tokenHash ?? null}::text, 'hex')
              and share_revoked_at is not null then share_revoked_at
            else ${isoOrNull(s?.revokedAtMs ?? null)}::timestamptz end,
          share_hide_prices = ${s?.hidePrices ?? false}
         where id = ${l.id}::uuid and user_id = ${l.userId}::uuid`.execute(trx);
      await this.emit(trx, events);
    });
  }

  async delete(id: string): Promise<void> {
    if (!UUID.test(id)) return;
    // Items and dedupe rows go with the list through ON DELETE CASCADE (0014).
    await this.tx(async (trx) => {
      await sql`delete from wishlists where id = ${id}::uuid`.execute(trx);
    });
  }

  async listByUser(
    userId: string,
    page: { readonly after: { readonly createdAtMs: number; readonly id: string } | null; readonly limit: number },
  ): Promise<readonly Wishlist[]> {
    const after = page.after;
    if (after !== null && !UUID.test(after.id)) return [];
    return this.tx(async (trx) => {
      const r =
        after === null
          ? await sql<unknown>`
              select ${LIST_COLS} from wishlists where user_id = ${userId}::uuid
               order by created_at desc, id desc limit ${page.limit}`.execute(trx)
          : await sql<unknown>`
              select ${LIST_COLS} from wishlists
               where user_id = ${userId}::uuid
                 and (created_at < ${iso(after.createdAtMs)}::timestamptz
                      or (created_at = ${iso(after.createdAtMs)}::timestamptz and id < ${after.id}::uuid))
               order by created_at desc, id desc limit ${page.limit}`.execute(trx);
      return r.rows.map(toList);
    });
  }

  async findByShareHash(tokenHash: string): Promise<Wishlist | null> {
    if (!/^[0-9a-f]{64}$/.test(tokenHash)) return null;
    return this.tx(async (trx) => {
      const r = await sql<unknown>`
        select ${LIST_COLS} from wishlists where share_token_hash = decode(${tokenHash}, 'hex')`.execute(trx);
      const row = r.rows[0];
      return row === undefined ? null : toList(row);
    });
  }

  async listWithDates(): Promise<readonly Wishlist[]> {
    return this.tx(async (trx) => {
      const r = await sql<unknown>`
        select ${LIST_COLS} from wishlists where target_date is not null or gift_date is not null
         order by created_at, id`.execute(trx);
      return r.rows.map(toList);
    });
  }

  async items(wishlistId: string): Promise<readonly WishlistItem[]> {
    if (!UUID.test(wishlistId)) return [];
    return this.tx(async (trx) => {
      const r = await sql<unknown>`
        select ${ITEM_COLS} from wishlist_items where wishlist_id = ${wishlistId}::uuid
         order by added_at, id`.execute(trx);
      return r.rows.map(toItem);
    });
  }

  async itemCount(wishlistId: string): Promise<number> {
    if (!UUID.test(wishlistId)) return 0;
    return this.tx(async (trx) => {
      const r = await sql<{ n: string }>`
        select count(*)::text as n from wishlist_items where wishlist_id = ${wishlistId}::uuid`.execute(trx);
      return Number(r.rows[0]?.n ?? 0);
    });
  }

  async insertItem(i: WishlistItem): Promise<void> {
    await this.tx(async (trx) => {
      await sql`
        insert into wishlist_items (id, wishlist_id, user_id, product_id, sku_pref_id, added_amount,
          added_currency, note, cool_off_until, added_at)
        values (${i.id}::uuid, ${i.wishlistId}::uuid, ${i.userId}::uuid, ${i.productId}::uuid,
          ${i.skuPref}::uuid, ${i.addedPrice.amount.toString()}::bigint, ${i.addedPrice.currency}, ${i.note},
          ${isoOrNull(i.coolOffUntilMs)}::timestamptz, ${iso(i.addedAtMs)}::timestamptz)`.execute(trx);
    });
  }

  async deleteItem(wishlistId: string, itemId: string): Promise<boolean> {
    if (!UUID.test(wishlistId) || !UUID.test(itemId)) return false;
    return this.tx(async (trx) => {
      const r = await sql<{ id: string }>`
        delete from wishlist_items where id = ${itemId}::uuid and wishlist_id = ${wishlistId}::uuid
        returning id::text as id`.execute(trx);
      return r.rows.length > 0;
    });
  }

  async clearCoolOff(wishlistId: string): Promise<void> {
    if (!UUID.test(wishlistId)) return;
    await this.tx(async (trx) => {
      await sql`update wishlist_items set cool_off_until = null where wishlist_id = ${wishlistId}::uuid`.execute(trx);
    });
  }

  async itemsByProduct(productId: string): Promise<readonly WishlistItem[]> {
    if (!UUID.test(productId)) return [];
    return this.tx(async (trx) => {
      const r = await sql<unknown>`
        select ${ITEM_COLS} from wishlist_items where product_id = ${productId}::uuid order by added_at, id`.execute(trx);
      return r.rows.map(toItem);
    });
  }

  async claimAlert(dedupeKey: string, wishlistId: string, events: readonly WishlistEvent[] = []): Promise<boolean> {
    return this.tx(async (trx) => {
      const r = await sql<{ k: string }>`
        insert into wishlist_alert_dedupe (dedupe_key, wishlist_id) values (${dedupeKey}, ${wishlistId}::uuid)
        on conflict (dedupe_key) do nothing returning dedupe_key as k`.execute(trx);
      if (r.rows.length === 0) return false;
      await this.emit(trx, events);
      return true;
    });
  }
}
