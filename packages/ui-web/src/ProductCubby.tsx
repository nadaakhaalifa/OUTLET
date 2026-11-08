import type { Locale } from "@outlet/i18n";
import { useI18n } from "./i18n-context.js";
import { PriceBlock, type PriceInput } from "./PriceBlock.js";
import s from "./ProductCard.module.css";

export interface ProductCubbyProps {
  readonly name: string;
  readonly href: string;
  readonly image: { readonly src: string; readonly alt: string };
  readonly pricing: PriceInput;
  readonly onQuickAdd?: () => void;
  readonly locale?: Locale;
}

/** Shelf tile: image, small name and price label, green quick-add. */
export function ProductCubby({ name, href, image, pricing, onQuickAdd, locale }: ProductCubbyProps) {
  const { t, locale: l } = useI18n(locale);
  return (
    <div className={s.cubby}>
      <a href={href} className={s.link}>
        <img src={image.src} alt={image.alt || name} loading="lazy" className={s.image} />
        <span className={s.name}>{name}</span>
      </a>
      <PriceBlock {...pricing} locale={l} />
      {onQuickAdd ? <button type="button" className={s.add} aria-label={t("cubby.quickAdd", { name })} onClick={onQuickAdd}>+</button> : null}
    </div>
  );
}
