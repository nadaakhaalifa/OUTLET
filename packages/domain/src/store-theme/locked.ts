// Platform-locked elements contract (ADR-0057 decision 2, spec 4.2). These never read store tokens.

import type { ThemeDocument } from "./types";

export const LOCKED_ELEMENTS = [
  "price_block",
  "discount_label",
  "verified_badge",
  "reference_label",
  "sponsored_label",
  "plus_badge",
  "stock_line",
  "rating",
  "size_recommendation",
  "seller_legal_identity",
  "commerce_buttons",
  "bag",
  "checkout",
] as const;
export type LockedElementId = (typeof LOCKED_ELEMENTS)[number];

/** Surfaces a theme can never touch (spec 4.1). */
export const NEVER_THEMED_SURFACES = [
  "shop_everything",
  "search_results",
  "buy_box",
  "home_feeds",
  "bag",
  "checkout",
  "orders",
  "returns",
  "payments",
  "account",
  "notifications",
] as const;

export interface LockedElementTokens {
  readonly source: "platform";
  /** Locked elements keep their own radius, font and colours from the platform token set. */
  readonly radius: "platform";
  readonly font: "platform";
  readonly colours: "platform";
  readonly opacity: 1;
  readonly visible: true;
}

const PLATFORM_LOCKED: LockedElementTokens = Object.freeze({
  source: "platform",
  radius: "platform",
  font: "platform",
  colours: "platform",
  opacity: 1,
  visible: true,
});

export function isLockedElement(id: string): id is LockedElementId {
  return (LOCKED_ELEMENTS as readonly string[]).includes(id);
}

/**
 * Tokens for a locked element. Deliberately ignores the theme: the parameter exists so callers and
 * contract tests prove no theme input changes the result.
 */
export function lockedElementTokens(
  _element: LockedElementId,
  _theme: ThemeDocument | null,
): LockedElementTokens {
  return PLATFORM_LOCKED;
}
