import { z } from "zod";
import { MoneyDto } from "../../platform/money-wire.js";
import { CursorQuery } from "../../platform/pagination.js";

const Iso = z.iso.datetime();
const Status = z.string().regex(/^[A-Z_]{3,40}$/);

export const SellerOrderIdParams = z.strictObject({ seller_order_id: z.uuid() });
export type SellerOrderIdParams = z.infer<typeof SellerOrderIdParams>;

/** `status` is one machine state; `from`/`to` bound `created_at` (inclusive, ISO instants). */
export const SellerOrdersQuery = CursorQuery.extend({ status: Status.optional(), from: Iso.optional(), to: Iso.optional() });
export type SellerOrdersQuery = z.infer<typeof SellerOrdersQuery>;

export const REJECT_REASONS = ["out_of_stock", "damaged", "pricing_error", "other"] as const;
export const RejectInput = z.strictObject({ reason_code: z.enum(REJECT_REASONS), note: z.string().trim().max(500).optional() });
export type RejectInput = z.infer<typeof RejectInput>;

export const EmptyBody = z.strictObject({});
export type EmptyBody = z.infer<typeof EmptyBody>;

export const ShipmentCreateInput = z.strictObject({
  seller_order_ids: z.array(z.uuid()).min(1).max(1),
  courier_service_id: z.uuid().optional(),
  declared_weight_g: z.number().int().min(1).max(30_000),
  length_mm: z.number().int().min(0).max(2000).optional(),
  width_mm: z.number().int().min(0).max(2000).optional(),
  height_mm: z.number().int().min(0).max(2000).optional(),
});
export type ShipmentCreateInput = z.infer<typeof ShipmentCreateInput>;

export const ORDER_ACTIONS = ["accept", "reject", "pack", "ship"] as const;

const Summary = z.strictObject({
  id: z.uuid(),
  status: Status,
  total: MoneyDto,
  accept_by: Iso.nullable(),
  dispatch_by: Iso.nullable(),
  created_at: Iso,
  available_actions: z.array(z.enum(ORDER_ACTIONS)).max(4),
});
export const SellerOrderSummaryPage = z.strictObject({ items: z.array(Summary).max(50), next_cursor: z.string().max(512).nullable(), server_time: Iso });
export type SellerOrderSummaryPage = z.infer<typeof SellerOrderSummaryPage>;

const Line = z.strictObject({
  id: z.uuid(),
  sku_id: z.uuid(),
  product_id: z.uuid(),
  title_ar_snapshot: z.string().min(1).max(500),
  title_en_snapshot: z.string().max(500).nullable(),
  condition_grade_snapshot: z.string().max(500),
  qty: z.number().int(),
  unit_price: MoneyDto,
  platform_discount: MoneyDto,
  seller_discount: MoneyDto,
  vat_rate_bp: z.number().int().min(0).max(10_000),
  vat: MoneyDto,
  claim_type_snapshot: z.string().max(500),
  status: z.string().max(500),
});

/** Delivery data for the seller: only while the PII window is open; the phone is always masked. */
const Delivery = z.strictObject({
  recipient_name: z.string().max(500),
  phone_masked: z.string().max(50),
  address: z.strictObject({
    governorate_code: z.string().max(16),
    city_code: z.string().max(32).nullable(),
    district_code: z.string().max(32).nullable(),
    street: z.string().max(200),
    building: z.string().max(40),
    floor: z.string().max(20).nullable(),
    apartment: z.string().max(20).nullable(),
    landmark: z.string().max(200).nullable(),
  }),
  access_until: Iso.nullable(),
});

export const SellerOrder = z.strictObject({
  id: z.uuid(),
  status: Status,
  version: z.number().int(),
  items_subtotal: MoneyDto,
  seller_discount: MoneyDto,
  platform_discount: MoneyDto,
  shipping: MoneyDto,
  vat: MoneyDto,
  total: MoneyDto,
  commission_bp_snapshot: z.number().int().min(0).max(10_000),
  commission: MoneyDto,
  /** null when the payment method cannot be read (never guessed). */
  payment_kind: z.enum(["prepaid", "cod"]).nullable(),
  accept_by: Iso.nullable(),
  dispatch_by: Iso.nullable(),
  delivered_at: Iso.nullable(),
  return_window_ends_at: Iso.nullable(),
  lines: z.array(Line).max(50),
  delivery: Delivery.nullable(),
  available_actions: z.array(z.enum(ORDER_ACTIONS)).max(4),
  created_at: Iso,
  server_time: Iso,
});
export type SellerOrder = z.infer<typeof SellerOrder>;

export const Shipment = z.strictObject({
  id: z.uuid(),
  seller_order_id: z.uuid(),
  status: z.literal("CREATED"),
  courier_code: z.string().max(100),
  awb: z.string().max(100),
  /** A downloadable label link, only when the courier adapter provides one. */
  label_url: z.string().max(2048).nullable(),
  created_at: Iso,
});
export type Shipment = z.infer<typeof Shipment>;
