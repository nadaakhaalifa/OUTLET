import { requiredMeasures, validateChart, type ChartErrorCode, type MeasureKey } from "@outlet/domain";
import type { MessageKey } from "../i18n";

export interface ChartRowDraft {
  readonly sizeLabel: string;
  /** Raw text from inputs, keyed by measure; blank means not provided. */
  readonly values: Readonly<Record<string, string>>;
}

export interface ChartDraft {
  readonly productType: string;
  readonly unit: "cm" | "in";
  readonly rows: readonly ChartRowDraft[];
}

export interface ChartIssue {
  readonly sizeLabel: string;
  readonly messageKey: MessageKey;
  readonly code: ChartErrorCode | "not_a_number";
}

export interface ChartCheck {
  readonly valid: boolean;
  readonly issues: readonly ChartIssue[];
  /** Wire body when valid (cm or in as typed; the API normalises, the validator normalised copy was used for checks). */
  readonly body: { product_type: string; unit: "cm" | "in"; rows: { size_label: string; measurements: Record<string, number> }[] } | null;
}

const keyFor = (code: ChartErrorCode): MessageKey => `chart.err.${code}`;

/** Sorts known alpha sizes (XS..XXXL) and numeric labels ascending; others keep entry order. */
const ALPHA = ["xxs", "xs", "s", "m", "l", "xl", "xxl", "xxxl", "2xl", "3xl"];
export function sortSizeRows<T extends { readonly sizeLabel: string }>(rows: readonly T[]): T[] {
  const rank = (l: string): number | null => {
    const s = l.trim().toLowerCase();
    const a = ALPHA.indexOf(s);
    if (a >= 0) return a;
    return /^\d+(\.\d+)?$/.test(s) ? 1000 + Number(s) : null;
  };
  const allRanked = rows.every((r) => rank(r.sizeLabel) !== null);
  if (!allRanked) return [...rows];
  return [...rows].sort((x, y) => (rank(x.sizeLabel) as number) - (rank(y.sizeLabel) as number));
}

export function checkChart(draft: ChartDraft): ChartCheck {
  const issues: ChartIssue[] = [];
  const parsedRows: { sizeLabel: string; measurements: Record<string, number> }[] = [];
  for (const row of sortSizeRows(draft.rows)) {
    const measurements: Record<string, number> = {};
    for (const [k, raw] of Object.entries(row.values)) {
      const text = raw.trim().replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace("٫", ".").replace(",", ".");
      if (text === "") continue;
      if (!/^\d{1,3}(\.\d{1,2})?$/.test(text)) {
        issues.push({ sizeLabel: row.sizeLabel, messageKey: "chart.err.out_of_range", code: "not_a_number" });
        continue;
      }
      measurements[k] = Number(text);
    }
    parsedRows.push({ sizeLabel: row.sizeLabel.trim(), measurements });
  }
  const v = validateChart({ productType: draft.productType, unit: draft.unit, rows: parsedRows });
  for (const e of v.errors) issues.push({ sizeLabel: e.sizeLabel, messageKey: keyFor(e.code), code: e.code });
  const valid = issues.length === 0;
  return {
    valid,
    issues,
    body: valid ? { product_type: draft.productType, unit: draft.unit, rows: parsedRows.map((r) => ({ size_label: r.sizeLabel, measurements: r.measurements })) } : null,
  };
}

export function requiredFor(productType: string): readonly MeasureKey[] {
  return requiredMeasures(productType) ?? [];
}
