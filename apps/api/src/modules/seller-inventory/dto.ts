import { z } from "zod";
import { CursorQuery } from "../../platform/pagination.js";

const Iso = z.iso.datetime();

/** Below this many sellable units the shelf shows a low-stock badge (master prompt 8: "low stock <= 3"). Real levels only. */
export const LOW_STOCK_THRESHOLD = 3;

export const InventoryQuery = CursorQuery.extend({ sku_id: z.uuid().optional(), location_id: z.uuid().optional() });
export type InventoryQuery = z.infer<typeof InventoryQuery>;

export const ADJUST_REASONS = ["recount", "damage", "received", "correction", "channel_sync"] as const;
export const InventoryAdjustmentInput = z.strictObject({
  sku_id: z.uuid(),
  /** Omitted: the store's default location (created on first use). */
  location_id: z.uuid().optional(),
  delta: z.number().int().min(-100_000).max(100_000).refine((n) => n !== 0, "delta must not be zero"),
  reason: z.enum(ADJUST_REASONS),
  /** Optimistic lock: the level `version` the caller saw (0 when the SKU has no level yet). Omitted: no check. */
  expected_version: z.number().int().min(0).optional(),
});
export type InventoryAdjustmentInput = z.infer<typeof InventoryAdjustmentInput>;

export const InventoryLevel = z.strictObject({
  sku_id: z.uuid(),
  location_id: z.uuid().nullable(),
  seller_sku: z.string().max(200),
  size_label: z.string().max(100).nullable(),
  product_title_ar: z.string().max(500),
  on_hand: z.number().int(),
  committed: z.number().int(),
  available: z.number().int(),
  low_stock: z.boolean(),
  version: z.number().int(),
  updated_at: Iso,
});
export type InventoryLevel = z.infer<typeof InventoryLevel>;
export const InventoryLevelPage = z.strictObject({ items: z.array(InventoryLevel).max(50), next_cursor: z.string().max(512).nullable() });
export type InventoryLevelPage = z.infer<typeof InventoryLevelPage>;
