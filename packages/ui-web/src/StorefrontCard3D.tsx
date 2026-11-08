import type { Locale } from "@outlet/i18n";
import { useI18n } from "./i18n-context.js";
import s from "./ProductCard.module.css";

export interface StorefrontCard3DProps {
  readonly storeName: string;
  readonly category: string;
  readonly href: string;
  readonly image: { readonly src: string; readonly alt: string };
  readonly locale?: Locale;
}

/** Storefront illustration with sign; lime glow on hover and focus. */
export function StorefrontCard3D({ storeName, category, href, image, locale }: StorefrontCard3DProps) {
  const { t } = useI18n(locale);
  return (
    <a href={href} className={s["storefront"]} aria-label={t("storefront.open", { store: storeName, category })}>
      <img src={image.src} alt={image.alt || storeName} loading="lazy" className={s["image"]} />
      <span className={s["sign"]}>{storeName}</span>
      <span className={s["muted"]}>{category}</span>
    </a>
  );
}
