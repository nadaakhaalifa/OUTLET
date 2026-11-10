"use client";
import type { ReactNode } from "react";
import type { Locale } from "@outlet/i18n";
import { CategoryChips, type ChipItem } from "./CategoryChips.js";
import { useI18n } from "./i18n-context.js";
import s from "./Village.module.css";

export interface TopNavProps {
  readonly homeHref: string;
  readonly searchAction: string;
  readonly chips: readonly ChipItem[];
  readonly accountHref: string;
  readonly bagHref: string;
  /** Real bag line count; undefined (no cart yet) shows no number. */
  readonly bagCount?: number;
  /** Slot for the tabs row (kept as a slot so the app can mark the active tab from the URL). */
  readonly tabs?: ReactNode;
  readonly locale?: Locale;
}

export function TopNav({ homeHref, searchAction, chips, accountHref, bagHref, bagCount, tabs, locale }: TopNavProps) {
  const { t } = useI18n(locale);
  return (
    <header className={s.topnav}>
      <div className={s.row}>
        <a className={s.brand} href={homeHref}>
          {t("brand.name")}
        </a>
        <form className={s.search} role="search" action={searchAction} method="get">
          <input className={s.searchInput} type="search" name="q" aria-label={t("search.label")} placeholder={t("search.placeholder")} />
        </form>
        <a className={s.navLink} href={accountHref}>
          {t("nav.account")}
        </a>
        <a className={s.navLink} href={bagHref} {...(bagCount !== undefined ? { "aria-label": t("nav.bagWithCount", { count: bagCount }) } : {})}>
          {t("nav.bag")}
        </a>
      </div>
      <div className={s.row}>
        {tabs}
        <CategoryChips items={chips} label={t("nav.categories")} />
      </div>
    </header>
  );
}
