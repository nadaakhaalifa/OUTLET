import { createTranslator, type Locale } from "../i18n";
import { formatMoney, formatPct } from "../lib/format";
import type { PriceView } from "../view-models/price";

/** Current price, plus a reference price and percent ONLY when priceView() granted a verified claim. */
export function Price({ view, locale, large = false }: { view: PriceView; locale: Locale; large?: boolean }) {
  const t = createTranslator(locale);
  return (
    <p className={large ? "price price-lg" : "price"}>
      <span>{formatMoney(view.amount, locale)}</span>
      {view.claim !== null ? (
        <>
          {" "}
          <del className="was" aria-label={t("product.referenceLabel")}>{formatMoney(view.claim.reference, locale)}</del>
        </>
      ) : null}
    </p>
  );
}

export function PriceBadge({ view, locale }: { view: PriceView; locale: Locale }) {
  const t = createTranslator(locale);
  if (view.badge === "verified_discount" && view.claim !== null) {
    return <span className="pill savings">{t("product.badge.verified_discount", { pct: formatPct(view.claim.pct, locale) })}</span>;
  }
  if (view.badge === "lowest_30d") return <span className="pill">{t("product.badge.lowest_30d")}</span>;
  if (view.badge === "launch_price") return <span className="pill">{t("product.badge.launch_price")}</span>;
  return null;
}
