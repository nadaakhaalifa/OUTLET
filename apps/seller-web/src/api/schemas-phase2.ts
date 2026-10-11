/**
 * Phase 2 seller schemas (ads, drops, resale, crawl/channels, size curve, hub tracking) from docs/api/openapi.yaml.
 * Server strings that are not closed enums stay `z.string()`: the view-models map known values and fall back to "unknown".
 */
import { z } from "zod";
import { meta, moneySchema, page, timestamp, uuid } from "./schemas";

const piastres = z.string().regex(/^[0-9]{1,18}$/).transform((s) => BigInt(s));

/* ---- sponsored products ---- */
export const adBid = z.object({ product_id: uuid, bid: moneySchema });
export const adCampaign = z.object({
  id: uuid,
  store_id: uuid,
  name: z.string(),
  status: z.string(),
  daily_budget: moneySchema,
  max_cpc: moneySchema,
  keywords: z.array(z.string()),
  categories: z.array(z.string()),
  starts_at: timestamp.nullable(),
  ends_at: timestamp.nullable(),
  bids: z.array(adBid),
  vat_inclusive: z.literal(false),
  created_at: timestamp.nullable(),
});
export type AdCampaign = z.infer<typeof adCampaign>;
export const adCampaignList = z.object({ items: z.array(adCampaign) });
export const adBalance = z.object({
  balance: moneySchema,
  vat_inclusive: z.literal(false),
  top_ups: z.array(z.object({ id: z.string(), status: z.string(), net: moneySchema, vat: moneySchema, gross: moneySchema })),
});
export type AdBalance = z.infer<typeof adBalance>;
const adStats = {
  impressions: z.number().int(),
  clicks: z.number().int(),
  spend: moneySchema,
  attributed_revenue: moneySchema,
  ctr_bp: z.number().int(),
  cpc: moneySchema.nullable(),
  roas_bp: z.string().regex(/^[0-9]{1,18}$/).nullable(),
};
export const adReport = z.object({
  from: timestamp,
  to: timestamp,
  total: z.object(adStats),
  campaigns: z.array(z.object({ campaign_id: uuid, name: z.string(), ...adStats })),
});
export type AdReport = z.infer<typeof adReport>;
export const adTopUp = z.object({
  top_up_id: z.string(),
  status: z.string(),
  net: moneySchema,
  vat: moneySchema,
  gross: moneySchema,
  payment: z.object({ intent_ref: z.string().nullable(), client_action: z.record(z.string(), z.unknown()).nullable() }),
  replayed: z.boolean(),
});
export type AdTopUp = z.infer<typeof adTopUp>;

/* ---- drops ---- */
export const dropType = z.enum(["public", "members_only", "flash_hour", "mystery_box", "price_ladder", "last_chance"]);
export type DropType = z.infer<typeof dropType>;
export const sellerDrop = z.object({
  id: uuid,
  store_id: uuid,
  type: dropType,
  state: z.string(),
  paused: z.boolean(),
  title: z.string(),
  starts_at: timestamp,
  early_access_at: timestamp.nullable(),
  ends_at: timestamp,
  limits: z.object({ per_user: z.number().int(), per_device: z.number().int() }),
  mystery: z.object({ min_value: piastres, max_value: piastres, guaranteed_min: piastres, currency: z.literal("EGP") }).nullable(),
  ladder: z.array(z.object({ at: timestamp, prices: z.array(z.object({ sku_id: uuid, price: piastres })) })),
  server_time: timestamp,
  currency: z.literal("EGP"),
  admit_per_sec: z.number().int().nullable(),
  version: z.number().int(),
  items: z.array(z.object({ sku_id: uuid, stock_cap: z.number().int(), price: piastres })),
  created_at: timestamp,
  updated_at: timestamp,
});
export type SellerDrop = z.infer<typeof sellerDrop>;
export const sellerDropPage = page(sellerDrop);

/* ---- resale (open-box) ---- */
export const resaleListing = z.object({
  id: uuid,
  sku_id: uuid,
  grade: z.enum(["A", "B", "C"]),
  price_piastres: piastres,
  ownership: z.string(),
  status: z.string(),
  listed_at: timestamp,
  sold_at: timestamp.nullable(),
});
export type ResaleListing = z.infer<typeof resaleListing>;
export const resaleListingList = z.object({ items: z.array(resaleListing) });
export const resaleWithdrawn = z.object({ id: uuid, status: z.literal("WITHDRAWN") });

/* ---- channels and crawl ---- */
export const channelType = z.enum(["shopify", "woocommerce"]);
export type ChannelType = z.infer<typeof channelType>;
export const channelConnection = z.object({
  id: uuid,
  type: channelType,
  shop_domain: z.string(),
  status: z.enum(["pending_oauth", "connected", "revoked", "error"]),
  last_snapshot_at: timestamp.nullable().optional(),
  connect_url: z.string().url().optional(),
});
export type ChannelConnection = z.infer<typeof channelConnection>;
export const channelConnectionPage = page(channelConnection);
export const crawlTarget = z.object({
  id: uuid,
  domain: z.string(),
  kind: z.string(),
  status: z.string(),
  verification_method: z.enum(["dns_txt", "file"]),
  verified_at: timestamp.nullable(),
  robots_checked_at: timestamp.nullable(),
});
export type CrawlTarget = z.infer<typeof crawlTarget>;
export const crawlTargetList = z.object({ items: z.array(crawlTarget) });

/* ---- analytics v2 ---- */
export const sizeCurveReport = z.object({
  products: z.array(
    z.object({
      product_id: uuid,
      rows: z.array(
        z.object({
          size: z.string(),
          sold_units: z.number().int(),
          on_hand_units: z.number().int(),
          sold_share_bps: z.number().int().nullable(),
          stocked_share_bps: z.number().int().nullable(),
          gap_bps: z.number().int().nullable(),
        }),
      ),
      total_sold: z.number().int(),
      total_stocked: z.number().int(),
    }),
  ),
  meta,
});
export type SizeCurveReport = z.infer<typeof sizeCurveReport>;

/* ---- hub consolidation (shopper-scoped tracking contract; see the spec for the seller-side gap) ---- */
export const hubTracking = z.object({
  order_group_id: uuid,
  delivery_fee_piastres: piastres,
  waiting_seller_orders: z.number().int(),
  parcels: z.array(
    z.object({
      id: uuid,
      status: z.string(),
      awb: z.string().nullable(),
      courier: z.string().nullable(),
      seller_order_count: z.number().int(),
      fee_charged_piastres: piastres,
    }),
  ),
});
export type HubTracking = z.infer<typeof hubTracking>;
