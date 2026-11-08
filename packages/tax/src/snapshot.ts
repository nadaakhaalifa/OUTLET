import type { TaxCategoryCode, TaxRateProviderPort } from "./rates.js";

export interface TaxSnapshot {
  readonly categoryCode: TaxCategoryCode;
  readonly bps: number;
  readonly rateValidFrom: Date;
}

export function taxSnapshotForLine(
  line: { readonly marketId: string; readonly taxCategory: TaxCategoryCode },
  at: Date,
  provider: TaxRateProviderPort,
): TaxSnapshot {
  const r = provider.rateAt(line.marketId, line.taxCategory, at);
  return { categoryCode: r.category, bps: r.bps, rateValidFrom: r.validFrom };
}

/** docs/data-model.md order_lines: tax_category (text), vat_rate_bp (int), vat_minor (bigint). rateValidFrom has no column (evidence only). */
export const toOrderLineTaxColumns = (s: TaxSnapshot): { tax_category: string; vat_rate_bp: number } => ({
  tax_category: s.categoryCode,
  vat_rate_bp: s.bps,
});
