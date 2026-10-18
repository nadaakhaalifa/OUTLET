/**
 * Zod schemas for the seller operations of docs/api/openapi.yaml (hand-written, one per response/request body).
 * Every response is parsed here; nothing else in the app touches raw JSON.
 * Money arrives either as OpenAPI `Money {amount}` or the analytics wire `{amount_minor}`; both become bigint piastres.
 */
import { z } from "zod";

const minorString = z.string().regex(/^-?\d{1,18}$/);

export const moneySchema = z
  .union([
    z.object({ amount: minorString, currency: z.literal("EGP") }),
    z.object({ amount_minor: minorString, currency: z.literal("EGP") }),
  ])
  .transform((m) => ({ minor: BigInt("amount" in m ? m.amount : m.amount_minor), currency: "EGP" as const }));
export type MoneyValue = z.infer<typeof moneySchema>;

export const uuid = z.string().uuid();
export const timestamp = z.string().datetime({ offset: true });
export const localizedText = z.object({ ar: z.string(), en: z.string().optional() });
export type LocalizedText = z.infer<typeof localizedText>;

const pageInfo = z.object({ next_cursor: z.string().nullable().optional(), has_more: z.boolean() });
export const page = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item), page: pageInfo });

export const problemSchema = z.object({
  type: z.string().optional(),
  title: z.string().optional(),
  status: z.number().optional(),
  detail: z.string().optional(),
  code: z.string().optional(),
  request_id: z.string().optional(),
  errors: z.array(z.object({ pointer: z.string(), code: z.string(), detail: z.string().optional() })).optional(),
});
export type Problem = z.infer<typeof problemSchema>;

export const sellerOrderStatus = z.enum([
  "PENDING_PAYMENT", "PAID", "CONFIRMED_COD", "ACCEPTED", "PACKED", "SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED",
  "CLOSED", "RETURN_REQUESTED", "RETURN_PICKUP_SCHEDULED", "RETURN_IN_TRANSIT", "RETURN_RECEIVED",
  "RETURN_INSPECTED", "REFUNDED", "RETURN_REJECTED", "CANCELLED", "REJECTED_BY_SELLER", "DELIVERY_FAILED", "RTO",
  "RETURNED_TO_SELLER", "DISPUTED",
]);
export type SellerOrderStatus = z.infer<typeof sellerOrderStatus>;

export const orderLine = z.object({
  id: uuid,
  sku_id: uuid,
  title: localizedText,
  size_label: z.string().optional(),
  qty: z.number().int(),
  unit_price: moneySchema,
});

export const sellerOrderView = z.object({
  id: uuid,
  status: sellerOrderStatus,
  lines: z.array(orderLine),
  subtotal: moneySchema,
  shipping: moneySchema,
  commission: moneySchema.optional(),
  net_to_seller: moneySchema.optional(),
  buyer: z
    .object({ first_name: z.string().optional(), phone_relay: z.string().optional(), governorate_code: z.string(), address_visible: z.boolean().optional() })
    .optional(),
  accept_by: timestamp,
  dispatch_by: timestamp.optional(),
  payment_type: z.enum(["prepaid", "cod"]),
  created_at: timestamp,
});
export type SellerOrderView = z.infer<typeof sellerOrderView>;
export const sellerOrderPage = page(sellerOrderView);

export const rejectReason = z.enum(["out_of_stock", "pricing_error", "cannot_fulfil", "other"]);
export type RejectReason = z.infer<typeof rejectReason>;

export const shipment = z.object({
  id: uuid,
  seller_order_ids: z.array(uuid),
  courier: z.string(),
  awb: z.string().nullable().optional(),
  status: z.string(),
});
export type Shipment = z.infer<typeof shipment>;

export const condition = z.enum(["new_with_tags", "new_without_tags", "sample", "minor_defect"]);
export type Condition = z.infer<typeof condition>;
export const department = z.enum(["women", "men", "kids", "unisex"]);
export type Department = z.infer<typeof department>;

export const sellerSku = z.object({
  id: uuid,
  seller_sku: z.string().optional(),
  barcode_gtin: z.string().optional(),
  size_label: z.string(),
  color: z.string().optional(),
  price: moneySchema,
  on_hand: z.number().int(),
  available: z.number().int().optional(),
});
export const sellerProduct = z.object({
  id: uuid,
  status: z.enum(["draft", "active", "paused", "auto_paused_price_parity", "delisted"]),
  title: localizedText,
  description: localizedText.optional(),
  category_id: uuid,
  brand_id: uuid.optional(),
  condition,
  department: department.optional(),
  material: z.string().optional(),
  image_upload_ids: z.array(uuid).optional(),
  defect_photo_upload_ids: z.array(uuid).optional(),
  size_chart_id: uuid.optional(),
  skus: z.array(sellerSku),
  price_claim_state: z.enum(["none", "verified_discount", "lowest_30d", "launch_price"]).optional(),
  updated_at: timestamp,
});
export type SellerProduct = z.infer<typeof sellerProduct>;
export const sellerProductPage = page(sellerProduct);

/** Request body (not parsed from responses). Prices are sent as {amount, currency} strings. */
export interface SellerProductInputWire {
  readonly title: { readonly ar: string; readonly en?: string };
  readonly description?: { readonly ar: string; readonly en?: string };
  readonly category_id: string;
  readonly condition: Condition;
  readonly department?: Department;
  readonly defect_photo_upload_ids?: readonly string[];
  readonly image_upload_ids?: readonly string[];
  readonly size_chart_id?: string;
  readonly skus: readonly {
    readonly size_label: string;
    readonly price: { readonly amount: string; readonly currency: "EGP" };
    readonly initial_stock?: number;
  }[];
}

export const sizeChart = z.object({
  id: uuid,
  product_type: z.string(),
  unit: z.enum(["cm", "in"]),
  rows: z.array(z.object({ size_label: z.string(), measurements: z.record(z.string(), z.number()) })),
  validated: z.boolean(),
  validation_errors: z.array(z.object({ size_label: z.string(), code: z.string() })).optional(),
});
export type SizeChart = z.infer<typeof sizeChart>;
export const sizeChartPage = page(sizeChart);

export const catalogImport = z.object({
  id: uuid,
  status: z.enum(["queued", "validating", "dry_run_complete", "applying", "completed", "failed"]),
  dry_run: z.boolean(),
  rows_total: z.number().int(),
  rows_ok: z.number().int(),
  rows_failed: z.number().int(),
  error_report_url: z.string().nullable().optional(),
  created_at: timestamp,
});
export type CatalogImport = z.infer<typeof catalogImport>;

export const inspectionDueReturn = z.object({
  id: uuid,
  order_line_id: uuid,
  seller_order_id: uuid,
  status: z.string(),
  reason: z.enum(["too_small", "too_large", "not_as_described", "defective", "changed_mind", "late", "wrong_item"]),
  resolution: z.enum(["exchange", "refund"]),
  inspection_due_at: timestamp.nullable().optional(),
  created_at: timestamp,
});
export type SellerReturn = z.infer<typeof inspectionDueReturn>;
export const returnPage = page(inspectionDueReturn);
export const rejectionReason = z.enum(["used", "missing_tags", "damaged_by_customer", "wrong_item_returned", "other"]);
export type RejectionReason = z.infer<typeof rejectionReason>;

export const sellerBalance = z.object({
  available: moneySchema,
  pending_release: moneySchema,
  held: moneySchema,
  in_transit: moneySchema.optional(),
  negative_carry: moneySchema.optional(),
  as_of: timestamp,
});
export type SellerBalance = z.infer<typeof sellerBalance>;
export const payout = z.object({
  id: uuid,
  status: z.enum(["SCHEDULED", "PENDING_APPROVAL", "APPROVED", "PROCESSING", "PAID", "FAILED", "HELD"]),
  amount: moneySchema,
  period_start: timestamp,
  period_end: timestamp,
  paid_at: timestamp.nullable().optional(),
});
export type Payout = z.infer<typeof payout>;
export const payoutPage = page(payout);
export const taxInvoice = z.object({
  id: uuid,
  kind: z.enum(["commission_einvoice", "consumer_ereceipt"]),
  status: z.enum(["queued", "submitted", "accepted", "rejected", "failed"]),
  amount: moneySchema,
  vat: moneySchema,
  eta_uuid: z.string().nullable().optional(),
  created_at: timestamp,
});
export type TaxInvoice = z.infer<typeof taxInvoice>;
export const taxInvoicePage = page(taxInvoice);

export const promotion = z.object({
  id: uuid,
  type: z.string(),
  title: localizedText,
  code: z.string().optional(),
  auto_apply: z.boolean().optional(),
  funding: z.object({ platform_pct: z.number().int(), seller_pct: z.number().int() }),
  starts_at: timestamp,
  ends_at: timestamp,
  status: z.enum(["draft", "scheduled", "active", "paused", "ended"]),
  version: z.number().int(),
});
export type Promotion = z.infer<typeof promotion>;
export const promotionPage = page(promotion);

export const teamRole = z.enum(["owner", "manager", "fulfilment", "catalog", "finance"]);
export type TeamRole = z.infer<typeof teamRole>;

export const priceTrust = z.object({
  score: z.number(),
  violations_in_window: z.number().int(),
  window_days: z.number().int(),
  ladder_state: z.enum(["good_standing", "badge_removed", "surcharge_active", "suspended"]),
  active_actions: z.array(
    z.object({ id: uuid, action: z.string(), reason_code: z.string().optional(), applied_at: timestamp, cure: localizedText.optional() }),
  ),
});
export type PriceTrust = z.infer<typeof priceTrust>;
export const priceClaim = z.object({
  id: uuid,
  sku_id: uuid,
  tier: z.string(),
  decision: z.enum(["plain", "launch_price", "lowest_30d", "verified_discount", "withheld"]),
  reason_codes: z.array(z.string()),
  unlock_hints: z.array(localizedText).optional(),
  evaluated_at: timestamp,
});
export type PriceClaim = z.infer<typeof priceClaim>;
export const priceClaimPage = page(priceClaim);

export const sellerStore = z.object({
  id: uuid,
  slug: z.string(),
  name: localizedText,
  status: z.enum(["active", "suspended", "vacation"]),
  legal_identity: z.object({
    legal_name: z.string(),
    commercial_register_no: z.string().optional(),
    tax_id: z.string().optional(),
    governorate: z.string().optional(),
  }),
  free_delivery_threshold: moneySchema.optional(),
  dispatch_sla_hours: z.number().int().optional(),
  accept_sla_hours: z.number().int().optional(),
  health_score: z.number().optional(),
  price_trust_score: z.number().optional(),
  kyc_status: z.enum(["DRAFT", "SUBMITTED", "AUTO_CHECKS", "NEEDS_INFO", "APPROVED", "REJECTED", "SUSPENDED"]),
});
export type SellerStore = z.infer<typeof sellerStore>;

/* Analytics read models (docs/specs/seller-analytics.md; wire from apps/api seller-analytics wire.ts). */
export const freshness = z.object({
  as_of: timestamp.nullable(),
  lag_ms: z.number().nullable(),
  slo_ms: z.number(),
  within_slo: z.boolean(),
});
export type Freshness = z.infer<typeof freshness>;
export const meta = z.object({ store_id: uuid, from: timestamp, to: timestamp, freshness, k_anonymity_min: z.number().int() });
export type AnalyticsMeta = z.infer<typeof meta>;

export const salesReport = z.object({
  gmv: moneySchema,
  commission: moneySchema,
  net: moneySchema,
  units: z.number().int(),
  orders: z.number().int(),
  aov: moneySchema.nullable(),
  repeat_rate_bps: z.number().nullable(),
  repeat_rate_suppressed: z.boolean(),
  meta,
});
export type SalesReport = z.infer<typeof salesReport>;

const funnelBlock = z.object({
  steps: z.array(z.object({ stage: z.string(), count: z.number().int(), from_previous_bps: z.number().nullable(), exceeds_previous: z.boolean() })),
  overall_bps: z.number().nullable(),
});
export const funnelReport = z.object({ total: funnelBlock, meta });
export type FunnelReport = z.infer<typeof funnelReport>;

export const trafficReport = z.object({
  store_views: z.number().int(),
  product_views: z.number().int(),
  unique_visitors: z.number().int().nullable(),
  unique_visitors_suppressed: z.boolean().optional(),
  by_source: z.object({
    items: z.array(z.object({ key: z.string(), events: z.number().int(), includes_suppressed: z.boolean().optional() })),
    suppressed_cells: z.number().int(),
  }),
  meta,
});
export type TrafficReport = z.infer<typeof trafficReport>;

export const geographyReport = z.object({
  governorates: z.array(z.object({ governorate: z.string(), orders: z.number().int(), gmv: moneySchema, includes_suppressed: z.boolean().optional() })),
  suppressed_governorates: z.number().int(),
  meta,
});
export type GeographyReport = z.infer<typeof geographyReport>;

export const agingReport = z.object({
  alerts: z.array(
    z.object({
      sku_id: uuid,
      product_id: uuid,
      size: z.string(),
      severity: z.string(),
      age_days: z.number().int(),
      on_hand: z.number().int(),
      sell_through_bps: z.number().nullable(),
      price: moneySchema,
      markdown_recommendation: z.object({
        action: z.string(),
        suggested_price: moneySchema.nullable(),
        shows_percent_off: z.boolean(),
        notice: z.object({ en: z.string(), ar: z.string() }),
      }),
    }),
  ),
  meta,
});
export type AgingReport = z.infer<typeof agingReport>;

export const sessionTokens = z.object({
  access_token: z.string(),
  access_expires_at: timestamp,
  refresh_token: z.string(),
  refresh_expires_at: timestamp,
  second_factor_required: z.boolean().optional(),
});
export type SessionTokens = z.infer<typeof sessionTokens>;
export const passkeyOptions = z.object({ challenge_id: uuid, challenge: z.string(), rp_id: z.string(), expires_at: timestamp });
export type PasskeyOptions = z.infer<typeof passkeyOptions>;
