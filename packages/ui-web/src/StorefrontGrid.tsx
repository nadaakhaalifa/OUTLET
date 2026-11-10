"use client";
import type { Locale } from "@outlet/i18n";
import { useI18n } from "./i18n-context.js";
import { StoreCarousel } from "./StoreCarousel.js";
import { StorefrontCard3D, type StorefrontCard3DProps } from "./StorefrontCard3D.js";
import s from "./Village.module.css";

export type StorefrontItem = Omit<StorefrontCard3DProps, "locale" | "priority"> & { readonly key: string };

export interface StorefrontGridProps {
  readonly stores: readonly StorefrontItem[];
  /** Rows of the grid; the reference design uses 3 rows of 6. */
  readonly rows?: number;
  readonly locale?: Locale;
}

/** Splits stores over `rows` carousels, each row sliding on its own. A row holds at least 6, more when there are more stores. */
export function StorefrontGrid({ stores, rows = 3, locale }: StorefrontGridProps) {
  const { t } = useI18n(locale);
  const perRow = Math.max(6, Math.ceil(stores.length / rows));
  const chunks = Array.from({ length: rows }, (_, r) => stores.slice(r * perRow, (r + 1) * perRow)).filter((c) => c.length > 0);
  return (
    <div className={s.grid}>
      {chunks.map((chunk, r) => (
        <StoreCarousel key={r} label={t("village.rowLabel", { row: r + 1 })} {...(locale ? { locale } : {})}>
          {chunk.map(({ key, ...card }) => (
            <StorefrontCard3D key={key} {...card} {...(locale ? { locale } : {})} />
          ))}
        </StoreCarousel>
      ))}
    </div>
  );
}
