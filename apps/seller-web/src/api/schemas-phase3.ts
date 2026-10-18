/** Phase 3 seller schemas (demand forecasts, store stock/price channels) from the generated contract. */
import { z } from "zod";
import { uuid } from "./schemas";

export const forecastScope = z.enum(["sku", "category", "category_size", "category_governorate"]);
export type ForecastScope = z.infer<typeof forecastScope>;
export const forecastInterval = z.object({
  p10: z.number().int().min(0), p50: z.number().int().min(0), p90: z.number().int().min(0), nominal_coverage_bps: z.number().int(),
});
export const forecastItem = z.object({
  scope: forecastScope, scope_key: z.string(), horizon_days: z.union([z.literal(7), z.literal(14), z.literal(28)]),
  status: z.enum(["ok", "insufficient_history", "suppressed"]), reason_codes: z.array(z.string()), model_version: z.string(),
  model: z.enum(["seasonal_naive", "ets_seasonal", "croston_sba"]).optional(),
  interval: forecastInterval.optional(),
  history: z.object({ comparable_units: z.number().int().optional(), observed_days: z.number().int().optional() }).optional(),
  backtest: z.object({
    origins: z.number().int().optional(), wape_bps: z.number().int().optional(), baseline_wape_bps: z.number().int().optional(),
    coverage_bps: z.number().int().optional(), bias_bps: z.number().int().optional(),
  }).optional(),
});
export type ForecastItem = z.infer<typeof forecastItem>;
export const forecastList = z.object({
  store_id: uuid, as_of_date: z.string(), generated_at: z.iso.datetime({ offset: true }), stale: z.boolean(),
  advice_only: z.literal(true), notice: z.object({ en: z.string(), ar: z.string() }), items: z.array(forecastItem), has_more: z.boolean(),
});
export type ForecastList = z.infer<typeof forecastList>;

export const storeChannelKind = z.enum(["shopify", "woocommerce", "odoo", "google_sheets", "crawler"]);
export type StoreChannelKind = z.infer<typeof storeChannelKind>;
export const storeChannel = z.object({
  id: uuid, kind: storeChannelKind, status: z.string(), target_id: uuid.nullable(), has_secret: z.literal(true), created_at: z.iso.datetime({ offset: true }),
});
export type StoreChannel = z.infer<typeof storeChannel>;
export const storeChannelList = z.object({ items: z.array(storeChannel) });

/* ---- product photo background removal (docs/specs/phase-3/product-media-background-removal.md) ---- */
export const MEDIA_MODELS = ["u2netp", "u2net", "birefnet-general-lite", "isnet-general-use"] as const;
export type MediaModel = (typeof MEDIA_MODELS)[number];
export const mediaStatus = z.enum(["PENDING", "PROCESSING", "READY", "NEEDS_REVIEW", "FAILED"]);
export type MediaStatus = z.infer<typeof mediaStatus>;
const mediaLink = z.object({ url: z.string().url(), expires_at: z.iso.datetime({ offset: true }) });
const mediaCommon = {
  id: uuid, store_id: uuid, status: mediaStatus, decision: z.enum(["none", "accepted", "use_original"]),
  requested_model: z.enum(MEDIA_MODELS).nullable(), model_id: z.string().nullable(),
  quality_score: z.number().int().min(0).max(100).nullable(), quality_reasons: z.array(z.string()),
  error_code: z.string().nullable(), attempts: z.number().int().min(0),
  /** Product the photo backs once linked (older API builds omit it: treated as free). */
  attached_product_id: uuid.nullable().optional(), version: z.number().int().min(1),
  created_at: z.iso.datetime({ offset: true }), updated_at: z.iso.datetime({ offset: true }),
};
export const productMediaSummary = z.object(mediaCommon);
export const productMediaList = z.object({ items: z.array(productMediaSummary) });
export const productMediaJob = z.object({
  ...mediaCommon,
  links: z.object({ original: mediaLink.nullable(), png: mediaLink.nullable(), white_jpg: mediaLink.nullable(), shadow: mediaLink.nullable() }),
});
export type ProductMediaSummary = z.infer<typeof productMediaSummary>;
export type ProductMediaJob = z.infer<typeof productMediaJob>;
