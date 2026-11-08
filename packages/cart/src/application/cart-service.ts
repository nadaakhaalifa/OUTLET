import { withDbContext } from "@outlet/db";
import type { Queryable } from "@outlet/db";
import { IdempotencyStore, requestHash } from "@outlet/idempotency";
import { toWire } from "@outlet/money";
import type { Currency, Money, MoneyWire } from "@outlet/money";
import { authorize } from "@outlet/policy";
import type { Principal } from "@outlet/policy";
import { CartError } from "../domain/errors.js";
import { assertQty, groupByStore, itemsSubtotal, mergeQty, noticesOf } from "../domain/bag.js";
import type { CartLineRow, CatalogSnapshot, LineState, Notice, SkuSnapshot, StoreGroup, StoreSnapshot } from "../domain/bag.js";
import { makeEnv } from "./env.js";
import type { CartDeps, Env } from "./env.js";

export interface CartView {
  readonly id: string | null;
  readonly currency: Currency;
  readonly version: number;
  readonly groups: readonly StoreGroup[];
  readonly itemsSubtotal: Money;
  readonly notices: readonly Notice[];
}

export interface AddLineInput {
  readonly skuId: string;
  readonly qty: number;
  readonly source?: "pdp" | "quick_add" | "shelf" | "wishlist" | "drop" | "stylist";
}
export interface AddLineResult {
  readonly lineId: string;
  readonly qty: number;
  readonly merged: boolean;
}

/** Wire shape of a group total, for the HTTP layer (OpenAPI CartStoreGroup money fields). */
export const groupWire = (g: StoreGroup): { subtotal: MoneyWire; threshold: MoneyWire; remaining: MoneyWire } => ({
  subtotal: toWire(g.subtotal),
  threshold: toWire({ amountMinor: g.freeDelivery.thresholdMinor, currency: g.subtotal.currency }),
  remaining: toWire({ amountMinor: g.freeDelivery.remainingMinor, currency: g.subtotal.currency }),
});

interface LineRow {
  id: string; sku_id: string; product_id: string; store_id: string; qty: number; price_at_add_minor: string | bigint; currency: Currency;
  source: string; added_at: Date | string; last_state: LineState;
}
interface CartRow { id: string; version: number; currency: Currency }
interface JoinedRow extends CartRow {
  line_id: string | null; line_currency: Currency | null; sku_id: string; product_id: string; store_id: string; qty: number; price_at_add_minor: string | bigint;
  source: string; added_at: Date | string; last_state: LineState;
}
interface VariantRow { sku_id: string; product_id: string; store_ref: string; listing_status: string; price_minor: string; currency: Currency }

const iso = (v: Date | string): string => (v instanceof Date ? v : new Date(v)).toISOString();
const toLine = (r: LineRow): CartLineRow => ({
  id: r.id, skuId: r.sku_id, productId: r.product_id, storeId: r.store_id, qty: r.qty, priceAtAddMinor: BigInt(r.price_at_add_minor), currency: r.currency, source: r.source, addedAt: iso(r.added_at), lastState: r.last_state,
});

const VARIANTS_SQL = `SELECT v ->> 'sku_id' AS sku_id, l.id AS product_id, l.store_ref, l.status AS listing_status, v ->> 'price_minor' AS price_minor, v ->> 'currency' AS currency
   FROM catalog_public_listings l CROSS JOIN LATERAL jsonb_array_elements(l.variants) v WHERE l.id = ANY($1::uuid[]) AND l.market_id = $2`;

export class CartService {
  private readonly env: Env;
  constructor(deps: CartDeps) {
    this.env = makeEnv(deps);
  }

  private asUser<T>(userId: string, fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return withDbContext(this.env.client, { kind: "user", marketId: this.env.marketId, userId }, fn);
  }

  /** Free-delivery threshold of one store in minor units: the per-store row, else the admin default. */
  async thresholdFor(storeId: string): Promise<bigint> {
    const r = await withDbContext(this.env.client, { kind: "user", marketId: this.env.marketId }, (tx) =>
      tx.query<{ threshold_minor: string | bigint }>("SELECT threshold_minor FROM cart_store_thresholds WHERE store_ref = $1 AND market_id = $2", [storeId, this.env.marketId]),
    );
    const row = r.rows[0];
    return row === undefined ? this.env.defaultThresholdMinor : BigInt(row.threshold_minor);
  }

  /** Per-store threshold write. Deny by default through @outlet/policy store.write (the store owner; a foreign store is not found). */
  async setThreshold(actor: Principal, storeId: string, thresholdMinor: bigint): Promise<void> {
    const d = authorize(actor, "store.write", { type: "cart_threshold", storeId, marketId: this.env.marketId });
    if (d.effect === "deny") throw new CartError(d.reason, d.reason === "not_found" ? "not found" : "forbidden");
    if (thresholdMinor < 0n) throw new CartError("invalid_qty", "threshold must not be negative");
    await withDbContext(this.env.client, { kind: "store", marketId: this.env.marketId, storeId, ...(actor.userId === undefined ? {} : { userId: actor.userId }) }, (tx) =>
      tx.query(
        `INSERT INTO cart_store_thresholds (store_ref, market_id, threshold_minor, updated_by, updated_at) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (store_ref) DO UPDATE SET threshold_minor = EXCLUDED.threshold_minor, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
        [storeId, this.env.marketId, thresholdMinor.toString(), actor.userId ?? null, this.env.now().toISOString()],
      ),
    );
  }

  /** Statement 2 and 3 of a read: published sku prices by product, then store status + thresholds. */
  private async snapshot(tx: Queryable, lines: readonly CartLineRow[]): Promise<{ snap: CatalogSnapshot; byStore: Map<string, string[]> }> {
    const productIds = [...new Set(lines.map((l) => l.productId))];
    const storeIds = [...new Set(lines.map((l) => l.storeId))];
    const variants = productIds.length === 0 ? [] : (await tx.query<VariantRow>(VARIANTS_SQL, [productIds, this.env.marketId])).rows;
    const stores =
      storeIds.length === 0
        ? []
        : (
            await tx.query<{ id: string; slug: string; display_name_ar: string; threshold_minor: string | bigint | null }>(
              `SELECT s.id, s.slug, s.display_name_ar, t.threshold_minor FROM catalog_public_stores s
                 LEFT JOIN cart_store_thresholds t ON t.store_ref = s.id WHERE s.id = ANY($1::uuid[]) AND s.market_id = $2`,
              [storeIds, this.env.marketId],
            )
          ).rows;
    const skus = new Map<string, SkuSnapshot>();
    for (const v of variants) {
      if (v.listing_status !== "PUBLISHED") continue; // SOLD_OUT and PAUSED listings: the sku is absent => unavailable
      skus.set(v.sku_id, { skuId: v.sku_id, priceMinor: BigInt(v.price_minor), currency: v.currency, available: true });
    }
    const storeMap = new Map<string, StoreSnapshot>();
    for (const s of stores) storeMap.set(s.id, { storeId: s.id, slug: s.slug, nameAr: s.display_name_ar, ...(s.threshold_minor === null ? {} : { thresholdMinor: BigInt(s.threshold_minor) }) });
    const byStore = new Map<string, string[]>();
    for (const l of lines) if (skus.has(l.skuId) && storeMap.has(l.storeId)) byStore.set(l.storeId, [...(byStore.get(l.storeId) ?? []), l.skuId]);
    return { snap: { skus, stores: storeMap }, byStore };
  }

  private async applyStock(snap: CatalogSnapshot, byStore: Map<string, string[]>): Promise<CatalogSnapshot> {
    if (byStore.size === 0) return snap;
    const ok = await this.env.availability.availableSkus({ skuIdsByStore: byStore });
    const skus = new Map<string, SkuSnapshot>();
    for (const [id, s] of snap.skus) skus.set(id, { ...s, available: ok.has(id) });
    return { skus, stores: snap.stores };
  }

  private async load(userId: string): Promise<{ cart: CartRow | undefined; lines: CartLineRow[]; snap: CatalogSnapshot }> {
    const { cart, lines, snap, byStore } = await this.asUser(userId, async (tx) => {
      const rows = (
        await tx.query<JoinedRow>(
          `SELECT c.id, c.version, c.currency, l.id AS line_id, l.sku_id, l.product_id, l.store_ref AS store_id, l.qty, l.price_at_add_minor, l.currency AS line_currency, l.source, l.added_at, l.last_state
             FROM carts c LEFT JOIN cart_lines l ON l.cart_id = c.id
            WHERE c.user_id = $1 AND c.market_id = $2 AND c.status = 'active' ORDER BY l.added_at, l.id`,
          [userId, this.env.marketId],
        )
      ).rows;
      const first = rows[0];
      const parsed: CartLineRow[] = rows.flatMap((r) => (r.line_id === null ? [] : [toLine({ ...r, id: r.line_id, currency: r.line_currency ?? r.currency })]));
      const s = await this.snapshot(tx, parsed);
      return { cart: first === undefined ? undefined : { id: first.id, version: first.version, currency: first.currency }, lines: parsed, ...s };
    });
    return { cart, lines, snap: await this.applyStock(snap, byStore) };
  }

  /** The shopper's bag: 3 statements in the user transaction (cart+lines, published sku prices, stores+thresholds) plus the stock check. Prices are never cached. */
  async get(userId: string): Promise<CartView> {
    const { cart, lines, snap } = await this.load(userId);
    const currency = cart?.currency ?? this.env.currency;
    const groups = groupByStore(lines, snap, currency, this.env.defaultThresholdMinor);
    return { id: cart?.id ?? null, currency, version: cart?.version ?? 0, groups, itemsSubtotal: itemsSubtotal(groups, currency), notices: noticesOf(groups) };
  }

  /** Recomputes every line state against live prices and stock; emits cart.line_unavailable once when a line turns unavailable or its store locks. */
  async refreshPrices(userId: string): Promise<CartView> {
    const view = await this.get(userId);
    const changed = view.groups.flatMap((g) => g.lines).filter((v) => v.state !== v.line.lastState);
    if (changed.length === 0 || view.id === null) return view;
    const cartId = view.id;
    await this.asUser(userId, async (tx) => {
      for (const v of changed) {
        await tx.query("UPDATE cart_lines SET last_state = $2 WHERE id = $1", [v.line.id, v.state]);
        if (v.state === "unavailable" || v.state === "store_locked") await this.emit(tx, "cart.line_unavailable", cartId, { line_id: v.line.id, sku_id: v.line.skuId, store_id: v.line.storeId, state: v.state });
      }
    });
    return view;
  }

  async addLine(userId: string, input: AddLineInput, idempotencyKey: string): Promise<AddLineResult> {
    assertQty(input.qty);
    const route = "cart.addLine";
    return this.asUser(userId, async (tx) => {
      const idem = new IdempotencyStore(tx, this.env.now);
      const hashed = requestHash({ skuId: input.skuId, qty: input.qty, source: input.source ?? "pdp" });
      const begun = await idem.begin({ key: idempotencyKey, route, actorId: userId, requestHash: hashed });
      if (begun.kind === "replay") return begun.response.body as unknown as AddLineResult;
      if (begun.kind === "conflict") throw new CartError("idempotency_conflict", "idempotency key reused with a different request");
      if (begun.kind === "in_progress") throw new CartError("idempotency_in_progress", "request in progress");

      const sku = (await tx.query<VariantRow>(
        VARIANTS_SQL.replace("WHERE l.id = ANY($1::uuid[]) AND l.market_id = $2", "WHERE l.variants @> $1::jsonb AND l.market_id = $2 AND v ->> 'sku_id' = $3"),
        [JSON.stringify([{ sku_id: input.skuId }]), this.env.marketId, input.skuId],
      )).rows[0];
      if (sku === undefined) throw new CartError("not_found", "sku not found");
      if (sku.listing_status !== "PUBLISHED") throw new CartError("unavailable", "item unavailable");
      if (sku.currency !== this.env.currency) throw new CartError("currency_mismatch", "currency does not match the market");

      const now = this.env.now().toISOString();
      const cart = (await tx.query<{ id: string }>(
        `INSERT INTO carts (id, user_id, market_id, currency, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$5)
         ON CONFLICT (user_id, market_id) WHERE status = 'active' DO UPDATE SET updated_at = EXCLUDED.updated_at RETURNING id`,
        [this.env.newId(), userId, this.env.marketId, this.env.currency, now],
      )).rows[0];
      if (cart === undefined) throw new CartError("not_found", "cart not found");

      const existing = (await tx.query<{ sku_id: string; qty: number }>("SELECT sku_id, qty FROM cart_lines WHERE cart_id = $1", [cart.id])).rows.map((r) => ({ skuId: r.sku_id, qty: r.qty }));
      const merged = mergeQty({ lines: existing, skuId: input.skuId, qty: input.qty });
      const isMerge = existing.some((l) => l.skuId === input.skuId);
      const before = await this.storeSubtotal(tx, cart.id, sku.store_ref);

      const line = (await tx.query<{ id: string }>(
        `INSERT INTO cart_lines (id, cart_id, user_id, market_id, sku_id, product_id, store_ref, qty, price_at_add_minor, currency, source, added_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)
         ON CONFLICT (cart_id, sku_id) DO UPDATE SET qty = EXCLUDED.qty, updated_at = EXCLUDED.updated_at, version = cart_lines.version + 1
         RETURNING id`,
        [this.env.newId(), cart.id, userId, this.env.marketId, input.skuId, sku.product_id, sku.store_ref, merged, sku.price_minor, sku.currency, input.source ?? "pdp", now],
      )).rows[0];
      if (line === undefined) throw new CartError("not_found", "line not found");
      await tx.query("UPDATE carts SET version = version + 1, updated_at = $2 WHERE id = $1", [cart.id, now]);
      await this.emit(tx, "cart.line_added", cart.id, { line_id: line.id, sku_id: input.skuId, store_id: sku.store_ref, qty: merged, merged: isMerge });

      const after = await this.storeSubtotal(tx, cart.id, sku.store_ref);
      const threshold = await tx.query<{ threshold_minor: string | bigint }>("SELECT threshold_minor FROM cart_store_thresholds WHERE store_ref = $1", [sku.store_ref]);
      const limit = threshold.rows[0] === undefined ? this.env.defaultThresholdMinor : BigInt(threshold.rows[0].threshold_minor);
      if (before < limit && after >= limit) await this.emit(tx, "cart.free_delivery_unlocked", cart.id, { store_id: sku.store_ref, threshold_minor: limit.toString() });

      const result: AddLineResult = { lineId: line.id, qty: merged, merged: isMerge };
      await idem.complete({ key: idempotencyKey, route, actorId: userId }, { status: 201, body: { ...result } });
      return result;
    });
  }

  /** Live subtotal of the store's lines in this cart (published, in-stock-by-listing skus only). */
  private async storeSubtotal(tx: Queryable, cartId: string, storeId: string): Promise<bigint> {
    const r = await tx.query<{ total: string | bigint | null }>(
      `SELECT SUM((v ->> 'price_minor')::bigint * cl.qty) AS total
         FROM cart_lines cl JOIN catalog_public_listings l ON l.id = cl.product_id AND l.status = 'PUBLISHED'
         CROSS JOIN LATERAL jsonb_array_elements(l.variants) v
        WHERE cl.cart_id = $1 AND cl.store_ref = $2 AND v ->> 'sku_id' = cl.sku_id::text`,
      [cartId, storeId],
    );
    const t = r.rows[0]?.total;
    return t === null || t === undefined ? 0n : BigInt(t);
  }

  async updateQty(userId: string, lineId: string, qty: number): Promise<void> {
    assertQty(qty);
    await this.asUser(userId, async (tx) => {
      const now = this.env.now().toISOString();
      const r = await tx.query<{ cart_id: string }>("UPDATE cart_lines SET qty = $2, updated_at = $3, version = version + 1 WHERE id = $1 RETURNING cart_id", [lineId, qty, now]);
      const row = r.rows[0];
      if (row === undefined) throw new CartError("not_found", "line not found"); // another user's line is invisible under RLS
      await tx.query("UPDATE carts SET version = version + 1, updated_at = $2 WHERE id = $1", [row.cart_id, now]);
    });
  }

  async removeLine(userId: string, lineId: string): Promise<void> {
    await this.asUser(userId, async (tx) => {
      const r = await tx.query<{ cart_id: string }>("DELETE FROM cart_lines WHERE id = $1 RETURNING cart_id", [lineId]);
      const row = r.rows[0];
      if (row === undefined) throw new CartError("not_found", "line not found");
      await tx.query("UPDATE carts SET version = version + 1, updated_at = $2 WHERE id = $1", [row.cart_id, this.env.now().toISOString()]);
    });
  }

  async clear(userId: string): Promise<void> {
    await this.asUser(userId, async (tx) => {
      const r = await tx.query<{ cart_id: string }>("DELETE FROM cart_lines WHERE cart_id IN (SELECT id FROM carts WHERE user_id = $1 AND market_id = $2 AND status = 'active') RETURNING cart_id", [userId, this.env.marketId]);
      const cartId = r.rows[0]?.cart_id;
      if (cartId !== undefined) await tx.query("UPDATE carts SET version = version + 1, updated_at = $2 WHERE id = $1", [cartId, this.env.now().toISOString()]);
    });
  }

  private async emit(tx: Queryable, type: string, cartId: string, payload: Record<string, string | number | boolean>): Promise<void> {
    await this.env.outbox.append(tx, { id: this.env.newId(), type, aggregateType: "cart", aggregateId: cartId, marketId: this.env.marketId, occurredAt: this.env.now().toISOString(), visibility: "internal", payload });
  }
}
