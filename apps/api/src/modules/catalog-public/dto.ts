import { MediaRef, ProductCard } from "@outlet/catalog";
import { z } from "zod";
import { CursorQuery, pageOf } from "../../platform/pagination.js";

/** Shopper discovery DTOs (wire shape, snake_case). Extra fields beyond docs/api/openapi.yaml are noted per field. */

export const StoresQuery = CursorQuery.extend({
  world: z.enum(["local", "global", "both"]).optional(),
  category_id: z.uuid().optional(),
  /** Case-insensitive substring of the Arabic or English store name. */
  q: z.string().trim().min(1).max(80).optional(),
});
export type StoresQuery = z.infer<typeof StoresQuery>;

export const StoreCard = z.strictObject({
  id: z.uuid(),
  slug: z.string().max(500),
  display_name_ar: z.string().min(1).max(500),
  display_name_en: z.string().max(500).nullable(),
  tagline_ar: z.string().max(500).nullable(),
  tagline_en: z.string().max(500).nullable(),
  kind: z.enum(["local", "global"]),
  verified_badge: z.boolean(),
  storefront: z.strictObject({ template_code: z.string(), palette: z.record(z.string(), z.unknown()), published_version: z.number().int() }),
  /** No drops module yet: always false (never a fake "live" badge). */
  live_drop: z.boolean(),
  followers_count: z.number().int(),
  /** Extra: only `public` stores may show a % off anywhere. */
  discount_display_mode: z.enum(["public", "member_only", "hidden"]),
  /** Extra: storefront art. The published read model carries no storefront media reference yet, so this is null until it does. */
  art: MediaRef.nullable(),
  canonical_path: z.string(),
});
export type StoreCard = z.infer<typeof StoreCard>;
export const StoreCardPage = pageOf(StoreCard);
export type StoreCardPage = z.infer<typeof StoreCardPage>;

export const CategoriesQuery = CursorQuery.extend({ parent_id: z.uuid().optional() });
export type CategoriesQuery = z.infer<typeof CategoriesQuery>;

export const CategoryEntry = z.strictObject({
  id: z.uuid(),
  parent_id: z.uuid().nullable(),
  code: z.string(),
  path: z.string(),
  depth: z.number().int().min(0),
  vertical: z.string(),
  /** Label in the request locale (Accept-Language, Arabic by default). */
  name: z.string(),
  slug: z.string(),
  /** Extra: both labels, so a client can render either without a second call. */
  name_ar: z.string(),
  name_en: z.string().nullable(),
});
export type CategoryEntry = z.infer<typeof CategoryEntry>;
export const CategoryEntryPage = pageOf(CategoryEntry);
export type CategoryEntryPage = z.infer<typeof CategoryEntryPage>;

export const DEAL_BANDS = ["70_60", "59_50", "49_40"] as const;
export const DealsQuery = CursorQuery.extend({ band: z.enum(DEAL_BANDS).optional() });
export type DealsQuery = z.infer<typeof DealsQuery>;

/** Shelf card plus the quick-view fields that exist as real read-model columns (condition label, colour). */
export const QuickProductCard = ProductCard.extend({
  condition_label_ar: z.string().nullable(),
  condition_label_en: z.string().nullable(),
  colour_code: z.string().nullable(),
});
export type QuickProductCard = z.infer<typeof QuickProductCard>;
export const QuickProductCardPage = pageOf(QuickProductCard);
export type QuickProductCardPage = z.infer<typeof QuickProductCardPage>;

export const DealCardPage = pageOf(ProductCard);
export type DealCardPage = z.infer<typeof DealCardPage>;
