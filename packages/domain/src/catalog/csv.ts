/** Pure RFC 4180 CSV parser with hard caps. No file IO, no regex on unbounded input. */
export const CSV_LIMITS = {
  maxBytes: 256 * 1024,
  maxRows: 5000,
  maxColumns: 40,
  maxCellChars: 4096,
} as const;

export type CsvErrorCode = "csv_malformed" | "csv_too_large" | "too_many_rows" | "too_many_columns" | "cell_too_long" | "no_rows";

export type CsvParseResult =
  | { readonly ok: true; readonly header: readonly string[]; readonly rows: readonly (readonly string[])[] }
  | { readonly ok: false; readonly code: CsvErrorCode };

export function parseCsv(input: string): CsvParseResult {
  // Byte cap approximated by UTF-16 length x 3 upper bound is too loose; use exact UTF-8 length.
  if (new TextEncoder().encode(input).length > CSV_LIMITS.maxBytes) return { ok: false, code: "csv_too_large" };
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const records: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let cellWasQuoted = false;
  let i = 0;
  const endCell = (): boolean => {
    if (cell.length > CSV_LIMITS.maxCellChars) return false;
    row.push(cell);
    cell = "";
    cellWasQuoted = false;
    return row.length <= CSV_LIMITS.maxColumns;
  };
  while (i < text.length) {
    const c = text.charAt(i);
    if (inQuotes) {
      if (c === '"') {
        if (text.charAt(i + 1) === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      cell += c;
      if (cell.length > CSV_LIMITS.maxCellChars) return { ok: false, code: "cell_too_long" };
      i += 1;
      continue;
    }
    if (c === '"') {
      if (cell.length > 0 || cellWasQuoted) return { ok: false, code: "csv_malformed" };
      inQuotes = true;
      cellWasQuoted = true;
      i += 1;
      continue;
    }
    if (c === ",") {
      if (cell.length > CSV_LIMITS.maxCellChars) return { ok: false, code: "cell_too_long" };
      if (!endCell()) return { ok: false, code: "too_many_columns" };
      i += 1;
      continue;
    }
    if (c === "\r" || c === "\n") {
      if (c === "\r" && text.charAt(i + 1) === "\n") i += 1;
      i += 1;
      if (cell.length > CSV_LIMITS.maxCellChars) return { ok: false, code: "cell_too_long" };
      if (!endCell()) return { ok: false, code: "too_many_columns" };
      // Skip fully empty lines.
      if (!(row.length === 1 && row[0] === "")) records.push(row);
      row = [];
      if (records.length > CSV_LIMITS.maxRows + 1) return { ok: false, code: "too_many_rows" };
      continue;
    }
    if (cellWasQuoted) return { ok: false, code: "csv_malformed" };
    cell += c;
    if (cell.length > CSV_LIMITS.maxCellChars) return { ok: false, code: "cell_too_long" };
    i += 1;
  }
  if (inQuotes) return { ok: false, code: "csv_malformed" };
  if (cell.length > 0 || cellWasQuoted || row.length > 0) {
    if (!endCell()) return { ok: false, code: "too_many_columns" };
    if (!(row.length === 1 && row[0] === "")) records.push(row);
  }
  const header = records[0];
  if (header === undefined) return { ok: false, code: "no_rows" };
  const data = records.slice(1);
  if (data.length === 0) return { ok: false, code: "no_rows" };
  if (data.length > CSV_LIMITS.maxRows) return { ok: false, code: "too_many_rows" };
  return { ok: true, header: header.map((h) => h.trim()), rows: data };
}

/** Quotes a cell for CSV export and neutralises spreadsheet formulas (OWASP CSV injection). */
export function csvCell(value: string): string {
  const needsGuard = /^[=+\-@\t\r]/.test(value);
  const v = needsGuard ? `'${value}` : value;
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}
