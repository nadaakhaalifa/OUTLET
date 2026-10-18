import type { SellerPermissionKey, SellerPermissions } from "../api/schemas-access";
import type { MessageKey } from "../i18n";
import type { Access } from "./access";

export interface NavItem {
  readonly href: string;
  readonly labelKey: MessageKey;
}

/**
 * Every item is keyed on the permission its route already requires (docs/specs/dashboard-foundations.md
 * section 2). Role names never appear: the server vocabulary (warehouse, support) and the old web one
 * (fulfilment) both reduce to the permissions the policy engine evaluated.
 * Where a page's API gate is a sibling of the listed one the sibling is used and noted here:
 * drops, insights, media, forecasts, channels, price-trust gate on store_product.read; hub on store_order.read.
 */
const ALL: readonly (NavItem & { readonly needs: SellerPermissionKey })[] = [
  { href: "/dashboard", labelKey: "nav.dashboard", needs: "analytics.read" },
  { href: "/catalog", labelKey: "nav.catalog", needs: "store_product.read" },
  { href: "/orders", labelKey: "nav.orders", needs: "store_order.read" },
  { href: "/returns", labelKey: "nav.returns", needs: "store_return.read" },
  { href: "/finance", labelKey: "nav.finance", needs: "store_payout.read" },
  { href: "/marketing", labelKey: "nav.marketing", needs: "store_settings.read" },
  { href: "/ads", labelKey: "nav.ads", needs: "store_settings.read" },
  { href: "/drops", labelKey: "nav.drops", needs: "store_product.read" },
  { href: "/resale", labelKey: "nav.resale", needs: "store_settings.read" },
  { href: "/insights", labelKey: "nav.insights", needs: "store_product.read" },
  { href: "/media", labelKey: "nav.media", needs: "store_product.read" },
  { href: "/forecasts", labelKey: "nav.forecasts", needs: "store_product.read" },
  { href: "/channels", labelKey: "nav.channels", needs: "store_product.read" },
  { href: "/hub", labelKey: "nav.hub", needs: "store_order.read" },
  { href: "/price-trust", labelKey: "nav.priceTrust", needs: "store_product.read" },
  { href: "/team", labelKey: "nav.team", needs: "store_settings.read" },
  { href: "/settings", labelKey: "nav.settings", needs: "store_settings.read" },
];

const strip = ({ href, labelKey }: NavItem): NavItem => ({ href, labelKey });

/**
 * Navigation from server permissions. `null` means "not enforced" (flag blocked): every link, and the
 * routes still answer 403 or 404. Hiding a link is a convenience, never the control.
 */
export function navFor(permissions: SellerPermissions | null): readonly NavItem[] {
  return ALL.filter((i) => permissions === null || permissions[i.needs]).map(strip);
}

/** Navigation for a resolved access state. Fails closed: when `me` is unavailable only the dashboard shows. */
export function navForAccess(access: Access): readonly NavItem[] {
  switch (access.kind) {
    case "open":
      return navFor(null);
    case "granted":
      return navFor(access.permissions);
    case "unavailable":
      return ALL.filter((i) => i.href === "/dashboard").map(strip);
    case "no_access":
      return [];
  }
}
