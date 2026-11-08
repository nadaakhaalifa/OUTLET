import { createTranslator, localeSegment, type MessageKey, type ResolvedLocale } from "@outlet/i18n";
import { HeaderTabs } from "./HeaderTabs";
import { TopNav } from "./ui";

const CHIPS: readonly (readonly [string, MessageKey])[] = [
  ["all", "category.all"],
  ["fashion", "category.fashion"],
  ["electronics", "category.electronics"],
  ["home", "category.home"],
  ["pantry", "category.pantry"],
];

/** Header from the UI reference spec: logo, search, category chips, Account, Bag, tabs. No bag count: there is no cart yet. */
export function SiteHeader({ resolved }: { resolved: ResolvedLocale }) {
  const t = createTranslator(resolved.locale);
  const base = `/${localeSegment(resolved.marketId, resolved.locale)}`;
  return (
    <TopNav
      homeHref={base}
      searchAction={base}
      accountHref={`${base}/account`}
      bagHref={`${base}/bag`}
      locale={resolved.locale}
      tabs={<HeaderTabs base={base} locale={resolved.locale} />}
      chips={CHIPS.map(([id, key]) => ({ id, label: t(key), href: id === "all" ? base : `${base}?category=${id}`, current: id === "all" }))}
    />
  );
}
