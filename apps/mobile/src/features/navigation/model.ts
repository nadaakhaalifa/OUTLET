/** Navigation view model (spec Part C "Tabs" and "Me"). Pure: no React, no router. */
import { giftVisibility, type GiftCapabilities } from "../gift-cards/model";

export type TabId = "home" | "explore" | "stylist" | "bag" | "me";

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
  { route: "explore", id: "explore", titleKey: "tabs.explore", testID: "tab-explore" },
  { route: "stylist", id: "stylist", titleKey: "tabs.stylist", testID: "tab-stylist" },
  { route: "bag", id: "bag", titleKey: "tabs.bag", testID: "tab-bag" },
  { route: "me", id: "me", titleKey: "tabs.me", testID: "tab-me" },
];

export type MeRowId = "orders" | "wallet" | "budget" | "wishlists" | "sizeProfile" | "plus" | "rewards" | "giftCards" | "privacy" | "help" | "settings";

export interface MeRow {
  readonly id: MeRowId;
  readonly titleKey: `me.rows.${MeRowId}`;
  readonly hintKey?: "me.rows.plusHint";
  readonly href: "/orders" | "/wallet" | "/budget" | "/wishlists" | "/size-profile" | "/plus" | "/rewards" | "/gift-cards" | "/privacy-center" | "/help" | "/settings";
  readonly testID: `me-row-${MeRowId}`;
}

const ROW = <I extends MeRowId>(id: I, href: MeRow["href"], hintKey?: "me.rows.plusHint"): MeRow => ({
  id, titleKey: `me.rows.${id}`, href, testID: `me-row-${id}`, ...(hintKey !== undefined ? { hintKey } : {}),
});

const ALL_ROWS: readonly MeRow[] = [
  ROW("orders", "/orders"),
  ROW("wallet", "/wallet"),
  ROW("budget", "/budget"),
  ROW("wishlists", "/wishlists"),
  ROW("sizeProfile", "/size-profile"),
  ROW("plus", "/plus", "me.rows.plusHint"),
  ROW("rewards", "/rewards"),
  ROW("giftCards", "/gift-cards"),
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
