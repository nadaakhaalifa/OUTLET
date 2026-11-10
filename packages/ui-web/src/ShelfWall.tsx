"use client";
import type { Locale } from "@outlet/i18n";
import { useI18n } from "./i18n-context.js";
import { ProductCubby, type ProductCubbyProps } from "./ProductCubby.js";
import { StoreCarousel } from "./StoreCarousel.js";
import s from "./Village.module.css";

export type CubbyItem = Omit<ProductCubbyProps, "locale"> & { readonly key: string };

export interface ShelfRowProps {
  readonly items: readonly CubbyItem[];
  readonly label: string;
  readonly hint?: string;
  readonly locale?: Locale;
}

/** One lit shelf that slides horizontally. */
export function ShelfRow({ items, label, hint, locale }: ShelfRowProps) {
  return (
    <div className={s.shelf}>
      <StoreCarousel label={label} variant="cubby" {...(hint ? { hint } : {})} {...(locale ? { locale } : {})}>
        {items.map(({ key, ...cubby }) => (
          <ProductCubby key={key} {...cubby} {...(locale ? { locale } : {})} />
        ))}
      </StoreCarousel>
    </div>
  );
}

export interface ShelfWallProps {
  readonly items: readonly CubbyItem[];
  readonly rows?: number;
  readonly locale?: Locale;
}

/** The store wall: `rows` shelves of cubbies (3 x 6 in the reference design; more products make the rows longer). */
export function ShelfWall({ items, rows = 3, locale }: ShelfWallProps) {
  const { t } = useI18n(locale);
  const perRow = Math.max(6, Math.ceil(items.length / rows));
  const chunks = Array.from({ length: rows }, (_, r) => items.slice(r * perRow, (r + 1) * perRow)).filter((c) => c.length > 0);
  return (
    <div className={s.wall}>
      {chunks.map((chunk, r) => (
        <ShelfRow key={r} items={chunk} label={t("store.shelfLabel", { row: r + 1 })} {...(r === chunks.length - 1 ? { hint: t("store.slideHint") } : {})} {...(locale ? { locale } : {})} />
      ))}
    </div>
  );
}
