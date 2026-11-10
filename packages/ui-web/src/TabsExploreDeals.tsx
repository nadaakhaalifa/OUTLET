"use client";
import type { Locale } from "@outlet/i18n";
import { useI18n } from "./i18n-context.js";
import s from "./Village.module.css";

export interface TabsExploreDealsProps {
  readonly active: "explore" | "deals" | "none";
  readonly exploreHref: string;
  readonly dealsHref: string;
  readonly locale?: Locale;
}

export function TabsExploreDeals({ active, exploreHref, dealsHref, locale }: TabsExploreDealsProps) {
  const { t } = useI18n(locale);
  return (
    <nav aria-label={t("tabs.label")}>
      <ul className={s.tabs}>
        <li>
          <a className={s.tab} href={exploreHref} {...(active === "explore" ? { "aria-current": "page" as const } : {})}>
            {t("nav.explore")}
          </a>
        </li>
        <li>
          <a className={s.tab} href={dealsHref} {...(active === "deals" ? { "aria-current": "page" as const } : {})}>
            {t("nav.deals")}
          </a>
        </li>
      </ul>
    </nav>
  );
}
