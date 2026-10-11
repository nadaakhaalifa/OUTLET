import type { TeamRole } from "../api/schemas";
import type { MessageKey } from "../i18n";

export interface NavItem {
  readonly href: string;
  readonly labelKey: MessageKey;
}

const ALL: readonly (NavItem & { readonly roles: readonly TeamRole[] })[] = [
  { href: "/dashboard", labelKey: "nav.dashboard", roles: ["owner", "manager", "fulfilment", "catalog", "finance"] },
  { href: "/catalog", labelKey: "nav.catalog", roles: ["owner", "manager", "catalog"] },
  { href: "/orders", labelKey: "nav.orders", roles: ["owner", "manager", "fulfilment"] },
  { href: "/returns", labelKey: "nav.returns", roles: ["owner", "manager", "fulfilment"] },
  { href: "/finance", labelKey: "nav.finance", roles: ["owner", "manager", "finance"] },
  { href: "/marketing", labelKey: "nav.marketing", roles: ["owner", "manager"] },
  { href: "/ads", labelKey: "nav.ads", roles: ["owner", "manager"] },
  { href: "/drops", labelKey: "nav.drops", roles: ["owner", "manager", "catalog"] },
  { href: "/resale", labelKey: "nav.resale", roles: ["owner", "manager"] },
  { href: "/insights", labelKey: "nav.insights", roles: ["owner", "manager", "catalog"] },
  { href: "/channels", labelKey: "nav.channels", roles: ["owner", "manager", "catalog"] },
  { href: "/hub", labelKey: "nav.hub", roles: ["owner", "manager", "fulfilment"] },
  { href: "/price-trust", labelKey: "nav.priceTrust", roles: ["owner", "manager", "catalog"] },
  { href: "/team", labelKey: "nav.team", roles: ["owner", "manager"] },
  { href: "/settings", labelKey: "nav.settings", roles: ["owner", "manager"] },
];

/** Navigation filtered by role. Hiding a link is a convenience; routes still enforce through API 403/404. */
export function navFor(role: TeamRole | null): readonly NavItem[] {
  return ALL.filter((i) => role === null || i.roles.includes(role)).map(({ href, labelKey }) => ({ href, labelKey }));
}
