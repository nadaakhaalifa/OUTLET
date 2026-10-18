import { z } from "zod";

/** Closed enums (closes the "7-source taxonomy not enforced" gap). */
export const SURFACES = ["feed", "search", "stylist", "shared_link", "ads", "creators", "my_stores", "store_page", "other"] as const;
export const surface = z.enum(SURFACES);
export const WISHLIST_INTENTS = ["need", "want", "treat", "buy_later_this_month", "birthday", "eid_ramadan", "gift", "custom"] as const;

export const MAX_BATCH_EVENTS = 50;
export const MAX_IMPRESSION_ITEMS = 30;
export const MAX_BODY_BYTES = 64 * 1024;

const id = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const base = { event_id: id, occurred_at: z.iso.datetime() };

/** Every variant is strict: any key not listed fails the event. */
export const AnalyticsClientEvent = z.discriminatedUnion("name", [
  z.strictObject({ name: z.literal("store_viewed"), ...base, properties: z.strictObject({ store_id: id, source: surface }) }),
  z.strictObject({
    name: z.literal("product_viewed"),
    ...base,
    properties: z.strictObject({ store_id: id, product_id: id, source: surface }),
  }),
  z.strictObject({
    name: z.literal("product_impressions"),
    ...base,
    properties: z.strictObject({
      surface,
      items: z
        .array(z.strictObject({ product_id: id, store_id: id, position: z.number().int().min(0).max(1000) }))
        .min(1)
        .max(MAX_IMPRESSION_ITEMS),
    }),
  }),
  z.strictObject({ name: z.literal("add_to_bag"), ...base, properties: z.strictObject({ store_id: id, product_id: id, source: surface }) }),
  z.strictObject({
    name: z.literal("wishlist_added"),
    ...base,
    properties: z.strictObject({ product_id: id, intent: z.enum(WISHLIST_INTENTS) }),
  }),
  z.strictObject({
    name: z.literal("search_result_clicked"),
    ...base,
    properties: z.strictObject({ store_id: id, product_id: id, term: z.string().max(120) }),
  }),
]);
export type AnalyticsClientEvent = z.output<typeof AnalyticsClientEvent>;

/** Envelope: events stay `unknown` so one bad event rejects itself, not the batch. */
export const AnalyticsEventBatchEnvelope = z.strictObject({
  sent_at: z.iso.datetime(),
  events: z.array(z.unknown()).min(1).max(MAX_BATCH_EVENTS),
});

const FORBIDDEN_EXACT = new Set(["user_id", "phone", "email", "address", "dob", "measurements"]);

/** True for keys that must never arrive from a client (defence in depth). */
export function isForbiddenKey(key: string): boolean {
  const k = key.toLowerCase();
  return FORBIDDEN_EXACT.has(k) || /^budget_/.test(k);
}

/** Depth-bounded scan of the raw body; returns the first forbidden key path or null. */
export function findForbiddenKey(value: unknown, depth = 0): string | null {
  if (depth > 8 || typeof value !== "object" || value === null) return null;
  if (Array.isArray(value)) {
    for (const v of value) {
      const hit = findForbiddenKey(v, depth + 1);
      if (hit !== null) return hit;
    }
    return null;
  }
  for (const [k, v] of Object.entries(value)) {
    if (isForbiddenKey(k)) return k;
    const hit = findForbiddenKey(v, depth + 1);
    if (hit !== null) return hit;
  }
  return null;
}
