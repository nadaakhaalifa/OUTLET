/**
 * Guest behaviour table (docs/specs/guest-browsing.md section 2, owner rule R0). One place decides what a signed-out
 * shopper sees for every account-bound feature: hidden, an honest empty state, a device-local version, or deferred
 * until after the checkout sign-up. No kind ever means "ask the guest to create an account".
 */
export type GuestKind = "hidden" | "empty" | "local" | "deferred";

export interface GuestRule {
  readonly kind: GuestKind;
  /** The feature keeps an entry point (a Me row, a link) for a guest. */
  readonly entry: boolean;
  /** A guest opens the real screen in a reduced guest mode (otherwise the route shows the honest state). */
  readonly screen: boolean;
}

export const GUEST_FEATURES = [
  "checkout", "orders", "returns", "wallet", "rewards", "giftCards", "plus", "referral", "reviewWrite", "notifications",
  "sizeProfile", "priceAlerts", "savedSearchAlerts", "shareLists", "budget", "stylist", "stylistChat", "visualSearch", "nlSearch",
  "drops", "addresses", "sessions", "accountDeletion", "serverPrivacy", "guestPrivacy", "autoBuy", "outfitCalendar", "wardrobe", "family",
] as const;
export type GuestFeature = (typeof GUEST_FEATURES)[number];

const R = (kind: GuestKind, entry: boolean, screen: boolean): GuestRule => ({ kind, entry, screen });

export const GUEST_RULES: Readonly<Record<GuestFeature, GuestRule>> = {
  checkout: R("deferred", false, false),
  orders: R("empty", true, false),
  returns: R("empty", false, false),
  wallet: R("hidden", false, false),
  rewards: R("hidden", false, false),
  giftCards: R("deferred", false, false),
  plus: R("deferred", true, true),
  referral: R("deferred", false, false),
  reviewWrite: R("hidden", false, false),
  notifications: R("deferred", false, false),
  sizeProfile: R("local", true, true),
  priceAlerts: R("local", false, false),
  savedSearchAlerts: R("hidden", false, false),
  shareLists: R("hidden", false, false),
  budget: R("deferred", false, false),
  stylist: R("deferred", false, false),
  stylistChat: R("deferred", false, false),
  visualSearch: R("deferred", false, false),
  nlSearch: R("deferred", false, false),
  drops: R("empty", true, true),
  addresses: R("hidden", false, false),
  sessions: R("hidden", false, false),
  accountDeletion: R("hidden", false, false),
  serverPrivacy: R("hidden", false, false),
  guestPrivacy: R("local", true, true),
  autoBuy: R("hidden", false, false),
  outfitCalendar: R("deferred", false, false),
  wardrobe: R("deferred", false, false),
  family: R("hidden", false, false),
};

export function guestRule(feature: GuestFeature): GuestRule { return GUEST_RULES[feature]; }
/** `guestBehaviour(feature) -> hidden | empty | local | deferred` (spec section 2). */
export function guestBehaviour(feature: GuestFeature): GuestKind { return GUEST_RULES[feature].kind; }

/** Routes that carry a guest guard, mapped to their feature. */
export const GUEST_ROUTES = {
  "/orders": "orders", "/returns": "returns", "/wallet": "wallet", "/rewards": "rewards", "/gift-cards": "giftCards", "/plus": "plus",
  "/budget": "budget", "/stylist": "stylist", "/visual-search": "visualSearch", "/drops": "drops", "/size-profile": "sizeProfile",
  "/addresses": "addresses", "/auto-buy": "autoBuy", "/outfit-calendar": "outfitCalendar", "/wardrobe": "wardrobe", "/privacy-center": "guestPrivacy",
} as const satisfies Readonly<Record<string, GuestFeature>>;
