import type { MessageKey } from "../i18n";
import type { Role } from "./common";

export interface NavItem {
  readonly id: string;
  readonly href: string;
  readonly labelKey: MessageKey;
}

const ANY: readonly Role[] = ["ops", "finance", "trust_safety", "support", "marketing", "dpo", "security", "super_admin"];

/**
 * Which roles the API allows on each area (docs/specs/admin-essentials.md, controllers). This is only used to
 * HIDE links. Hiding is a convenience: every request is re-authorised by the API, and a direct URL still
 * gets a 403/404 rendered as an error state.
 */
const ALL: readonly (NavItem & { readonly roles: readonly Role[] })[] = [
  { id: "home", href: "/", labelKey: "nav.home", roles: ANY },
  { id: "approvals", href: "/approvals", labelKey: "nav.approvals", roles: ANY },
  { id: "elevation", href: "/elevation", labelKey: "nav.elevation", roles: ANY },
  { id: "sellers", href: "/sellers", labelKey: "nav.sellers", roles: ["ops", "trust_safety", "support"] },
  { id: "suspensions", href: "/suspensions", labelKey: "nav.suspensions", roles: ["ops", "trust_safety", "security"] },
  { id: "price-integrity", href: "/price-integrity", labelKey: "nav.priceIntegrity", roles: ["ops", "trust_safety", "super_admin"] },
  { id: "flags", href: "/flags", labelKey: "nav.flags", roles: ["ops", "security", "super_admin"] },
  { id: "privacy", href: "/privacy", labelKey: "nav.privacy", roles: ["dpo"] },
  { id: "tax", href: "/tax", labelKey: "nav.tax", roles: ["finance", "ops", "super_admin"] },
  { id: "finance", href: "/finance", labelKey: "nav.finance", roles: ["finance"] },
  { id: "returns", href: "/returns", labelKey: "nav.returns", roles: ["ops", "support", "trust_safety", "finance"] },
  { id: "promotions", href: "/promotions", labelKey: "nav.promotions", roles: ["marketing", "ops"] },
  { id: "plus", href: "/plus", labelKey: "nav.plus", roles: ["finance", "ops", "super_admin"] },
  { id: "gift-cards", href: "/gift-cards", labelKey: "nav.giftCards", roles: ["finance", "ops", "trust_safety", "super_admin"] },
  { id: "rewards", href: "/rewards", labelKey: "nav.rewards", roles: ["marketing", "ops", "super_admin"] },
  { id: "calendar", href: "/calendar", labelKey: "nav.calendar", roles: ["marketing", "ops", "super_admin"] },
  { id: "drops", href: "/drops", labelKey: "nav.drops", roles: ["trust_safety", "ops", "super_admin"] },
  { id: "price-matching", href: "/price-matching", labelKey: "nav.priceMatching", roles: ["ops", "trust_safety", "super_admin"] },
  { id: "ads", href: "/ads", labelKey: "nav.ads", roles: ["marketing", "ops", "finance", "super_admin"] },
  { id: "resale-hub", href: "/resale-hub", labelKey: "nav.resaleHub", roles: ["ops", "trust_safety", "super_admin"] },
  { id: "engineering", href: "/engineering", labelKey: "nav.engineering", roles: ["ops", "security", "super_admin"] },
  { id: "moderation", href: "/moderation", labelKey: "nav.moderation", roles: ["trust_safety", "ops", "super_admin"] },
  { id: "pii", href: "/pii", labelKey: "nav.pii", roles: ["support", "trust_safety", "dpo"] },
];

/**
 * `roles === null` means the server has not told us (no /v1/admin/me): show everything and let the API decide.
 * An EMPTY role list shows only the always-visible items.
 */
export function navFor(roles: readonly Role[] | null): readonly NavItem[] {
  return ALL.filter((i) => roles === null || i.roles.some((r) => roles.includes(r))).map(({ id, href, labelKey }) => ({ id, href, labelKey }));
}

export function navAllowsPath(roles: readonly Role[] | null, href: string): boolean {
  const item = ALL.find((i) => i.href === href);
  return item === undefined ? false : roles === null || item.roles.some((r) => roles.includes(r));
}
