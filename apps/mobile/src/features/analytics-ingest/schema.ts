import { z } from "zod";

/**
 * Wire shapes of POST /v1/analytics/events (docs/specs/dashboard-foundations.md section 5, "Client
 * ingest"). Every object is strict: an unlisted key fails the event. No user id, no budget, no
 * measurement data and no free text exist in any shape.
 */
export const INGEST_SURFACES = ["feed", "search", "stylist", "shared_link", "ads", "creators", "my_stores", "store_page", "other"] as const;
export type IngestSurface = (typeof INGEST_SURFACES)[number];
export const INGEST_SOURCES = INGEST_SURFACES;
export type IngestSource = IngestSurface;

export const MAX_BATCH_EVENTS = 50;
export const MAX_IMPRESSION_ITEMS = 30;

const opaqueId = z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/);
const surface = z.enum(INGEST_SURFACES);
const envelope = { event_id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/), occurred_at: z.iso.datetime() };

export const StoreViewedWire = z.strictObject({ name: z.literal("store_viewed"), ...envelope, properties: z.strictObject({ store_id: opaqueId, source: surface }) });
export const ProductViewedWire = z.strictObject({
  name: z.literal("product_viewed"),
  ...envelope,
  properties: z.strictObject({ store_id: opaqueId, product_id: opaqueId, source: surface }),
});
export const ProductImpressionsWire = z.strictObject({
  name: z.literal("product_impressions"),
  ...envelope,
  properties: z
    .strictObject({
      surface,
      items: z
        .array(z.strictObject({ product_id: opaqueId, store_id: opaqueId, position: z.number().int().min(0).max(10_000) }))
        .min(1)
        .max(MAX_IMPRESSION_ITEMS),
    })
    .refine((p) => new Set(p.items.map((i) => i.position)).size === p.items.length, { message: "duplicate position" }),
});

export const IngestEventWire = z.discriminatedUnion("name", [StoreViewedWire, ProductViewedWire, ProductImpressionsWire]);
export type IngestEvent = z.infer<typeof IngestEventWire>;

export const IngestBatchWire = z.strictObject({ sent_at: z.iso.datetime(), events: z.array(IngestEventWire).min(1).max(MAX_BATCH_EVENTS) });
export type IngestBatch = z.infer<typeof IngestBatchWire>;

/** Event content before the emitter adds `event_id` and `occurred_at`. */
export type IngestEventInput =
  | { readonly name: "store_viewed"; readonly properties: { readonly store_id: string; readonly source: IngestSurface } }
  | { readonly name: "product_viewed"; readonly properties: { readonly store_id: string; readonly product_id: string; readonly source: IngestSurface } }
  | {
      readonly name: "product_impressions";
      readonly properties: {
        readonly surface: IngestSurface;
        readonly items: readonly { readonly product_id: string; readonly store_id: string; readonly position: number }[];
      };
    };

/** Defence in depth: the server rejects the whole batch for these keys, the client never builds them. */
const FORBIDDEN_KEY = /^(user_?id|phone|email|address|dob|measurements?|budget_.*|height|weight|bust|waist|hip)$/i;

export function hasForbiddenKey(value: unknown, depth = 0): boolean {
  if (depth > 6 || value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((v) => hasForbiddenKey(v, depth + 1));
  for (const [k, v] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(k) || hasForbiddenKey(v, depth + 1)) return true;
  }
  return false;
}
