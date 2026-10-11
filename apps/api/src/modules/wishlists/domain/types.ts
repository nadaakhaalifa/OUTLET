/**
 * Wishlist domain types (spec section 8). Pure data: no I/O, no clock, no randomness.
 * Time is epoch milliseconds supplied by the caller. Money is integer piastres (bigint).
 */

/** Structurally identical to `Money` in @outlet/domain (EGP only, bigint minor units). */
export interface Money {
  readonly amount: bigint;
  readonly currency: "EGP";
}

export const WISHLIST_INTENTS = [
  "need",
  "want",
  "treat",
  "buy_later_this_month",
  "birthday",
  "eid_ramadan",
  "gift_for_someone",
  "custom",
] as const;
export type WishlistIntent = (typeof WISHLIST_INTENTS)[number];

/** ISO calendar date, YYYY-MM-DD. */
export type CalendarDate = string;

export interface GiftFor {
  readonly nickname: string;
  readonly occasion: string | null;
  readonly date: CalendarDate | null;
}

export interface ShareLink {
  /** SHA-256 hex of the token. The token itself is never stored. */
  readonly tokenHash: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number | null;
  readonly revokedAtMs: number | null;
  /** Gift-wrap flag: viewers of the link see no prices. */
  readonly hidePrices: boolean;
}

export interface Wishlist {
  readonly id: string;
  readonly userId: string;
  readonly intent: WishlistIntent;
  readonly title: string;
  readonly targetDate: CalendarDate | null;
  readonly budget: Money | null;
  readonly giftFor: GiftFor | null;
  readonly coolOffEnabled: boolean;
  readonly share: ShareLink | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface WishlistItem {
  readonly id: string;
  readonly wishlistId: string;
  readonly userId: string;
  readonly productId: string;
  readonly skuPref: string | null;
  readonly addedPrice: Money;
  readonly note: string | null;
  readonly coolOffUntilMs: number | null;
  readonly addedAtMs: number;
}

export const LIMITS = {
  maxWishlistsPerUser: 50,
  maxItemsPerWishlist: 200,
  titleMax: 80,
  nicknameMax: 40,
  occasionMax: 40,
  noteMax: 200,
  /** 10,000,000 EGP in piastres. */
  budgetMaxMinor: 1_000_000_000n,
  coolOffMs: 24 * 60 * 60 * 1000,
  shareMaxLifetimeMs: 365 * 24 * 60 * 60 * 1000,
  lowStockMax: 3,
  dateAlertDays: [7, 1] as readonly number[],
} as const;

export type WishlistRuleViolation =
  | "title_invalid"
  | "target_date_invalid"
  | "target_date_in_past"
  | "budget_invalid"
  | "gift_for_required"
  | "gift_for_not_allowed"
  | "gift_for_invalid"
  | "cool_off_requires_want"
  | "note_invalid"
  | "share_expiry_invalid";

export type Result<T, E extends string> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };
export const ok = <T>(value: T): { readonly ok: true; readonly value: T } => ({ ok: true, value });
export const err = <E extends string>(error: E): { readonly ok: false; readonly error: E } => ({ ok: false, error });
