"use client";
import type { Locale } from "@outlet/i18n";
import { useI18n } from "./i18n-context.js";
import { Picture, type ArtImage } from "./Picture.js";
import p from "./ProductCard.module.css";
import s from "./Village.module.css";

export interface StorefrontCard3DProps {
  /** The brand name shown on the sign. */
  readonly storeName: string;
  readonly category: string;
  readonly href: string;
  /** Uploaded storefront art. When absent a CSS facade PLACEHOLDER is drawn (no 3D render pipeline exists yet). */
  readonly image?: ArtImage;
  /** LCP image of the page: eager and high priority. */
  readonly priority?: boolean;
  readonly locale?: Locale;
}

/** Storefront illustration with sign; lime glow on hover and focus. */
export function StorefrontCard3D({ storeName, category, href, image, priority, locale }: StorefrontCard3DProps) {
  const { t } = useI18n(locale);
  return (
    <a href={href} className={p.storefront} aria-label={t("storefront.open", { store: storeName, category })}>
      {image ? (
        <Picture image={{ ...image, alt: image.alt || storeName }} className={s.art} {...(priority ? { priority } : {})} fallbackSize={{ width: 448, height: 320 }} />
      ) : (
        // PLACEHOLDER facade: token-styled CSS only, not store content.
        <span className={s.facade} aria-hidden="true">
          <span className={s.facadeSign}>{storeName}</span>
        </span>
      )}
      <span className={p.sign}>{storeName}</span>
      <span className={p.muted}>{category}</span>
    </a>
  );
}
