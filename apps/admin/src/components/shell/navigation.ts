import { localeSegment, type Locale, type MessageKey } from "@outlet/i18n";
import type { SectionId } from "../../server/session";
import type { IconName } from "../kit/Icon";

export type NavId = "overview" | SectionId;

export interface NavEntry {
  readonly id: NavId;
  readonly key: MessageKey;
  /** Path under the market-locale segment ("" is the overview). */
  readonly path: string;
  readonly icon: IconName;
}

export interface NavGroup {
  readonly id: string;
  readonly key: MessageKey;
  readonly icon: IconName;
  readonly items: readonly NavEntry[];
}

const OVERVIEW: NavEntry = { id: "overview", key: "admin.nav.overview", path: "", icon: "overview" };

/** Every console route, grouped. A group with no item the session may open is not rendered. */
export const NAV_GROUPS: readonly NavGroup[] = [
  { id: "overview", key: "admin.nav.group.overview", icon: "overview", items: [OVERVIEW] },
  { id: "sellers", key: "admin.nav.group.sellers", icon: "sellers", items: [{ id: "kyc", key: "admin.nav.kyc", path: "/kyc", icon: "sellers" }] },
  // Orders and returns: no console page exists yet, so no item (the group stays hidden until one is added).
  { id: "orders", key: "admin.nav.group.orders", icon: "orders", items: [] },
  { id: "money", key: "admin.nav.group.money", icon: "money", items: [{ id: "recon", key: "admin.nav.recon", path: "/reconciliation", icon: "money" }] },
  { id: "catalog", key: "admin.nav.group.catalog", icon: "catalog", items: [{ id: "price", key: "admin.nav.price", path: "/price-integrity", icon: "catalog" }] },
  {
    id: "trust",
    key: "admin.nav.group.trust",
    icon: "trust",
    items: [
      { id: "dpo", key: "admin.nav.dpo", path: "/privacy", icon: "trust" },
      { id: "audit", key: "admin.nav.audit", path: "/audit", icon: "trust" },
    ],
  },
  { id: "platform", key: "admin.nav.group.platform", icon: "overview", items: [
      { id: "attention", key: "admin.nav.attention", path: "/attention", icon: "alert" },
      { id: "dlq", key: "admin.nav.dlq", path: "/dlq", icon: "alert" },
    ],
  },
  { id: "access", key: "admin.nav.group.access", icon: "access", items: [{ id: "access", key: "admin.nav.access", path: "/access", icon: "access" }] },
];

/** Display filter only (the API enforces authorization): overview always, the rest by the session's sections. */
export function visibleGroups(sections: readonly SectionId[]): NavGroup[] {
  return NAV_GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => i.id === "overview" || sections.includes(i.id)) })).filter((g) => g.items.length > 0);
}

/** Bottom tab bar: up to 4 of these (when visible), then the Menu button makes 5. */
const TAB_ORDER: readonly NavId[] = ["overview", "attention", "kyc", "recon", "price", "dpo", "audit", "access"];
export function tabItems(groups: readonly NavGroup[]): NavEntry[] {
  const all = groups.flatMap((g) => g.items);
  return TAB_ORDER.flatMap((id) => all.filter((i) => i.id === id)).slice(0, 4);
}

/** The same page in the other language: swaps the `[market]-[locale]` first segment, keeps the rest. */
export function switchLocaleHref(pathname: string, marketId: string, target: Locale): string {
  const rest = pathname.split("/").slice(2).join("/");
  const base = `/${localeSegment(marketId, target)}`;
  return rest === "" ? base : `${base}/${rest}`;
}
