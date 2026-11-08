import { formatMoney, type Locale } from "@outlet/i18n";
import { sub, type Money } from "@outlet/money";
import { floorPercent } from "./percent.js";
import { useI18n } from "./i18n-context.js";
import s from "./FreeDeliveryProgress.module.css";

export interface FreeDeliveryProgressProps {
  /** Merchandise subtotal for this store after item discounts, before vouchers (bag rule). */
  readonly subtotal: Money;
  readonly threshold: Money;
  readonly storeName: string;
  /** Plus members get free delivery with no minimum. */
  readonly isPlus?: boolean;
  readonly locale?: Locale;
}

export function FreeDeliveryProgress({ subtotal, threshold, storeName, isPlus = false, locale }: FreeDeliveryProgressProps) {
  const { t, locale: l, numerals } = useI18n(locale);
  const opts = numerals ? { numerals } : {};
  const unlocked = isPlus || threshold.amountMinor <= 0n || subtotal.amountMinor >= threshold.amountMinor;
  const percent = unlocked ? 100 : floorPercent(subtotal.amountMinor, threshold.amountMinor);
  const text = isPlus
    ? t("delivery.plusFree")
    : unlocked
      ? t("delivery.unlocked", { store: storeName })
      : t("delivery.addMore", { amount: formatMoney(sub(threshold, subtotal), l, opts), store: storeName });
  return (
    <div className={s.wrap}>
      <div
        role="progressbar"
        aria-label={t("delivery.progress", { store: storeName })}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.max(0, percent)}
        aria-valuetext={text}
        className={s.track}
      >
        {/* A native <progress> keeps the fill width out of inline styles (strict CSP: no style attributes). */}
        <progress className={s.fill} max={100} value={Math.max(0, percent)} data-unlocked={unlocked} aria-hidden="true" />
      </div>
      <p className={s.text}>{text}</p>
    </div>
  );
}
