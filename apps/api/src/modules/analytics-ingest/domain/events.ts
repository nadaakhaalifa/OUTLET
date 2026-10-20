import { z } from "zod";
import { sha256Hex } from "./sha256";

/**
 * Server-derived analytics payloads (dashboard foundations spec section 5). P0-P1 only, except
 * `shopper_key` (P2, pseudonymous, present only with the `analytics` consent). Amounts are integer
 * piastres carried as decimal strings. These payloads never carry a user id, device id or IP.
 */
/** UUID shape (any version): the existence and ownership checks happen at consume time, not by version bits. */
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const minor = z.string().regex(/^\d{1,18}$/);
const shopperKey = z.string().regex(/^[0-9a-f]{64}$/).nullable();
const ms = z.number().int().positive();

/** Fields appended to the existing orders `seller_order.placed` payload (same event, see ADR note in the report). */
export const SellerOrderPlacedAnalytics = z.strictObject({
  placed_at_ms: ms,
  lines: z.array(z.strictObject({ product_id: uuid, sku_id: uuid, qty: z.number().int().min(1).max(1000) })).min(1).max(50),
  shopper_key: shopperKey,
});
export type SellerOrderPlacedAnalytics = z.infer<typeof SellerOrderPlacedAnalytics>;

export const OrderLinePurchased = z.strictObject({
  order_line_id: uuid,
  seller_order_id: uuid,
  store_id: uuid,
  product_id: uuid,
  sku_id: uuid,
  qty: z.number().int().min(1).max(1000),
  gross_minor: minor,
  commission_minor: minor,
  size_label: z.string().min(1).max(16).nullable(),
  governorate: z.string().min(2).max(40).nullable(),
  purchased_at_ms: ms,
  shopper_key: shopperKey,
  currency: z.literal("EGP"),
});
export type OrderLinePurchased = z.infer<typeof OrderLinePurchased>;

export const RETURN_REASONS = ["too_small", "too_large", "not_as_described", "defective", "changed_mind", "late", "wrong_item"] as const;
export const ReturnLineReceived = z.strictObject({
  return_id: uuid,
  order_line_id: uuid,
  store_id: uuid,
  product_id: uuid,
  sku_id: uuid,
  qty: z.number().int().min(1).max(1000),
  reason: z.enum(RETURN_REASONS),
  received_at_ms: ms,
  shopper_key: shopperKey,
});
export type ReturnLineReceived = z.infer<typeof ReturnLineReceived>;

export const InventoryLevelChanged = z.strictObject({
  sku_id: uuid,
  store_id: uuid,
  on_hand_total: z.number().int().min(0),
  committed_total: z.number().int().min(0),
  level_version: z.number().int().min(0),
  changed_at_ms: ms,
});
export type InventoryLevelChanged = z.infer<typeof InventoryLevelChanged>;

export const ANALYTICS_EVENT_TYPES = {
  sellerOrderPlaced: "seller_order.placed",
  orderLinePurchased: "order_line.purchased",
  returnLineReceived: "return_line.received",
  inventoryLevelChanged: "inventory.level_changed",
  clientBatch: "analytics.client_batch",
} as const;

/** A draft of one outbox row. `id` is deterministic so a repeated transition can never append twice. */
export interface AnalyticsOutboxDraft {
  readonly id: string;
  readonly type: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly occurredAtMs: number;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** Stable UUID-shaped id from a natural key: replaying the same state change yields the same id. */
export function deterministicEventId(type: string, naturalKey: string): string {
  const h = sha256Hex(`analytics-event:v1\0${type}\0${naturalKey}`);
  const variant = ((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, "0");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(18, 20)}-${h.slice(20, 32)}`;
}
