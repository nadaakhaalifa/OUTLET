"use client";
import type { Locale } from "@outlet/i18n";
import { DiscountBandLabel } from "./DiscountBandLabel.js";
import { useI18n } from "./i18n-context.js";
import { ShelfRow, type CubbyItem } from "./ShelfWall.js";
import s from "./Village.module.css";

export interface DiscountBandShelfProps {
  /** The band is rendered ONLY when `verified` is true and the numbers come from Price Watch evidence. */
  readonly band?: { readonly highPercent: number; readonly lowPercent: number; readonly verified: boolean };
  readonly items: readonly CubbyItem[];
  readonly locale?: Locale;
}

export function DiscountBandShelf({ band, items, locale }: DiscountBandShelfProps) {
  const { t } = useI18n(locale);
  const label = t("deals.plainShelf");
  return (
    <section className={s.bandSection} aria-label={band?.verified === true ? t("shelf.band", { high: band.highPercent, low: band.lowPercent }) : label}>
      <div className={s.bandHead}>
        {band?.verified === true ? (
          <>
            <DiscountBandLabel highPercent={band.highPercent} lowPercent={band.lowPercent} verified {...(locale ? { locale } : {})} />
            <p className={s.muted}>{t("shelf.bandHint")}</p>
          </>
        ) : (
          <h2 className={s.bandTitle}>{label}</h2>
        )}
      </div>
      {items.length > 0 ? <ShelfRow items={items} label={label} {...(locale ? { locale } : {})} /> : <p className={s.muted}>{t("deals.bandEmpty")}</p>}
    </section>
  );
}
