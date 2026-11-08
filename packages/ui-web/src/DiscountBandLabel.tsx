import type { Locale } from "@outlet/i18n";
import { useI18n } from "./i18n-context.js";
import { MIN_CLAIM_PERCENT } from "./PriceBlock.js";
import s from "./ProductCard.module.css";

export interface DiscountBandLabelProps {
  /** Band bounds, computed from verified Price Watch data by the caller, never typed by a seller. */
  readonly highPercent: number;
  readonly lowPercent: number;
  /** Must be true: the band is derived from verified evidence only. */
  readonly verified: true;
  readonly locale?: Locale;
}

export function DiscountBandLabel({ highPercent, lowPercent, locale }: DiscountBandLabelProps) {
  const { t } = useI18n(locale);
  if (!Number.isInteger(highPercent) || !Number.isInteger(lowPercent) || BigInt(lowPercent) < MIN_CLAIM_PERCENT || highPercent < lowPercent) return null;
  return <span className={s["band"]}>{t("shelf.band", { high: highPercent, low: lowPercent })}</span>;
}
