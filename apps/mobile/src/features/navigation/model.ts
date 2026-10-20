/** Navigation view model (spec Part C "Tabs" and "Me"). Pure: no React, no router. */
import type { IconName } from "../../ui";
import { giftVisibility, type GiftCapabilities } from "../gift-cards/model";

export type TabId = "home" | "discover" | "saved" | "bag" | "profile";

export interface TabSpec {
  /** Expo Router file name inside `(tabs)`. */
  readonly route: string;
  readonly id: TabId;
  readonly titleKey: `tabs.${TabId}`;
  readonly testID: `tab-${TabId}`;
}

/** Logical order. In RTL the platform mirrors the bar, so Home is on the right; no manual reversal. */
export const TABS: readonly TabSpec[] = [
  { route: "index", id: "home", titleKey: "tabs.home", testID: "tab-home" },
  // File routes keep their old names (explore, me) so deep links /explore and /me still resolve.
  { route: "explore", id: "discover", titleKey: "tabs.discover", testID: "tab-discover" },
  { route: "saved", id: "saved", titleKey: "tabs.saved", testID: "tab-saved" },
  { route: "bag", id: "bag", titleKey: "tabs.bag", testID: "tab-bag" },
  { route: "me", id: "profile", titleKey: "tabs.profile", testID: "tab-profile" },
];

export type MeRowId = "orders" | "wallet" | "budget" | "wishlists" | "sizeProfile" | "addresses" | "plus" | "autoBuy" | "rewards" | "giftCards" | "outfitCalendar" | "wardrobe" | "stylist" | "privacy" | "help" | "settings";

export interface MeRow {
  readonly id: MeRowId;
  readonly titleKey: `me.rows.${MeRowId}`;
  readonly hintKey?: "me.rows.plusHint";
  readonly href: "/orders" | "/wallet" | "/budget" | "/wishlists" | "/size-profile" | "/addresses" | "/plus" | "/auto-buy" | "/rewards" | "/gift-cards" | "/outfit-calendar" | "/wardrobe" | "/stylist" | "/privacy-center" | "/help" | "/settings";
  readonly testID: `me-row-${MeRowId}`;
  readonly icon: IconName;
  /** Hairline-separated section in the Me list. */
  readonly group: 0 | 1 | 2;
}

const META: Record<MeRowId, { icon: IconName; group: 0 | 1 | 2 }> = {
  orders: { icon: "bag-handle-outline", group: 0 },
  wallet: { icon: "wallet-outline", group: 0 },
  budget: { icon: "pie-chart-outline", group: 0 },
  wishlists: { icon: "heart-outline", group: 0 },
  sizeProfile: { icon: "resize-outline", group: 1 },
  addresses: { icon: "location-outline", group: 1 },
  plus: { icon: "diamond-outline", group: 1 },
  autoBuy: { icon: "pricetag-outline", group: 1 },
  rewards: { icon: "ribbon-outline", group: 1 },
  giftCards: { icon: "gift-outline", group: 1 },
  outfitCalendar: { icon: "calendar-outline", group: 1 },
  wardrobe: { icon: "shirt-outline", group: 1 },
  stylist: { icon: "sparkles-outline", group: 1 },
  privacy: { icon: "shield-checkmark-outline", group: 2 },
  help: { icon: "help-circle-outline", group: 2 },
  settings: { icon: "settings-outline", group: 2 },
};

const ROW = <I extends MeRowId>(id: I, href: MeRow["href"], hintKey?: "me.rows.plusHint"): MeRow => ({
  id, titleKey: `me.rows.${id}`, href, testID: `me-row-${id}`, icon: META[id].icon, group: META[id].group, ...(hintKey !== undefined ? { hintKey } : {}),
});

const ALL_ROWS: readonly MeRow[] = [
  ROW("orders", "/orders"),
  ROW("wallet", "/wallet"),
  ROW("budget", "/budget"),
  ROW("wishlists", "/wishlists"),
  ROW("sizeProfile", "/size-profile"),
  ROW("addresses", "/addresses"),
  ROW("plus", "/plus", "me.rows.plusHint"),
  ROW("autoBuy", "/auto-buy"),
  ROW("rewards", "/rewards"),
  ROW("giftCards", "/gift-cards"),
  ROW("outfitCalendar", "/outfit-calendar"),
  ROW("wardrobe", "/wardrobe"),
  ROW("stylist", "/stylist"),
  ROW("privacy", "/privacy-center"),
  ROW("help", "/help"),
  ROW("settings", "/settings"),
];

/**
 * Rows the Me menu shows. Gift cards follow the kill-switch capabilities: unknown (still loading or
 * failed to load) or both off hides the row, the same rule the Gift Cards screen applies.
 */
export function visibleMeRows(gift: GiftCapabilities | null): readonly MeRow[] {
  const vis = giftVisibility(gift);
  return ALL_ROWS.filter((r) => r.id !== "giftCards" || vis.visible);
}

/** Taps from the Me tab to the Cancel Plus control: open the Plus row, then Cancel. Spec: at most 2. */
export const PLUS_CANCEL_TAPS_FROM_ME = 2;

/** Rows split into their hairline-separated groups; empty groups are dropped. */
export function groupedMeRows(gift: GiftCapabilities | null): readonly (readonly MeRow[])[] {
  const rows = visibleMeRows(gift);
  return ([0, 1, 2] as const).map((g) => rows.filter((r) => r.group === g)).filter((g) => g.length > 0);
}
