export type CsvCell = string | number | bigint | boolean | null;

export interface CsvExport {
  readonly sellerId: string;
  readonly report: string;
  readonly generatedAtIso: string;
  /** Opaque per-export mark, minted by the caller; also written to the audit log. */
  readonly watermark: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly CsvCell[])[];
}

const FORMULA_START = /^[=+\-@\t\r]/;

/** RFC 4180 quoting plus a spreadsheet formula guard for text cells (CSV injection). */
export function csvCell(cell: CsvCell): string {
  if (cell === null) return "";
  if (typeof cell === "number" || typeof cell === "bigint" || typeof cell === "boolean") return String(cell);
  const safe = FORMULA_START.test(cell) ? `'${cell}` : cell;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/**
 * Every export carries the seller id and the watermark in a comment header AND in a trailing
 * `exported_for_seller` / `watermark` column on every row, so a pasted fragment is still traceable.
 */
export function buildWatermarkedCsv(e: CsvExport): string {
  const header = [
    "# Z-OUTLET seller analytics export (confidential, for the named seller only)",
    `# seller_id: ${e.sellerId}`,
    `# report: ${e.report}`,
    `# generated_at: ${e.generatedAtIso}`,
    `# watermark: ${e.watermark}`,
  ];
  const cols = [...e.columns, "exported_for_seller", "watermark"];
  const lines = [cols.map(csvCell).join(",")];
  for (const row of e.rows) {
    if (row.length !== e.columns.length) throw new RangeError("row width does not match columns");
    lines.push([...row, e.sellerId, e.watermark].map(csvCell).join(","));
  }
  return `${header.join("\n")}\n${lines.join("\n")}\n`;
}
