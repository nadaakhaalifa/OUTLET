import type { MessageKey } from "../i18n";
import type { Role } from "./common";

export type NavGroupId = "overview" | "queues" | "money" | "marketing" | "platform" | "privacy";

export interface NavItem {
  readonly id: string;
  readonly href: string;
  readonly labelKey: MessageKey;
  readonly group: NavGroupId;
}

/** Sidebar sections in display order. A group with no visible item is not rendered. */
export const NAV_GROUPS: readonly { readonly id: NavGroupId; readonly labelKey: MessageKey }[] = [
  { id: "overview", labelKey: "nav.group.overview" },
  { id: "queues", labelKey: "nav.group.queues" },
  { id: "money", labelKey: "nav.group.money" },
  { id: "marketing", labelKey: "nav.group.marketing" },
  { id: "platform", labelKey: "nav.group.platform" },
  { id: "privacy", labelKey: "nav.group.privacy" },
];

const ANY: readonly Role[] = ["ops", "finance", "trust_safety", "support", "marketing", "dpo", "security", "super_admin"];

/**
 * Which roles the API allows on each area (docs/specs/admin-essentials.md, controllers). This is only used to
 * HIDE links. Hiding is a convenience: every request is re-authorised by the API, and a direct URL still
 * gets a 403/404 rendered as an error state.
 */
const ALL: readonly (NavItem & { readonly roles: readonly Role[] })[] = [
  { id: "home", href: "/", labelKey: "nav.home", group: "overview", roles: ANY },
  { id: "approvals", href: "/approvals", labelKey: "nav.approvals", group: "overview", roles: ANY },
  { id: "elevation", href: "/elevation", labelKey: "nav.elevation", group: "overview", roles: ANY },
  { id: "sellers", href: "/sellers", labelKey: "nav.sellers", group: "queues", roles: ["ops", "trust_safety", "support"] },
  { id: "brand-applications", href: "/brand-applications", labelKey: "nav.brandApplications", group: "queues", roles: ["ops", "trust_safety", "super_admin"] },
  { id: "suspensions", href: "/suspensions", labelKey: "nav.suspensions", group: "queues", roles: ["ops", "trust_safety", "security"] },
  { id: "price-integrity", href: "/price-integrity", labelKey: "nav.priceIntegrity", group: "queues", roles: ["ops", "trust_safety", "super_admin"] },
  { id: "flags", href: "/flags", labelKey: "nav.flags", group: "platform", roles: ["ops", "security", "super_admin"] },
  { id: "privacy", href: "/privacy", labelKey: "nav.privacy", group: "privacy", roles: ["dpo"] },
  { id: "tax", href: "/tax", labelKey: "nav.tax", group: "money", roles: ["finance", "ops", "super_admin"] },
  { id: "finance", href: "/finance", labelKey: "nav.finance", group: "money", roles: ["finance"] },
  { id: "returns", href: "/returns", labelKey: "nav.returns", group: "queues", roles: ["ops", "support", "trust_safety", "finance"] },
  { id: "promotions", href: "/promotions", labelKey: "nav.promotions", group: "marketing", roles: ["marketing", "ops"] },
  { id: "plus", href: "/plus", labelKey: "nav.plus", group: "money", roles: ["finance", "ops", "super_admin"] },
  { id: "gift-cards", href: "/gift-cards", labelKey: "nav.giftCards", group: "money", roles: ["finance", "ops", "trust_safety", "super_admin"] },
  { id: "rewards", href: "/rewards", labelKey: "nav.rewards", group: "marketing", roles: ["marketing", "ops", "super_admin"] },
  { id: "calendar", href: "/calendar", labelKey: "nav.calendar", group: "marketing", roles: ["marketing", "ops", "super_admin"] },
  { id: "drops", href: "/drops", labelKey: "nav.drops", group: "queues", roles: ["trust_safety", "ops", "super_admin"] },
  { id: "price-matching", href: "/price-matching", labelKey: "nav.priceMatching", group: "queues", roles: ["ops", "trust_safety", "super_admin"] },
  { id: "ads", href: "/ads", labelKey: "nav.ads", group: "marketing", roles: ["marketing", "ops", "finance", "super_admin"] },
  { id: "resale-hub", href: "/resale-hub", labelKey: "nav.resaleHub", group: "queues", roles: ["ops", "trust_safety", "super_admin"] },
  { id: "engineering", href: "/engineering", labelKey: "nav.engineering", group: "platform", roles: ["ops", "security", "super_admin"] },
  { id: "moderation", href: "/moderation", labelKey: "nav.moderation", group: "queues", roles: ["trust_safety", "ops", "super_admin"] },
  { id: "creators", href: "/creators", labelKey: "nav.creators", group: "marketing", roles: ["trust_safety", "finance", "ops", "super_admin"] },
  { id: "ranking", href: "/ranking", labelKey: "nav.ranking", group: "marketing", roles: ["ops", "super_admin"] },
  { id: "pii", href: "/pii", labelKey: "nav.pii", group: "privacy", roles: ["support", "trust_safety", "dpo"] },
];

/**
 * FAIL CLOSED: `roles === null` means the server has not told us (not_admin, 5xx, malformed): list nothing
 * privileged. Only unrecognised roles are ignored, so an unknown or empty list also lists nothing.
 */
export function navFor(roles: readonly Role[] | null): readonly NavItem[] {
  return ALL.filter((i) => roles !== null && i.roles.some((r) => roles.includes(r))).map(({ id, href, labelKey, group }) => ({ id, href, labelKey, group }));
}

export function navAllowsPath(roles: readonly Role[] | null, href: string): boolean {
  const item = ALL.find((i) => i.href === href);
  return item === undefined ? false : roles !== null && item.roles.some((r) => roles.includes(r));
}

export interface NavSection {
  readonly id: NavGroupId;
  readonly labelKey: MessageKey;
  readonly items: readonly NavItem[];
}

/** Visible items bucketed into their sections, in NAV_GROUPS order, empty sections dropped. Same fail-closed rule as navFor. */
export function navSectionsFor(roles: readonly Role[] | null): readonly NavSection[] {
  const items = navFor(roles);
  return NAV_GROUPS.map((g) => ({ id: g.id, labelKey: g.labelKey, items: items.filter((i) => i.group === g.id) })).filter((g) => g.items.length > 0);
}

/**
 * The one item to mark `aria-current`: the item whose href is the longest match for the path (`/` matches only
 * itself), so a more specific link beats a parent. Returns null when nothing matches.
 */
export function activeNavId(items: readonly Pick<NavItem, "id" | "href">[], path: string): string | null {
  let best: { id: string; len: number } | null = null;
  for (const i of items) {
    const hit = i.href === "/" ? path === "/" : path === i.href || path.startsWith(`${i.href}/`);
    if (hit && (best === null || i.href.length > best.len)) best = { id: i.id, len: i.href.length };
  }
  return best === null ? null : best.id;
}

export interface Breadcrumb {
  readonly groupKey: MessageKey;
  readonly itemKey: MessageKey;
}

/** "Group / Item" for the active nav item, or null when the page is not in the nav (then no breadcrumb is drawn). */
export function breadcrumbFor(sections: readonly NavSection[], path: string): Breadcrumb | null {
  const id = activeNavId(sections.flatMap((s) => s.items), path);
  if (id === null) return null;
  for (const s of sections) {
    const item = s.items.find((i) => i.id === id);
    if (item !== undefined) return { groupKey: s.labelKey, itemKey: item.labelKey };
  }
  return null;
}

export interface RoleChip {
  readonly first: string;
  readonly more: number;
  readonly all: readonly string[];
}

/** "<first role> +N" chip data. null when there are no roles (the caller prints the "no role" text instead). */
export function roleChip(labels: readonly string[]): RoleChip | null {
  const [first] = labels;
  return first === undefined ? null : { first, more: labels.length - 1, all: labels };
}

/**
 * "Synthetic data" environment badge. The console has no prod/staging signal, so the only honest one is its own
 * configuration: an API base URL on loopback means a local dev stack on synthetic fixtures.
 */
export function isSyntheticEnvironment(apiBaseUrl: string | null): boolean {
  if (apiBaseUrl === null) return false;
  try {
    const h = new URL(apiBaseUrl).hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "[::1]";
  } catch {
    return false;
  }
}
