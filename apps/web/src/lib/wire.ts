import { z } from "zod";
import { CURRENCIES, money, type Money } from "@outlet/money";

// Response shapes of docs/api/openapi.yaml for the shopper surface. Money arrives as {amount_minor: string, currency}.
const money_ = z
  .object({ amount_minor: z.string().regex(/^-?\d{1,19}$/), currency: z.enum(CURRENCIES) })
  .transform((m): Money => money(BigInt(m.amount_minor), m.currency));
const nullStr = z.string().nullable().optional().transform((v) => v ?? null);
const uuid = z.string().min(1);

export const PAYMENT_METHODS = ["card", "apple_pay", "meeza", "mobile_wallet", "instapay", "fawry", "bnpl", "cod"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
const method = z.enum(PAYMENT_METHODS);

export const priceDisplaySchema = z.object({
  current_price: money_,
  claim_type: z.enum(["verified_discount", "lowest_30d", "launch_price", "plain"]),
  reference_price: money_.optional(),
  display_discount_bp: z.number().int().optional(),
});
const noticeSchema = z.object({ code: z.enum(["price_dropped", "price_rose", "unavailable", "store_suspended", "threshold_changed", "defect_card_changed"]), line_id: nullStr });
export type CartNotice = z.infer<typeof noticeSchema>;

const cartLineSchema = z.object({
  id: uuid, sku_id: uuid, product_id: uuid, store_id: uuid, qty: z.number().int(),
  price_at_add: money_, current_price: priceDisplaySchema,
  defect_card_id: nullStr, defect_card_version: z.number().int().nullable().optional().transform((v) => v ?? null),
  defect_ack_required: z.boolean(), defect_ack_at: nullStr, defect_ack_count: z.number().int().nullable().optional().transform((v) => v ?? null),
  saved_for_later: z.boolean(), available: z.boolean(),
});
export type CartLine = z.infer<typeof cartLineSchema>;
const groupSchema = z.object({
  store_id: uuid, store_slug: z.string(), display_name_ar: z.string(), subtotal: money_, free_delivery_threshold: money_, remaining_for_free_delivery: money_, lines: z.array(cartLineSchema),
});
export type CartGroup = z.infer<typeof groupSchema>;
export const cartSchema = z.object({ id: uuid, currency: z.enum(CURRENCIES), version: z.number().int(), groups: z.array(groupSchema), items_subtotal: money_, notices: z.array(noticeSchema) });
export type Cart = z.infer<typeof cartSchema>;

const parcelSchema = z.object({ store_id: uuid, courier_service_code: z.string(), fee: money_, days_min: z.number().int(), days_max: z.number().int(), free_delivery_applied: z.boolean() });
const storeQuoteSchema = z.object({ store_id: uuid, items_subtotal: money_, shipping: money_, parcels: z.array(parcelSchema) });
const paymentOptionSchema = z.object({ method, available: z.boolean(), reason_key: nullStr, installment_quote: z.record(z.string(), z.unknown()).optional() });
export const quoteSchema = z.object({
  quote_token: z.string(), expires_at: z.string(), currency: z.enum(CURRENCIES), stores: z.array(storeQuoteSchema),
  items_subtotal: money_, discount: money_, shipping: money_, vat_included: money_, store_credit: money_, total: money_, verified_savings: money_,
  fees: z.array(z.object({ code: z.string(), amount: money_ })), payment_options: z.array(paymentOptionSchema), cod_allowed: z.boolean(), cod_requires_confirmation: z.boolean(), notices: z.array(noticeSchema),
});
export type Quote = z.infer<typeof quoteSchema>;

const clientActionSchema = z.object({
  kind: z.enum(["redirect", "iframe", "fawry_reference", "instapay_qr", "wallet_redirect", "cod_confirmation", "none"]),
  url: nullStr, reference: nullStr, expires_at: nullStr,
});
export type ClientAction = z.infer<typeof clientActionSchema>;
export const checkoutResultSchema = z.object({ order_group_id: uuid, status: z.enum(["PENDING_PAYMENT", "CONFIRMED_COD"]), client_action: clientActionSchema, reservation_expires_at: z.string() });
export type CheckoutResult = z.infer<typeof checkoutResultSchema>;

export const ORDER_STATUSES = ["PENDING_PAYMENT", "PAID", "CONFIRMED_COD", "PAYMENT_FAILED", "EXPIRED", "PARTIALLY_FULFILLED", "COMPLETED", "CANCELLED"] as const;

export const SHIPMENT_STATUSES = ["LABEL_PENDING", "LABEL_CREATED", "PICKUP_SCHEDULED", "PICKED_UP", "IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED", "DELIVERY_FAILED", "RTO_IN_TRANSIT", "RETURNED_TO_SELLER", "LOST", "CANCELLED"] as const;
const shipmentEventSchema = z.object({ normalized_status: z.string(), location_text: nullStr, occurred_at: z.string() });
export const shipmentTrackingSchema = z.object({
  shipment_id: uuid, status: z.string(), courier_code: z.string(), awb: nullStr, events: z.array(shipmentEventSchema), delivered_at: nullStr,
});
export type ShipmentTracking = z.infer<typeof shipmentTrackingSchema>;

const orderLineSchema = z.object({
  id: uuid, sku_id: uuid, product_id: uuid, title_ar_snapshot: z.string(), title_en_snapshot: nullStr, qty: z.number().int(), unit_price: money_, status: z.string(),
});
export type OrderLine = z.infer<typeof orderLineSchema>;
/** seller_orders as the shopper sees them. Windows (return_window_ends_at) and the cancellable/returnable flags are the server's; the page never computes them. */
export const shopperSellerOrderSchema = z.object({
  id: uuid, store_display_name_ar: z.string(), status: z.string(), total: money_,
  lines: z.array(orderLineSchema).optional().transform((v) => v ?? []),
  shipment: shipmentTrackingSchema.nullable().optional().transform((v) => v ?? null),
  delivered_at: nullStr, return_window_ends_at: nullStr,
  cancellable: z.boolean().optional().transform((v) => v ?? false),
  returnable: z.boolean().optional().transform((v) => v ?? false),
});
export type ShopperSellerOrder = z.infer<typeof shopperSellerOrderSchema>;
export const orderGroupSchema = z.object({
  id: uuid, status: z.enum(ORDER_STATUSES), currency: z.enum(CURRENCIES), items_subtotal: money_, discount: money_, shipping: money_, vat: money_, store_credit: money_, total: money_,
  payment_method: method, payment_status: z.string(), client_action: clientActionSchema.nullable().optional().transform((v) => v ?? null),
  seller_orders: z.array(shopperSellerOrderSchema),
});
export type OrderGroup = z.infer<typeof orderGroupSchema>;
export const orderSummarySchema = z.object({ id: uuid, status: z.string(), total: money_, store_count: z.number().int(), placed_at: nullStr });
export type OrderSummary = z.infer<typeof orderSummarySchema>;

export const RETURN_REASONS = ["too_small", "too_large", "not_as_described", "defective", "undisclosed_defect", "changed_mind", "late", "wrong_item"] as const;
export type ReturnReason = (typeof RETURN_REASONS)[number];
/** Contract rule (ReturnRequestInput): these reasons need photos. */
export const PHOTO_REASONS: readonly ReturnReason[] = ["defective", "undisclosed_defect", "not_as_described"];
export const SIZE_REASONS: readonly ReturnReason[] = ["too_small", "too_large"];
export const RETURN_STATUSES = ["REQUESTED", "APPROVED", "PICKUP_SCHEDULED", "IN_TRANSIT", "RECEIVED", "INSPECTED", "ACCEPTED", "REJECTED", "DISPUTED", "CLOSED", "CANCELLED"] as const;
export const returnRequestSchema = z.object({
  id: uuid, seller_order_id: uuid, status: z.enum(RETURN_STATUSES), reason_code: z.string(), fault: z.string(), window_basis: z.string(),
  delivered_at_snapshot: z.string(), window_ends_at: z.string(), method: z.enum(["pickup", "dropoff"]), resolution: z.enum(["refund", "exchange"]),
  lines: z.array(z.object({ id: uuid, order_line_id: uuid, qty: z.number().int(), condition_received: nullStr, restock_decision: nullStr })),
  received_at: nullStr, inspection_due_at: nullStr, refund_due_at: nullStr, created_at: z.string(),
  /** Shown only when the API sends it (the published contract has no rejection reason yet). */
  rejection_reason: nullStr,
});
export type ReturnRequest = z.infer<typeof returnRequestSchema>;
export const uploadTicketSchema = z.object({ media_id: uuid, upload_url: z.url(), upload_headers: z.record(z.string(), z.unknown()), expires_at: z.string() });
export type UploadTicket = z.infer<typeof uploadTicketSchema>;

export const geoAreaSchema = z.object({ id: uuid, parent_id: nullStr, level: z.enum(["governorate", "city", "district"]), name_ar: z.string(), name_en: nullStr, active: z.boolean() });
export type GeoArea = z.infer<typeof geoAreaSchema>;
export const addressSchema = z.object({
  id: uuid, recipient_name: z.string(), phone_e164: z.string(), is_default: z.boolean(),
  /** Only when the API says so (landmark + pin rules are server-side); no badge otherwise. */
  cod_eligible: z.boolean().nullable().optional().transform((v) => v ?? null),
  fields: z.object({ governorate_id: uuid, district_id: uuid, street: z.string(), building: z.string(), floor: nullStr, apartment: nullStr, landmark: z.string() }),
});
export type Address = z.infer<typeof addressSchema>;

const page = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item), next_cursor: z.string().nullable() });
export const geoPageSchema = page(geoAreaSchema);
export const addressPageSchema = page(addressSchema);
export const orderSummaryPageSchema = page(orderSummarySchema);
export const returnPageSchema = page(returnRequestSchema);

export const walletSchema = z.object({ total_available: money_ });
export const sessionSchema = z.object({
  id: uuid, platform: z.string(), ua_family: nullStr, created_at: z.string(), last_seen_at: nullStr, current: z.boolean(),
});
export type SessionFamily = z.infer<typeof sessionSchema>;
export const sessionPageSchema = page(sessionSchema);

export const CONSENT_CODES = ["marketing_push", "marketing_whatsapp", "marketing_email", "marketing_sms", "analytics", "personalization", "measurements", "location_precise", "cross_border_ml"] as const;
export const consentSchema = z.object({ purpose_code: z.enum(CONSENT_CODES), purpose_version: z.number().int(), granted: z.boolean(), text_ar: z.string(), text_en: nullStr });
export type ConsentState = z.infer<typeof consentSchema>;
export const consentListSchema = z.object({ items: z.array(consentSchema) });
export const consentPageSchema = page(consentSchema);

export const privacyRequestSchema = z.object({
  id: uuid, kind: z.enum(["export", "delete"]), status: z.string(), blocked_reason: nullStr, due_at: z.string(), cooling_until: nullStr, export_url: nullStr, export_expires_at: nullStr, created_at: z.string(),
});
export type PrivacyRequest = z.infer<typeof privacyRequestSchema>;
export const privacyPageSchema = page(privacyRequestSchema);

export const meSchema = z.object({ id: uuid, phone_masked: z.string(), locale: z.enum(["ar-EG", "en-EG"]) });
export const challengeSchema = z.object({ challenge_id: uuid, resend_after_s: z.number().int(), expires_at: z.string() });
export const sessionInfoSchema = z.object({ user_id: uuid, is_new_user: z.boolean() });

/** Product facts the bag needs (title, size) from the public product route; the cart contract carries ids only. */
export const productBriefSchema = z.object({
  id: uuid, title_ar: z.string(), title_en: nullStr,
  skus: z.array(z.object({ sku_id: uuid, size_label: nullStr })),
});
export type ProductBrief = z.infer<typeof productBriefSchema>;
