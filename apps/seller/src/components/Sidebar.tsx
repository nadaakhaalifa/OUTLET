import Link from "next/link";
import type { MessageKey, Translator } from "@outlet/i18n";

interface Item {
  readonly key: MessageKey;
  readonly href: string | null;
  readonly id: string;
}

const ITEMS: readonly Item[] = [
  { id: "overview", key: "seller.nav.overview", href: "" },
  { id: "products", key: "seller.nav.products", href: "/products" },
  { id: "offers", key: "seller.nav.offers", href: null },
  { id: "orders", key: "seller.nav.orders", href: "/orders" },
  { id: "inventory", key: "seller.nav.inventory", href: "/inventory" },
  { id: "design", key: "seller.nav.storeDesign", href: null },
  { id: "settings", key: "seller.nav.settings", href: null },
];

/** Seller Center sidebar. Sections that are not built yet are shown but not linked (no dead links, no fake badges). */
export function Sidebar({ t, base, current }: { t: Translator; base: string; current: string }) {
  return (
    <nav className="sidebar" aria-label={t("seller.nav.label")}>
      <ul>
        {ITEMS.map((item) => (
          <li key={item.id}>
            {item.href === null ? (
              <span className="navItem navSoon" aria-disabled="true">
                {t(item.key)} <span className="soon">({t("seller.nav.soon")})</span>
              </span>
            ) : (
              <Link className="navItem" href={`${base}${item.href}`} {...(current === item.id ? { "aria-current": "page" as const } : {})}>
                {t(item.key)}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}
