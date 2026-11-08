import { formatMoney, type Locale } from "@outlet/i18n";
import type { Money } from "@outlet/money";
import { useI18n } from "./i18n-context.js";
import { Skeleton } from "./Skeleton.js";
import { VisuallyHidden } from "./VisuallyHidden.js";
import s from "./PriceBlock.module.css";

/**
 * Evidence from the Price Integrity Engine (master prompt section 9). It is the ONLY way to get a % off or a
 * strike-through onto the screen: the component has no percentage or reference-price prop of its own.
 * `evidenceIds` must be non-empty and `claimAllowed` is the literal `true` the engine returns for a verified claim.
 */
export interface VerifiedEvidence {
  readonly claimAllowed: true;
  readonly reference: Money;
  readonly evidenceIds: readonly [string, ...string[]];
  readonly lowestIn30Days?: boolean;
}

/** Without evidence the price is plain, or labelled "Launch price" / "Great price". Never a percentage. */
export type PriceInput =
  | { readonly price: Money; readonly verified: VerifiedEvidence; readonly priceKind?: undefined }
  | { readonly price: Money; readonly verified?: undefined; readonly priceKind?: "plain" | "launch" | "great" };

export type PriceBlockProps = PriceInput & { readonly locale?: Locale; readonly loading?: boolean };

/** Minimum verified discount that may be shown (VRP rule: claim_allowed needs >= 5). */
export const MIN_CLAIM_PERCENT = 5n;

/** floor((reference - price) * 100 / reference) on piastres, or null when no honest claim can be made. */
export function verifiedPercent(price: Money, evidence: VerifiedEvidence): number | null {
  const ref = evidence.reference;
  if (evidence.claimAllowed !== true || evidence.evidenceIds.length === 0) return null;
  if (ref.currency !== price.currency || ref.amountMinor <= 0n || price.amountMinor < 0n || price.amountMinor >= ref.amountMinor) return null;
  const pct = ((ref.amountMinor - price.amountMinor) * 100n) / ref.amountMinor;
  return pct >= MIN_CLAIM_PERCENT ? Number(pct) : null;
}

export function PriceBlock(props: PriceBlockProps) {
  const { t, locale, numerals } = useI18n(props.locale);
  if (props.loading) return <Skeleton inlineSize="8rem" blockSize="1.5rem" locale={locale} />;

  const opts = numerals ? { numerals } : {};
  const { price } = props;
  const percent = props.verified ? verifiedPercent(price, props.verified) : null;
  const priceText = formatMoney(price, locale, opts);

  if (props.verified && percent !== null) {
    const refText = formatMoney(props.verified.reference, locale, opts);
    return (
      <div className={s["block"]} data-verified="true">
        <span className={s["price"]}>
          <VisuallyHidden>{t("price.current")} </VisuallyHidden>
          {priceText}
        </span>
        <del className={s["reference"]}>
          <VisuallyHidden>{t("price.reference")} </VisuallyHidden>
          {refText}
        </del>
        <span className={s["pill"]}>{t("price.percentOff", { percent })}</span>
        <span className={s["badge"]}>{t("price.verifiedDiscount")}</span>
        {props.verified.lowestIn30Days === true ? <span className={s["badge"]}>{t("price.lowest30d", { days: 30 })}</span> : null}
      </div>
    );
  }

  const kind = props.verified ? "plain" : (props.priceKind ?? "plain");
  return (
    <div className={s["block"]} data-verified="false">
      <span className={s["price"]}>
        <VisuallyHidden>{t("price.current")} </VisuallyHidden>
        {priceText}
      </span>
      {kind === "launch" ? <span className={s["label"]}>{t("price.launchPrice")}</span> : null}
      {kind === "great" ? <span className={s["label"]}>{t("price.greatPrice")}</span> : null}
    </div>
  );
}
