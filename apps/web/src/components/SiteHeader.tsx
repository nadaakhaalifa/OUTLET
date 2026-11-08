import { createTranslator, type MessageKey, type ResolvedLocale } from "@outlet/i18n";
import { localeSegment } from "@outlet/i18n";

const CHIPS: readonly (readonly [string, MessageKey])[] = [
  ["all", "category.all"],
  ["fashion", "category.fashion"],
  ["electronics", "category.electronics"],
  ["home", "category.home"],
  ["pantry", "category.pantry"],
];

export type ActiveTab = "explore" | "deals" | "none";

/** Header from the UI reference spec: logo, search, Account, Bag, tabs and category chips. No counts: the bag is empty until real data exists. */
export function SiteHeader({ resolved, active }: { resolved: ResolvedLocale; active: ActiveTab }) {
  const t = createTranslator(resolved.locale);
  const base = `/${localeSegment(resolved.marketId, resolved.locale)}`;
  return (
    <header className="header">
      <div className="headerRow">
        <a className="brand" href={base}>
          {t("brand.name")}
        </a>
        <form className="search" role="search" action={base} method="get">
          <input type="search" name="q" aria-label={t("search.label")} placeholder={t("search.placeholder")} />
        </form>
        <a className="navLink" href={`${base}/account`}>
          {t("nav.account")}
        </a>
        <a className="navLink" href={`${base}/bag`}>
          {t("nav.bag")}
        </a>
      </div>
      <div className="headerRow">
        <nav aria-label={t("nav.primary")}>
          <ul className="tabs">
            <li>
              <a href={base} {...(active === "explore" ? { "aria-current": "page" as const } : {})}>
                {t("nav.explore")}
              </a>
            </li>
            <li>
              <a href={`${base}/deals`} {...(active === "deals" ? { "aria-current": "page" as const } : {})}>
                {t("nav.deals")}
              </a>
            </li>
          </ul>
        </nav>
        <ul className="chips">
          {CHIPS.map(([id, key]) => (
            <li key={id}>
              <a href={id === "all" ? base : `${base}?category=${id}`} aria-current={id === "all"}>
                {t(key)}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </header>
  );
}
