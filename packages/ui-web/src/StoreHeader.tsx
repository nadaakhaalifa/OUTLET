"use client";
import type { Locale } from "@outlet/i18n";
import { useI18n } from "./i18n-context.js";
import { Picture, type ArtImage } from "./Picture.js";
import s from "./Village.module.css";

export interface StoreHeaderProps {
  readonly name: string;
  readonly tagline?: string;
  readonly logo?: ArtImage;
  readonly verified?: boolean;
  /** Real follower count from the API; omitted = not shown. */
  readonly followers?: number;
  /** Where "Follow store" leads (sign-in until follow exists). */
  readonly followHref: string;
  readonly locale?: Locale;
}

export function StoreHeader({ name, tagline, logo, verified, followers, followHref, locale }: StoreHeaderProps) {
  const { t } = useI18n(locale);
  return (
    <div className={s.header}>
      {logo ? <Picture image={logo} className={s.logo} fallbackSize={{ width: 64, height: 64 }} /> : <span className={s.logo} aria-hidden="true">{name.slice(0, 1)}</span>}
      <div className={s.headerText}>
        <h1 className={s.title}>{name}</h1>
        {tagline ? <p className={s.muted}>{tagline}</p> : null}
        <p className={s.muted}>
          {verified === true ? t("store.verifiedSeller") : null}
          {verified === true && followers !== undefined ? " · " : null}
          {followers !== undefined ? t("store.followers", { count: followers }) : null}
        </p>
      </div>
      <a className={s.follow} href={followHref}>
        {t("store.follow")}
      </a>
    </div>
  );
}
