import { commissionFor, money } from "@outlet/domain";
import {
  ANALYTICS_EVENT_TYPES,
  InventoryLevelChanged,
  OrderLinePurchased,
  ReturnLineReceived,
  SellerOrderPlacedAnalytics,
  deterministicEventId,
  type AnalyticsOutboxDraft,
} from "./events";

/** Maps a user id to the pseudonymous `shopper_key` (HMAC-SHA256, purpose `seller-analytics`). */
export interface ShopperKeyer {
  shopperKey(userId: string): string;
  /** HMAC-SHA256 with purpose `search-term`. Never reversible, never released as text. */
  termHash(normalisedTerm: string): string;
}

/** Reads `kill.analytics.producers` (allowed-when-true). Fails closed: unknown or erroring is false. */
export interface ProducerGate {
  enabled(): Promise<boolean>;
}

export interface AnalyticsProducerDeps {
  readonly gate: ProducerGate;
  readonly keyer: ShopperKeyer;
}

export interface PlacedLine {
  readonly orderLineId: string;
  readonly productId: string;
  readonly skuId: string;
  readonly qty: number;
  readonly unitPriceMinor: bigint;
  readonly discountAllocMinor: bigint;
  readonly sizeLabel: string | null;
}

/**
 * Pure builders for the server-derived analytics events. The caller (an adapter) reads the gate ONCE
 * before it opens its transaction (never a network call inside the money transaction), reads the
 * `analytics` consent inside the transaction, and appends the drafts in that same transaction.
 * Blocked means: no draft is built and nothing is appended; the state change itself is untouched.
 */
export class AnalyticsProducers {
  constructor(private readonly deps: AnalyticsProducerDeps) {}

  /** Call once, before the transaction. */
  async enabled(): Promise<boolean> {
    try {
      return (await this.deps.gate.enabled()) === true;
    } catch {
      return false;
    }
  }

  private key(userId: string, consented: boolean): string | null {
    return consented ? this.deps.keyer.shopperKey(userId) : null;
  }

  /** Extra fields for the orders `seller_order.placed` payload. */
  sellerOrderPlaced(a: {
    readonly userId: string;
    readonly consented: boolean;
    readonly placedAtMs: number;
    readonly lines: readonly Pick<PlacedLine, "productId" | "skuId" | "qty">[];
  }): Record<string, unknown> {
    // A payload that does not validate is skipped: analytics must never fail the money transition.
    const parsed = SellerOrderPlacedAnalytics.safeParse({
      placed_at_ms: a.placedAtMs,
      lines: a.lines.slice(0, 50).map((l) => ({ product_id: l.productId, sku_id: l.skuId, qty: l.qty })),
      shopper_key: this.key(a.userId, a.consented),
    });
    return parsed.success ? parsed.data : {};
  }

  orderLinePurchased(a: {
    readonly userId: string;
    readonly consented: boolean;
    readonly sellerOrderId: string;
    readonly storeId: string;
    readonly commissionRateBps: number;
    readonly governorate: string | null;
    readonly purchasedAtMs: number;
    readonly line: PlacedLine;
  }): AnalyticsOutboxDraft | null {
    const l = a.line;
    // Line merchandise gross after item-level discounts (VAT-inclusive prices, as shown to shoppers).
    const gross = l.unitPriceMinor * BigInt(l.qty) - l.discountAllocMinor;
    const safeGross = gross < 0n ? 0n : gross;
    const commission = commissionFor(money(safeGross), a.commissionRateBps).amount;
    const parsed = OrderLinePurchased.safeParse({
      order_line_id: l.orderLineId,
      seller_order_id: a.sellerOrderId,
      store_id: a.storeId,
      product_id: l.productId,
      sku_id: l.skuId,
      qty: l.qty,
      gross_minor: safeGross.toString(),
      commission_minor: commission.toString(),
      size_label: l.sizeLabel,
      governorate: a.governorate,
      purchased_at_ms: a.purchasedAtMs,
      shopper_key: this.key(a.userId, a.consented),
      currency: "EGP",
    });
    if (!parsed.success) return null;
    const payload = parsed.data;
    return {
      id: deterministicEventId(ANALYTICS_EVENT_TYPES.orderLinePurchased, l.orderLineId),
      type: ANALYTICS_EVENT_TYPES.orderLinePurchased,
      aggregateType: "order_line",
      aggregateId: l.orderLineId,
      occurredAtMs: a.purchasedAtMs,
      payload,
    };
  }

  returnLineReceived(a: {
    readonly userId: string;
    readonly consented: boolean;
    readonly returnId: string;
    readonly orderLineId: string;
    readonly storeId: string;
    readonly productId: string;
    readonly skuId: string;
    readonly qty: number;
    readonly reason: string;
    readonly receivedAtMs: number;
  }): AnalyticsOutboxDraft | null {
    const parsed = ReturnLineReceived.safeParse({
      return_id: a.returnId,
      order_line_id: a.orderLineId,
      store_id: a.storeId,
      product_id: a.productId,
      sku_id: a.skuId,
      qty: a.qty,
      reason: a.reason,
      received_at_ms: a.receivedAtMs,
      shopper_key: this.key(a.userId, a.consented),
    });
    if (!parsed.success) return null;
    const payload = parsed.data;
    return {
      id: deterministicEventId(ANALYTICS_EVENT_TYPES.returnLineReceived, a.returnId),
      type: ANALYTICS_EVENT_TYPES.returnLineReceived,
      aggregateType: "return",
      aggregateId: a.returnId,
      occurredAtMs: a.receivedAtMs,
      payload,
    };
  }

  /** One per SKU per transaction (callers coalesce; the id includes the level version). */
  inventoryLevelChanged(a: {
    readonly skuId: string;
    readonly storeId: string;
    readonly onHandTotal: number;
    readonly committedTotal: number;
    readonly levelVersion: number;
    readonly changedAtMs: number;
  }): AnalyticsOutboxDraft | null {
    const parsed = InventoryLevelChanged.safeParse({
      sku_id: a.skuId,
      store_id: a.storeId,
      on_hand_total: a.onHandTotal,
      committed_total: a.committedTotal,
      level_version: a.levelVersion,
      changed_at_ms: a.changedAtMs,
    });
    if (!parsed.success) return null;
    const payload = parsed.data;
    return {
      id: deterministicEventId(
        ANALYTICS_EVENT_TYPES.inventoryLevelChanged,
        // sync_version does not move on claims, so the totals and the instant are part of the identity.
        `${a.skuId}:${a.levelVersion}:${a.onHandTotal}:${a.committedTotal}:${a.changedAtMs}`,
      ),
      type: ANALYTICS_EVENT_TYPES.inventoryLevelChanged,
      aggregateType: "inventory_sku",
      aggregateId: a.skuId,
      occurredAtMs: a.changedAtMs,
      payload,
    };
  }
}
