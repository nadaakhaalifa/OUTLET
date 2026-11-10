import { add, money } from "@outlet/money";
import type { Currency, Money } from "@outlet/money";
import { CartError } from "./errors.js";

export const MAX_LINES = 50;
export const MAX_QTY_PER_SKU = 10;
/** EGP 2,000 in piastres: the default free-delivery threshold (master prompt section 6). */
export const DEFAULT_THRESHOLD_MINOR = 200_000n;

export type LineState = "ok" | "price_dropped" | "price_rose" | "unavailable" | "store_locked";
export const LINE_STATES: readonly LineState[] = ["ok", "price_dropped", "price_rose", "unavailable", "store_locked"];

export interface CartLineRow {
  readonly id: string;
  readonly skuId: string;
  readonly productId: string;
  readonly storeId: string;
  readonly qty: number;
  readonly priceAtAddMinor: bigint;
  readonly currency: Currency;
  readonly source: string;
  readonly addedAt: string;
  /** State recorded by the last refresh (event de-duplication only; never shown). */
  readonly lastState: LineState;
}

/** Live read of one sku. `available` already folds in the listing status and the stock level. */
export interface SkuSnapshot {
  readonly skuId: string;
  readonly priceMinor: bigint;
  readonly currency: Currency;
  readonly available: boolean;
}

/** A store missing from the snapshot is locked (suspended, closed or unpublished). */
export interface StoreSnapshot {
  readonly storeId: string;
  readonly slug: string;
  readonly nameAr: string;
  readonly thresholdMinor?: bigint;
}

export interface CatalogSnapshot {
  readonly skus: ReadonlyMap<string, SkuSnapshot>;
  readonly stores: ReadonlyMap<string, StoreSnapshot>;
}

export interface LineView {
  readonly line: CartLineRow;
  readonly state: LineState;
  /** Live price; the stored price_at_add when the sku could not be read. */
  readonly current: Money;
  readonly lineTotal: Money;
}

export interface FreeDelivery {
  readonly thresholdMinor: bigint;
  readonly remainingMinor: bigint;
  readonly unlocked: boolean;
}

export interface StoreGroup {
  readonly storeId: string;
  readonly slug: string | null;
  readonly nameAr: string | null;
  readonly locked: boolean;
  readonly lines: readonly LineView[];
  /** Sum of live price x qty of the purchasable lines (ok, price_dropped, price_rose). Not reduced by vouchers or credit. */
  readonly subtotal: Money;
  readonly freeDelivery: FreeDelivery;
}

export const isPurchasable = (s: LineState): boolean => s === "ok" || s === "price_dropped" || s === "price_rose";

export const lineState = (line: CartLineRow, sku: SkuSnapshot | undefined, storeKnown: boolean): LineState => {
  if (!storeKnown) return "store_locked";
  if (sku === undefined || !sku.available || sku.currency !== line.currency) return "unavailable";
  if (sku.priceMinor < line.priceAtAddMinor) return "price_dropped";
  if (sku.priceMinor > line.priceAtAddMinor) return "price_rose";
  return "ok";
};

export const freeDelivery = (subtotalMinor: bigint, thresholdMinor: bigint, locked: boolean): FreeDelivery => {
  const unlocked = !locked && subtotalMinor >= thresholdMinor;
  const remaining = thresholdMinor - subtotalMinor;
  return { thresholdMinor, remainingMinor: unlocked || remaining < 0n ? 0n : remaining, unlocked };
};

/**
 * Groups lines by store (first-added store first, lines in added order) and prices them at the LIVE sku price.
 * The threshold applies to the merchandise subtotal after item-level discounts (the live price is already the discounted price)
 * and before vouchers and credit.
 */
export function groupByStore(lines: readonly CartLineRow[], snap: CatalogSnapshot, currency: Currency, defaultThresholdMinor: bigint = DEFAULT_THRESHOLD_MINOR): StoreGroup[] {
  const order: string[] = [];
  const byStore = new Map<string, CartLineRow[]>();
  for (const l of lines) {
    const bucket = byStore.get(l.storeId);
    if (bucket === undefined) {
      order.push(l.storeId);
      byStore.set(l.storeId, [l]);
    } else bucket.push(l);
  }
  return order.map((storeId): StoreGroup => {
    const store = snap.stores.get(storeId);
    const locked = store === undefined;
    const views = (byStore.get(storeId) ?? []).map((line): LineView => {
      const sku = snap.skus.get(line.skuId);
      const state = lineState(line, sku, !locked);
      const unit = state === "unavailable" || state === "store_locked" || sku === undefined ? line.priceAtAddMinor : sku.priceMinor;
      return { line, state, current: money(unit, line.currency), lineTotal: money(unit * BigInt(line.qty), line.currency) };
    });
    const subtotal = views.filter((v) => isPurchasable(v.state)).reduce((acc, v) => add(acc, v.lineTotal), money(0n, currency));
    const threshold = store?.thresholdMinor ?? defaultThresholdMinor;
    return { storeId, slug: store?.slug ?? null, nameAr: store?.nameAr ?? null, locked, lines: views, subtotal, freeDelivery: freeDelivery(subtotal.amountMinor, threshold, locked) };
  });
}

/** Total of all groups (locked and unavailable lines excluded). */
export const itemsSubtotal = (groups: readonly StoreGroup[], currency: Currency): Money => groups.reduce((acc, g) => add(acc, g.subtotal), money(0n, currency));

export type NoticeCode = "price_dropped" | "price_rose" | "unavailable" | "store_suspended";
export interface Notice {
  readonly code: NoticeCode;
  readonly lineId: string | null;
}

/** Honest notices, both price directions; a locked store gets one notice per line. */
export const noticesOf = (groups: readonly StoreGroup[]): Notice[] =>
  groups.flatMap((g) =>
    g.lines.flatMap((v): Notice[] => {
      switch (v.state) {
        case "ok": return [];
        case "store_locked": return [{ code: "store_suspended", lineId: v.line.id }];
        default: return [{ code: v.state, lineId: v.line.id }];
      }
    }),
  );

export interface LimitInput {
  readonly lines: readonly { readonly skuId: string; readonly qty: number }[];
  readonly skuId: string;
  readonly qty: number;
}

/** Quantity of the line after merging, or a typed error when a limit would be crossed. */
export const mergeQty = (i: LimitInput): number => {
  if (!Number.isInteger(i.qty) || i.qty < 1 || i.qty > MAX_QTY_PER_SKU) throw new CartError("invalid_qty", `qty must be an integer from 1 to ${String(MAX_QTY_PER_SKU)}`);
  const existing = i.lines.find((l) => l.skuId === i.skuId);
  if (existing === undefined && i.lines.length >= MAX_LINES) throw new CartError("line_limit", `a bag holds at most ${String(MAX_LINES)} lines`);
  const merged = (existing?.qty ?? 0) + i.qty;
  if (merged > MAX_QTY_PER_SKU) throw new CartError("qty_limit", `at most ${String(MAX_QTY_PER_SKU)} units of one item`);
  return merged;
};

export const assertQty = (qty: number): void => {
  if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY_PER_SKU) throw new CartError("invalid_qty", `qty must be an integer from 1 to ${String(MAX_QTY_PER_SKU)}`);
};

/** Input for GET /cart/free-delivery-suggestions: what the suggestion query needs, no more. */
export interface FreeDeliverySuggestionsInput {
  readonly storeId: string;
  readonly remainingMinor: bigint;
  readonly currency: Currency;
  readonly excludeSkuIds: readonly string[];
}

export const freeDeliverySuggestionsInput = (g: StoreGroup): FreeDeliverySuggestionsInput | null =>
  g.locked || g.freeDelivery.unlocked
    ? null
    : { storeId: g.storeId, remainingMinor: g.freeDelivery.remainingMinor, currency: g.subtotal.currency, excludeSkuIds: g.lines.map((v) => v.line.skuId) };
