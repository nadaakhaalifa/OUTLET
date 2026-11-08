import { splitInclusive } from "./vat.js";
import type { Money } from "@outlet/money";
import type { TaxCategoryCode, TaxRateProviderPort } from "./rates.js";

export interface TaxSnapshot {
  readonly categoryCode: TaxCategoryCode;
  readonly bps: number;
  readonly rateValidFrom: Date;
  /** VAT of the line's taxable base (order_lines.vat_minor); present when the caller passed `base`. */
  readonly vat?: Money;
}

/**
 * `base` is the VAT-inclusive taxable base of the line (gross minus the discounts that reduce the base, see allocateVatWithLineDiscounts).
 * When given, vat is computed with the single rounding point (splitInclusive) so the full order_lines tax column set is returned.
 */
export function taxSnapshotForLine(
  line: { readonly marketId: string; readonly taxCategory: TaxCategoryCode; readonly base?: Money },
  at: Date,
  provider: TaxRateProviderPort,
): TaxSnapshot {
  const r = provider.rateAt(line.marketId, line.taxCategory, at);
  const snap = { categoryCode: r.category, bps: r.bps, rateValidFrom: r.validFrom };
  return line.base === undefined ? snap : { ...snap, vat: splitInclusive(line.base, r.bps).vat };
}

/** docs/data-model.md order_lines: tax_category (text), vat_rate_bp (int), vat_minor (bigint, when a base was given). rateValidFrom has no column (evidence only). */
export const toOrderLineTaxColumns = (s: TaxSnapshot): { tax_category: string; vat_rate_bp: number; vat_minor?: bigint } => ({
  tax_category: s.categoryCode,
  vat_rate_bp: s.bps,
  ...(s.vat === undefined ? {} : { vat_minor: s.vat.amountMinor }),
});

