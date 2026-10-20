/**
 * Outfit calendar, pure domain (spec P3-02, docs/specs/phase-3/outfit-calendar.md).
 * Money is bigint piastres. Instants are UTC epoch milliseconds. The Cairo-local date is derived
 * through the tz database (Intl), never stored as an offset.
 */
import type { Season, Slot } from "../stylist/types";

export const EVENT_KINDS = ["work", "wedding_guest", "date", "eid", "university", "travel", "custom"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const EVENT_SOURCES = ["manual", "wishlist", "device"] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

export const MODESTY = ["standard", "modest"] as const;
export type Modesty = (typeof MODESTY)[number];

export type { Season, Slot };

export const OUTFIT_LINK_STATUSES = ["planned", "in_bag", "purchased", "worn"] as const;
export type OutfitLinkStatus = (typeof OUTFIT_LINK_STATUSES)[number];

export type EventStatus = "active" | "archived";
export type OutfitStatus = "none" | "planned" | "owned_only" | "needs_purchases";

export const MAX_FUTURE_EVENTS = 100;
export const MAX_NOTE_LENGTH = 200;
/** Local time used when the shopper gives only a date. */
export const DEFAULT_LOCAL_MINUTE = 12 * 60;
