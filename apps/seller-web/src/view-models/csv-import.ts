import type { MessageKey } from "../i18n";

/**
 * Client-side CSV pre-check for catalog import (spec 19: bulk CSV validated, dry-run, error report).
 * It never replaces the server dry run; it makes obvious errors visible before upload.
 * Prices are whole piastres (integer) so no decimal or float parsing is needed.
 */
export const REQUIRED_COLUMNS = ["title_ar", "category_id", "condition", "size_label", "price_piastres"] as const;
export const OPTIONAL_COLUMNS = ["title_en", "description_ar", "stock", "seller_sku", "barcode_gtin", "color"] as const;
export const MAX_IMPORT_ROWS = 5000;
export const CONDITIONS = ["new_with_tags", "new_without_tags", "sample", "minor_defect"] as const;

export type ImportErrorCode =
  | "missing_header" | "unknown_header" | "title_ar_required" | "title_ar_not_arabic" | "category_invalid"
  | "condition_invalid" | "size_label_required" | "price_invalid" | "stock_invalid" | "column_count"
  | "too_many_rows" | "empty";

export interface ImportRowError {
  /** 1-based row number in the file including the header (header is row 1). 0 for file-level errors. */
  readonly row: number;
  readonly column: string | null;
  readonly code: ImportErrorCode;
  readonly messageKey: MessageKey;
}

export interface ImportCheck {
  readonly rowsTotal: number;
  readonly rowsOk: number;
  readonly rowsFailed: number;
  readonly errors: readonly ImportRowError[];
}

/** RFC 4180 subset: quoted fields, doubled quotes, CRLF or LF, BOM stripped. */
export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < src.length; i += 1) {
    const c = src.charAt(i);
    if (inQuotes) {
      if (c === '"') {
        if (src.charAt(i + 1) === '"') {
          field += '"';
          i += 1;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src.charAt(i + 1) === "\n") i += 1;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0] !== "") rows.push(row);
  }
  return rows;
}

const ARABIC = /[؀-ۿ]/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = (code: ImportErrorCode): MessageKey => (code === "empty" ? "import.err.empty" : `import.err.${code}`);

export function checkCatalogCsv(text: string): ImportCheck {
  const errors: ImportRowError[] = [];
  const fileErr = (code: ImportErrorCode, column: string | null = null): void => {
    errors.push({ row: 0, column, code, messageKey: KEY(code) });
  };
  const rows = parseCsv(text);
  const header = rows[0];
  if (header === undefined) {
    fileErr("empty");
    return { rowsTotal: 0, rowsOk: 0, rowsFailed: 0, errors };
  }
  const names = header.map((h) => h.trim());
  const known = new Set<string>([...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS]);
  for (const r of REQUIRED_COLUMNS) if (!names.includes(r)) fileErr("missing_header", r);
  for (const n of names) if (!known.has(n)) fileErr("unknown_header", n);
  if (errors.length > 0) return { rowsTotal: Math.max(0, rows.length - 1), rowsOk: 0, rowsFailed: Math.max(0, rows.length - 1), errors };

  const data = rows.slice(1);
  if (data.length === 0) {
    fileErr("empty");
    return { rowsTotal: 0, rowsOk: 0, rowsFailed: 0, errors };
  }
  if (data.length > MAX_IMPORT_ROWS) {
    fileErr("too_many_rows");
    return { rowsTotal: data.length, rowsOk: 0, rowsFailed: data.length, errors };
  }
  const idx = (n: string): number => names.indexOf(n);
  const bad = new Set<number>();
  data.forEach((cells, i) => {
    const rowNo = i + 2;
    const add = (code: ImportErrorCode, column: string): void => {
      bad.add(rowNo);
      errors.push({ row: rowNo, column, code, messageKey: KEY(code) });
    };
    if (cells.length !== names.length) {
      bad.add(rowNo);
      errors.push({ row: rowNo, column: null, code: "column_count", messageKey: KEY("column_count") });
      return;
    }
    const cell = (n: string): string => (cells[idx(n)] ?? "").trim();
    const titleAr = cell("title_ar");
    if (titleAr === "") add("title_ar_required", "title_ar");
    else if (!ARABIC.test(titleAr)) add("title_ar_not_arabic", "title_ar");
    if (!UUID.test(cell("category_id"))) add("category_invalid", "category_id");
    if (!(CONDITIONS as readonly string[]).includes(cell("condition"))) add("condition_invalid", "condition");
    if (cell("size_label") === "") add("size_label_required", "size_label");
    const price = cell("price_piastres");
    if (!/^[1-9]\d{0,12}$/.test(price)) add("price_invalid", "price_piastres");
    if (idx("stock") >= 0 && cell("stock") !== "" && !/^\d{1,7}$/.test(cell("stock"))) add("stock_invalid", "stock");
  });
  return { rowsTotal: data.length, rowsOk: data.length - bad.size, rowsFailed: bad.size, errors };
}
