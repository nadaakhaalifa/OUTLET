/**
 * Device-only guest state (spec guest-browsing §7, ADR-0055). NO PII: ids, quantities, timestamps, public
 * catalogue display text. No install id lives here (it stays in SecureStore). Strict Zod, so unknown fields fail the read.
 * Timestamps are epoch milliseconds. Piastres are decimal strings (bigint in memory).
 */
import { z } from "zod";

export const GUEST_SCHEMA_VERSION = 4;
export const MAX_ALERTS = 100;
export const MAX_BAG_LINES = 50;
export const MAX_UNITS_PER_ITEM = 10;
export const MAX_SAVED = 200;
export const MAX_VIEWED = 100;
export const MAX_AFFINITY_KEYS = 50;
/** Serialised size cap (spec §7). */
export const MAX_STATE_BYTES = 256 * 1024;

const DAY_MS = 24 * 60 * 60 * 1000;
export const TTL_MS = { bag: 30 * DAY_MS, saved: 180 * DAY_MS, viewed: 30 * DAY_MS, alerts: 180 * DAY_MS } as const;

export const SAVED_INTENTS = ["need", "want", "treat", "later"] as const;
export type SavedIntent = (typeof SAVED_INTENTS)[number];

const piastres = z.string().regex(/^\d{1,15}$/);
const id = z.string().min(1).max(80);
const ts = z.number().int().nonnegative();

export const BagLineSchema = z.object({
  id,
  skuId: id,
  productId: id,
  storeId: id,
  qty: z.number().int().min(1).max(MAX_UNITS_PER_ITEM),
  savedForLater: z.boolean(),
  addedAt: ts,
  touchedAt: ts,
  seen: z.object({
    unitPricePiastres: piastres,
    title: z.string().max(200),
    sizeLabel: z.string().max(40).nullable(),
    storeName: z.string().max(120),
    imageUrl: z.string().max(500).nullable(),
  }).strict(),
}).strict();

export const SavedItemSchema = z.object({
  productId: id,
  skuId: id.nullable(),
  intent: z.enum(SAVED_INTENTS),
  addedAt: ts,
  seenPricePiastres: piastres,
}).strict();

export const ALERT_KINDS = ["price_drop", "restock"] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];
/** Local "Notify me" intent. Ids and a public price only. Never sent in the guest-merge body (no alerts field exists there). */
export const AlertSchema = z.object({
  productId: id,
  skuId: id.nullable(),
  kind: z.enum(ALERT_KINDS),
  seenPricePiastres: piastres.nullable(),
  addedAt: ts,
}).strict();

export const ViewedSchema = z.object({ productId: id, at: ts }).strict();
const counts = z.record(id, z.number().int().positive()).refine((r) => Object.keys(r).length <= MAX_AFFINITY_KEYS);

export const BANNER_STATES = ["unanswered", "allowed", "declined"] as const;
export type BannerState = (typeof BANNER_STATES)[number];

const shared = {
  createdAt: ts,
  updatedAt: ts,
  bag: z.array(BagLineSchema).max(MAX_BAG_LINES),
  saved: z.array(SavedItemSchema).max(MAX_SAVED),
  viewed: z.array(ViewedSchema).max(MAX_VIEWED),
  affinity: z.object({ stores: counts, categories: counts }).strict(),
  merge: z.object({ pendingKey: id.nullable(), startedAt: ts.nullable() }).strict(),
};

export const GuestStateV1Schema = z.object({ v: z.literal(1), ...shared }).strict();
export const GuestStateV2Schema = z.object({
  v: z.literal(2),
  ...shared,
  /** Pseudonymous random id for this install; never a device or hardware identifier. */
  installId: z.string().min(8).max(64),
  /** Device analytics-banner answer (spec §5). */
  consentBanner: z.enum(BANNER_STATES),
}).strict();

/** v3 drops installId: the plaintext file must hold no online identifier (spec §5, VR-GUEST-02). */
export const GuestStateV3Schema = z.object({
  v: z.literal(3),
  ...shared,
  consentBanner: z.enum(BANNER_STATES),
}).strict();

/** v4 adds local alerts (additive). */
const DEFAULT_SETTINGS = { coolOff: false, historyPaused: false };
/** Device settings. Defaults make older v4 files (without the field) parse unchanged. */
export const SettingsSchema = z.object({ coolOff: z.boolean(), historyPaused: z.boolean() }).strict();

export const GuestStateV4Schema = z.object({
  v: z.literal(4),
  ...shared,
  consentBanner: z.enum(BANNER_STATES),
  alerts: z.array(AlertSchema).max(MAX_ALERTS),
  settings: SettingsSchema.default(DEFAULT_SETTINGS),
}).strict();

export type GuestStateV3 = z.infer<typeof GuestStateV3Schema>;
export type GuestStateV1 = z.infer<typeof GuestStateV1Schema>;
export type GuestStateV2 = z.infer<typeof GuestStateV2Schema>;
export type GuestState = z.infer<typeof GuestStateV4Schema>;
export type GuestAlert = GuestState["alerts"][number];
export type GuestBagLine = GuestState["bag"][number];
export type GuestSavedItem = GuestState["saved"][number];
export type GuestViewed = GuestState["viewed"][number];
