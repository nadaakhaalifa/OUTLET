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

export interface ThresholdOptions {
  /** Required to set a zero threshold (free delivery for every order of the store). */
  readonly allowFreeForAll?: boolean;
}
/** Upper bound of a free-delivery threshold: EGP 10,000.00 in minor units. */
export const MAX_THRESHOLD_MINOR = 1_000_000n;

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

  /** Per-store threshold write by the store owner. Deny by default through @outlet/policy store.write (a foreign store is not found). */
  async setThreshold(actor: Principal, storeId: string, thresholdMinor: bigint, opts: ThresholdOptions = {}): Promise<void> {
    const d = authorize(actor, "store.write", { type: "cart_threshold", storeId, marketId: this.env.marketId });
    if (d.effect === "deny") throw new CartError(d.reason, d.reason === "not_found" ? "not found" : "forbidden");
    await this.writeThreshold(actor, storeId, thresholdMinor, opts);
  }

  /** Admin (ops/finance) threshold write: policy store.threshold.write, plus an audit_log entry through the AuditPort. Fails closed without an audit port. */
  async setThresholdAsAdmin(actor: Principal, storeId: string, thresholdMinor: bigint, opts: ThresholdOptions = {}): Promise<void> {
    const d = authorize(actor, "store.threshold.write", { type: "cart_threshold", storeId, marketId: this.env.marketId });
    if (d.effect === "deny") throw new CartError(d.reason, d.reason === "not_found" ? "not found" : "forbidden");
    if (this.env.audit === undefined) throw new CartError("forbidden", "audit port not configured");
    const before = await this.thresholdFor(storeId);
    await this.writeThreshold(actor, storeId, thresholdMinor, opts);
    await this.env.audit.append({
      marketId: this.env.marketId, actorType: "staff", actorId: actor.userId ?? null, action: "store.threshold.write", targetType: "store", targetId: storeId,
      diff: { before: { thresholdMinor: before.toString() }, after: { thresholdMinor: thresholdMinor.toString(), allowFreeForAll: opts.allowFreeForAll === true } },
      ipHash: null, deviceId: null, requestId: null,
    });
  }

  /** Writes the store-RLS'd settings row and the public projection in ONE transaction, under the target store's context. */
  private async writeThreshold(actor: Principal, storeId: string, thresholdMinor: bigint, opts: ThresholdOptions): Promise<void> {
    if (thresholdMinor < 0n || thresholdMinor > MAX_THRESHOLD_MINOR) throw new CartError("invalid_qty", "threshold must be within 0..1,000,000 minor units");
    if (thresholdMinor === 0n && opts.allowFreeForAll !== true) throw new CartError("invalid_qty", "a zero threshold (free for everyone) needs allowFreeForAll: true");
    const now = this.env.now().toISOString();
    await withDbContext(this.env.client, { kind: "store", marketId: this.env.marketId, storeId, ...(actor.userId === undefined ? {} : { userId: actor.userId }) }, async (tx) => {
      await tx.query(
        `INSERT INTO store_free_delivery_settings (store_id, market_id, threshold_minor, allow_free_for_all, updated_by, updated_at) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (store_id) DO UPDATE SET threshold_minor = EXCLUDED.threshold_minor, allow_free_for_all = EXCLUDED.allow_free_for_all, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
        [storeId, this.env.marketId, thresholdMinor.toString(), opts.allowFreeForAll === true, actor.userId ?? null, now],
      );
      await tx.query(
        `INSERT INTO cart_store_thresholds (store_ref, market_id, threshold_minor, updated_by, updated_at) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (store_ref) DO UPDATE SET threshold_minor = EXCLUDED.threshold_minor, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
        [storeId, this.env.marketId, thresholdMinor.toString(), actor.userId ?? null, now],
      );
    });
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

      // One statement: every line of the cart with its live published price (null when not published). before/after are derived from these rows.
      const rows = (await tx.query<{ sku_id: string; qty: number; store_ref: string; price_minor: string | null }>(
        `SELECT cl.sku_id, cl.qty, cl.store_ref, (SELECT (v ->> 'price_minor') FROM jsonb_array_elements(l.variants) v WHERE v ->> 'sku_id' = cl.sku_id::text LIMIT 1) AS price_minor
           FROM cart_lines cl LEFT JOIN catalog_public_listings l ON l.id = cl.product_id AND l.status = 'PUBLISHED' WHERE cl.cart_id = $1`,
        [cart.id],
      )).rows;
      const existing = rows.map((r) => ({ skuId: r.sku_id, qty: r.qty }));
      const merged = mergeQty({ lines: existing, skuId: input.skuId, qty: input.qty });
      const isMerge = existing.some((l) => l.skuId === input.skuId);
      const before = rows.filter((r) => r.store_ref === sku.store_ref && r.price_minor !== null).reduce((a, r) => a + BigInt(r.price_minor ?? "0") * BigInt(r.qty), 0n);
      const prevQty = rows.find((r) => r.sku_id === input.skuId)?.qty ?? 0;
      const unitCost = BigInt(sku.price_minor);
      // this sku's old contribution used the live price too (it is published, checked above), so the delta is exact
      const after = before + unitCost * BigInt(merged - prevQty);

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

      const threshold = await tx.query<{ threshold_minor: string | bigint }>("SELECT threshold_minor FROM cart_store_thresholds WHERE store_ref = $1", [sku.store_ref]);
      const limit = threshold.rows[0] === undefined ? this.env.defaultThresholdMinor : BigInt(threshold.rows[0].threshold_minor);
      if (before < limit && after >= limit) await this.emit(tx, "cart.free_delivery_unlocked", cart.id, { store_id: sku.store_ref, threshold_minor: limit.toString() });

      const result: AddLineResult = { lineId: line.id, qty: merged, merged: isMerge };
      await idem.complete({ key: idempotencyKey, route, actorId: userId }, { status: 201, body: { ...result } });
      return result;
    });
  }

  async updateQty(userId: string, lineId: string, qty: number): Promise<void> {
    assertQty(qty);
    await this.asUser(userId, async (tx) => {
      const now = this.env.now().toISOString();
      const r = await tx.query<{ cart_id: string }>("UPDATE cart_lines SET qty = $2, updated_at = $3, version = version + 1 WHERE id = $1 AND user_id = $4 RETURNING cart_id", [lineId, qty, now, userId]);
      const row = r.rows[0];
      if (row === undefined) throw new CartError("not_found", "line not found"); // another user's line is invisible under RLS
      await tx.query("UPDATE carts SET version = version + 1, updated_at = $2 WHERE id = $1", [row.cart_id, now]);
    });
  }

  async removeLine(userId: string, lineId: string): Promise<void> {
    await this.asUser(userId, async (tx) => {
      const r = await tx.query<{ cart_id: string }>("DELETE FROM cart_lines WHERE id = $1 AND user_id = $2 RETURNING cart_id", [lineId, userId]);
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
