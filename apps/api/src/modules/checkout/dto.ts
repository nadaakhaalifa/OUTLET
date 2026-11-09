import { z } from "zod";
import { MoneyDto } from "../../platform/money-wire.js";
import { pageOf } from "../../platform/pagination.js";

const Iso = z.iso.datetime();
const CONTRACT_METHODS = ["card", "apple_pay", "meeza", "mobile_wallet", "instapay", "fawry", "bnpl", "cod"] as const;
const METHOD = z.enum(CONTRACT_METHODS);

const QuoteFields = {
  address_id: z.uuid(),
  payment_method: METHOD,
  bnpl_provider: z.string().max(500).optional(),
  /** Resolved server-side; codes that do not apply come back in `invalid_voucher_codes`, never silently dropped. */
  voucher_codes: z.array(z.string().trim().min(1).max(32)).max(5).optional(),
  store_credit: MoneyDto.optional(),
};

/** `cart_line_ids` (partial checkout) is not supported: the whole bag is quoted. Sending it is a 422, not a silent widening. */
export const QuoteBody = z.strictObject({ ...QuoteFields, cart_line_ids: z.array(z.uuid()).max(50).optional() });

const Parcel = z.strictObject({ store_id: z.uuid(), quote_ref: z.string().max(500), fee: MoneyDto, days_min: z.number().int(), days_max: z.number().int() });
export const QuoteResponse = z.strictObject({
  quote_token: z.string().max(2000),
  expires_at: Iso,
  currency: z.string().regex(/^[A-Z]{3}$/),
  stores: z.array(z.strictObject({ store_id: z.uuid(), items_subtotal: MoneyDto, shipping: MoneyDto, parcels: z.array(Parcel).max(50) })).max(50),
  items_subtotal: MoneyDto,
  discount: MoneyDto,
  shipping: MoneyDto,
  vat_included: MoneyDto,
  store_credit: MoneyDto,
  total: MoneyDto,
  verified_savings: MoneyDto,
  fees: z.array(z.strictObject({ code: z.string().max(500), amount: MoneyDto })).max(200),
  payment_options: z.array(z.strictObject({ method: z.string().max(50), available: z.boolean(), payable: MoneyDto })).max(20),
  cod_allowed: z.boolean(),
  cod_reason_code: z.enum(["cod_disabled", "cod_above_first_order_cap", "cod_risk_declined", "cod_risk_unavailable"]).nullable(),
  invalid_voucher_codes: z.array(z.string().max(500)).max(50),
  discount_labels: z.array(z.strictObject({ promotion_id: z.string().max(100), kind: z.enum(["voucher", "discount"]), text_ar: z.string().max(500), text_en: z.string().max(500), amount: MoneyDto })).max(100),
  notices: z.array(z.strictObject({ code: z.literal("unavailable"), line_id: z.null() })).max(50),
  /** Opaque: send it back unchanged in POST /checkout (it is what the signed token's hash covers). */
  quote_echo: z.json(),
});

/** Contract CheckoutInput plus `quote_echo` (the price lock needs the quote the shopper saw). `client_total` is validated, never trusted. */
export const CheckoutBody = z.strictObject({
  ...QuoteFields,
  quote_token: z.string().min(1).max(2000),
  quote_echo: z.record(z.string(), z.unknown()),
  client_total: MoneyDto,
  accept_price_change: z.boolean().optional(),
});

const ClientActionDto = z.strictObject({
  kind: z.enum(["redirect", "iframe", "sdk", "fawry_reference", "instapay_qr", "cod_confirmation", "none"]),
  url: z.string().max(2048).nullable(),
  reference: z.string().max(500).nullable(),
  expires_at: Iso.nullable(),
});
export type ClientActionDto = z.infer<typeof ClientActionDto>;

export const CheckoutResult = z.strictObject({
  order_group_id: z.uuid(),
  status: z.string().max(50),
  client_action: ClientActionDto,
  reservation_expires_at: Iso.nullable(),
});

export const OrderGroupId = z.strictObject({ order_group_id: z.uuid() });
export const OrderGroupsQuery = z.strictObject({
  cursor: z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  status: z.string().max(200).optional(),
});
export const OrderGroupSummary = z.strictObject({ id: z.uuid(), status: z.string().max(50), total: MoneyDto, store_count: z.number().int(), placed_at: Iso });
export const OrderGroupSummaryPage = pageOf(OrderGroupSummary);
export type OrderGroupSummaryPage = z.infer<typeof OrderGroupSummaryPage>;

const OrderLine = z.strictObject({ id: z.uuid(), sku_id: z.uuid(), title_ar: z.string().max(500), qty: z.number().int(), unit_price: MoneyDto });
const SellerOrder = z.strictObject({
  id: z.uuid(),
  store_id: z.uuid(),
  store_display_name_ar: z.string().min(1).max(500),
  status: z.string().max(50),
  items_subtotal: MoneyDto,
  shipping: MoneyDto,
  vat: MoneyDto,
  total: MoneyDto,
  lines: z.array(OrderLine).max(50),
  /** Cancellation, returns and tax documents are not built yet: reported as not available, never guessed. */
  cancellable: z.literal(false),
  returnable: z.literal(false),
  tax_documents: z.array(z.never()).max(0),
});
export const OrderGroup = z.strictObject({
  id: z.uuid(),
  status: z.string().max(50),
  currency: z.string().regex(/^[A-Z]{3}$/),
  items_subtotal: MoneyDto,
  discount: MoneyDto,
  shipping: MoneyDto,
  vat: MoneyDto,
  store_credit: MoneyDto,
  total: MoneyDto,
  payment_method: z.string().max(50),
  payment_status: z.string().max(50),
  client_action: ClientActionDto.nullable(),
  placed_at: Iso,
  paid_at: Iso.nullable(),
  seller_orders: z.array(SellerOrder).max(50),
});
export type OrderGroup = z.infer<typeof OrderGroup>;

export const CodConfirmationBody = z.strictObject({ code: z.string().regex(/^[0-9]{6}$/) });
export const ProviderParams = z.strictObject({ provider: z.enum(["paymob", "kashier", "fawry"]) });
export const WebhookAck = z.strictObject({ received: z.boolean(), duplicate: z.boolean() });
