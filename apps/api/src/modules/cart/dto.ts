import { z } from "zod";
import { MoneyDto } from "../../platform/money-wire.js";
import { pageOf } from "../../platform/pagination.js";

const Iso = z.iso.datetime();

export const CartLineInput = z.strictObject({ sku_id: z.uuid(), qty: z.number().int().min(1).max(10), source: z.enum(["pdp", "quick_add", "shelf", "wishlist", "drop", "stylist"]).optional() });
export const CartLinePatch = z.strictObject({ qty: z.number().int().min(1).max(10).optional(), saved_for_later: z.boolean().optional() });
export const CartLineId = z.strictObject({ cart_line_id: z.uuid() });
export const SuggestionsQuery = z.strictObject({
  store_id: z.uuid(),
  cursor: z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

/**
 * Price block of a bag line. The bag only ever shows the live price as a plain price: no strike-through and no "% off"
 * (those exist only where the Price Integrity Engine verified them, never in the bag).
 */
const PriceDisplay = z.strictObject({ current_price: MoneyDto, claim_type: z.literal("plain"), price_proof_path: z.string().max(500) });

const CartLine = z.strictObject({
  id: z.uuid(),
  sku_id: z.uuid(),
  product_id: z.uuid(),
  store_id: z.uuid(),
  qty: z.number().int(),
  price_at_add: MoneyDto,
  current_price: PriceDisplay,
  defect_ack_required: z.boolean(),
  saved_for_later: z.boolean(),
  available: z.boolean(),
  source: z.string().max(500).nullable(),
  added_at: Iso,
});

const CartStoreGroup = z.strictObject({
  store_id: z.uuid(),
  store_slug: z.string().max(500),
  display_name_ar: z.string().min(1).max(500),
  subtotal: MoneyDto,
  free_delivery_threshold: MoneyDto,
  remaining_for_free_delivery: MoneyDto,
  lines: z.array(CartLine).max(50),
});

export const Cart = z.strictObject({
  id: z.uuid().nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  version: z.number().int(),
  groups: z.array(CartStoreGroup).max(50),
  items_subtotal: MoneyDto,
  notices: z.array(z.strictObject({ code: z.enum(["price_dropped", "price_rose", "unavailable", "store_suspended"]), line_id: z.uuid().nullable() })).max(50),
});
export type Cart = z.infer<typeof Cart>;

/** Free-delivery suggestions are product cards; the card shape is shared with discovery later. Empty until the engine exists. */
export const SuggestionCard = z.strictObject({ product_id: z.uuid() });
export const SuggestionPage = pageOf(SuggestionCard);
export type SuggestionPage = z.infer<typeof SuggestionPage>;
