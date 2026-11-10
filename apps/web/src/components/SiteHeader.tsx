import { createTranslator, localeSegment, type ResolvedLocale } from "@outlet/i18n";
import type { CategoryNode } from "../server/api-client";
import { HeaderTabs } from "./HeaderTabs";
import { TopNav } from "./ui";

/** Header from the UI reference spec: logo, search, category chips (from the categories API), Account, Bag, tabs. No bag count: there is no cart yet. */
export function SiteHeader({ resolved, roots }: { resolved: ResolvedLocale; roots: readonly CategoryNode[] }) {
  const t = createTranslator(resolved.locale);
  const base = `/${localeSegment(resolved.marketId, resolved.locale)}`;
  const en = resolved.locale.startsWith("en");
  const chips = [
    { id: "all", label: t("category.all"), href: `${base}/stores`, current: false },
    ...roots.map((c) => ({ id: c.id, label: en && c.nameEn ? c.nameEn : c.nameAr, href: `${base}/stores?category=${c.id}`, current: false })),
  ];
  return (
    <TopNav
      homeHref={base}
      searchAction={base}
      accountHref={`${base}/account`}
      bagHref={`${base}/bag`}
      locale={resolved.locale}
      tabs={<HeaderTabs base={base} locale={resolved.locale} />}
      chips={chips}
    />
  );
}
