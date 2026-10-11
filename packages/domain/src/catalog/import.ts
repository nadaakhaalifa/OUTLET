import { parseCsv, type CsvErrorCode } from "./csv";
import { parseEgpDecimal } from "./price-input";
import { validateProductDraft } from "./product";
import { CONDITIONS, LIMITS, type Condition, type IssueCode, type ProductDraft, type SkuDraft } from "./types";

export const IMPORT_REQUIRED_COLUMNS = ["product_ref", "title_ar", "category_slug", "condition", "size_label", "price_egp"] as const;
export const IMPORT_OPTIONAL_COLUMNS = [
  "title_en",
  "description_ar",
  "description_en",
  "brand_slug",
  "material",
  "color",
  "seller_sku",
  "barcode_gtin",
  "initial_stock",
  "image_upload_ids",
  "defect_photo_upload_ids",
] as const;
const ALL_COLUMNS: readonly string[] = [...IMPORT_REQUIRED_COLUMNS, ...IMPORT_OPTIONAL_COLUMNS];
const PRODUCT_LEVEL: readonly string[] = [
  "title_ar",
  "title_en",
  "description_ar",
  "description_en",
  "category_slug",
  "brand_slug",
  "condition",
  "material",
  "image_upload_ids",
  "defect_photo_upload_ids",
];
const PRODUCT_REF = /^[A-Za-z0-9._-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const MAX_ERRORS_PER_ROW = 20;

export interface RowError {
  /** 1-based line number in the file: the header is line 1, the first data row is line 2. */
  readonly row: number;
  readonly column?: string;
  readonly code: IssueCode;
}

export interface ImportedProduct {
  readonly productRef: string;
  readonly draft: ProductDraft;
  readonly rows: readonly number[];
}

export type ImportFileError = { readonly code: CsvErrorCode | "unknown_column" | "missing_column"; readonly columns: readonly string[] };

export interface ImportReport {
  readonly rowsTotal: number;
  readonly rowsOk: number;
  readonly rowsFailed: number;
  readonly errors: readonly RowError[];
  /** Only products whose every row validated. Never mutates anything: the caller decides to apply. */
  readonly products: readonly ImportedProduct[];
}

export type ParsedImport =
  | { readonly ok: true; readonly header: readonly string[]; readonly rows: readonly (readonly string[])[] }
  | { readonly ok: false; readonly error: ImportFileError };

export function parseImportFile(text: string): ParsedImport {
  const r = parseCsv(text);
  if (!r.ok) return { ok: false, error: { code: r.code, columns: [] } };
  const seen = new Set<string>();
  for (const h of r.header) {
    if (seen.has(h)) return { ok: false, error: { code: "csv_malformed", columns: [] } };
    seen.add(h);
  }
  const unknown = r.header.filter((h) => !ALL_COLUMNS.includes(h));
  if (unknown.length > 0) return { ok: false, error: { code: "unknown_column", columns: unknown.slice(0, 20) } };
  const missing = IMPORT_REQUIRED_COLUMNS.filter((c) => !seen.has(c));
  if (missing.length > 0) return { ok: false, error: { code: "missing_column", columns: missing } };
  return { ok: true, header: r.header, rows: r.rows };
}

function splitIds(cell: string): string[] {
  return cell
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Upload ids a file refers to, so the caller can resolve ownership once before validating. */
export function referencedUploadIds(p: Extract<ParsedImport, { ok: true }>): ReadonlySet<string> {
  const out = new Set<string>();
  const cols = ["image_upload_ids", "defect_photo_upload_ids"].map((c) => p.header.indexOf(c)).filter((i) => i >= 0);
  for (const row of p.rows) {
    for (const ci of cols) for (const id of splitIds(row[ci] ?? "")) if (UUID.test(id)) out.add(id);
  }
  return out;
}

export interface ImportContext {
  readonly categories: ReadonlyMap<string, { readonly id: string; readonly active: boolean }>;
  readonly brands: ReadonlyMap<string, string>;
  /** Upload ids that exist and belong to the importing store. */
  readonly ownedUploadIds: ReadonlySet<string>;
  /** `gtinVariantKey` values already used by the store. */
  readonly takenGtinVariants: ReadonlySet<string>;
}

export function gtinVariantKey(gtin: string, color: string | undefined, sizeLabel: string): string {
  return `${gtin}|${(color ?? "").trim().toLowerCase()}|${sizeLabel.trim().toLowerCase()}`;
}

function columnForPointer(pointer: string): { column?: string; skuIndex?: number } {
  const m = /^\/skus\/(\d+)(?:\/([a-z_]+))?$/.exec(pointer);
  if (m !== null) {
    const idx = Number(m[1]);
    const f = m[2];
    const map: Record<string, string> = {
      size_label: "size_label",
      color: "color",
      price: "price_egp",
      barcode_gtin: "barcode_gtin",
      seller_sku: "seller_sku",
      initial_stock: "initial_stock",
    };
    const col = f === undefined ? undefined : map[f];
    return { skuIndex: idx, ...(col !== undefined ? { column: col } : {}) };
  }
  const flat: Record<string, string> = {
    "/title/ar": "title_ar",
    "/title/en": "title_en",
    "/description/ar": "description_ar",
    "/description/en": "description_en",
    "/material": "material",
    "/condition": "condition",
    "/image_upload_ids": "image_upload_ids",
    "/defect_photo_upload_ids": "defect_photo_upload_ids",
    "/skus": "size_label",
  };
  const col = flat[pointer];
  return col === undefined ? {} : { column: col };
}

interface RowParse {
  readonly line: number;
  readonly cells: Readonly<Record<string, string>>;
}

/** Pure, deterministic validation of a parsed file. Identical bytes give identical reports. */
export function validateImportRows(file: Extract<ParsedImport, { ok: true }>, ctx: ImportContext): ImportReport {
  const errors: RowError[] = [];
  const failedLines = new Set<number>();
  const perRow = new Map<number, number>();
  const addError = (e: RowError): void => {
    failedLines.add(e.row);
    const n = perRow.get(e.row) ?? 0;
    if (n >= MAX_ERRORS_PER_ROW) return;
    perRow.set(e.row, n + 1);
    errors.push(e);
  };

  const rows: RowParse[] = file.rows.map((cells, i) => {
    const rec: Record<string, string> = {};
    file.header.forEach((h, ci) => {
      rec[h] = (cells[ci] ?? "").trim();
    });
    return { line: i + 2, cells: rec };
  });

  // Group by product_ref in first-seen order.
  const groups = new Map<string, RowParse[]>();
  for (const r of rows) {
    const ref = r.cells.product_ref ?? "";
    if (!PRODUCT_REF.test(ref)) {
      addError({ row: r.line, column: "product_ref", code: "product_ref_invalid" });
      continue;
    }
    const g = groups.get(ref);
    if (g === undefined) groups.set(ref, [r]);
    else g.push(r);
  }

  const products: ImportedProduct[] = [];
  const usedGtinVariants = new Set<string>();

  for (const [ref, group] of groups) {
    const before = group.filter((r) => failedLines.has(r.line)).length;
    const first = group[0];
    if (first === undefined) continue;

    // Product-level columns must agree across rows.
    let mismatch = false;
    for (const r of group) {
      for (const col of PRODUCT_LEVEL) {
        if ((r.cells[col] ?? "") !== (first.cells[col] ?? "")) mismatch = true;
      }
    }
    if (mismatch) {
      for (const r of group) addError({ row: r.line, code: "product_columns_mismatch" });
    }

    // Row-level parsing.
    const skus: SkuDraft[] = [];
    let rowParseFailed = false;
    for (const r of group) {
      const price = parseEgpDecimal(r.cells.price_egp ?? "");
      if (price === null) {
        addError({ row: r.line, column: "price_egp", code: "invalid_value" });
        rowParseFailed = true;
      }
      let stock: number | undefined;
      const stockCell = r.cells.initial_stock ?? "";
      if (stockCell !== "") {
        if (/^[0-9]{1,6}$/.test(stockCell)) stock = Number(stockCell);
        else {
          addError({ row: r.line, column: "initial_stock", code: "stock_out_of_range" });
          rowParseFailed = true;
        }
      }
      const sellerSku = r.cells.seller_sku ?? "";
      const gtin = r.cells.barcode_gtin ?? "";
      const color = r.cells.color ?? "";
      if (price !== null) {
        skus.push({
          sizeLabel: r.cells.size_label ?? "",
          price,
          ...(color !== "" ? { color } : {}),
          ...(sellerSku !== "" ? { sellerSku } : {}),
          ...(gtin !== "" ? { gtin } : {}),
          ...(stock !== undefined ? { initialStock: stock } : {}),
        });
      } else {
        // Keep index alignment with `group` for pointer mapping by pushing a placeholder.
        skus.push({ sizeLabel: r.cells.size_label ?? "", price: { amount: 1n, currency: "EGP" } });
      }
    }

    // Product-level parsing.
    const c = first.cells;
    const condition = c.condition ?? "";
    const conditionOk = (CONDITIONS as readonly string[]).includes(condition);
    if (!conditionOk) addError({ row: first.line, column: "condition", code: "condition_invalid" });

    const category = ctx.categories.get(c.category_slug ?? "");
    if (category === undefined) addError({ row: first.line, column: "category_slug", code: "category_not_found" });
    else if (!category.active) addError({ row: first.line, column: "category_slug", code: "category_inactive" });

    const brandSlug = c.brand_slug ?? "";
    const brandId = brandSlug === "" ? undefined : ctx.brands.get(brandSlug);
    if (brandSlug !== "" && brandId === undefined) addError({ row: first.line, column: "brand_slug", code: "brand_not_found" });

    const parseIds = (col: "image_upload_ids" | "defect_photo_upload_ids"): string[] => {
      const ids = splitIds(c[col] ?? "");
      for (const id of ids) {
        if (!UUID.test(id)) addError({ row: first.line, column: col, code: "invalid_value" });
        else if (!ctx.ownedUploadIds.has(id)) addError({ row: first.line, column: col, code: "upload_not_found" });
      }
      return ids;
    };
    const imageIds = parseIds("image_upload_ids");
    const defectIds = parseIds("defect_photo_upload_ids");

    const draft: ProductDraft = {
      title: { ar: c.title_ar ?? "", ...((c.title_en ?? "") !== "" ? { en: c.title_en ?? "" } : {}) },
      ...((c.description_ar ?? "") !== ""
        ? { description: { ar: c.description_ar ?? "", ...((c.description_en ?? "") !== "" ? { en: c.description_en ?? "" } : {}) } }
        : {}),
      categoryId: category?.id ?? "00000000-0000-0000-0000-000000000000",
      ...(brandId !== undefined ? { brandId } : {}),
      condition: conditionOk ? (condition as Condition) : "new_with_tags",
      ...((c.material ?? "") !== "" ? { material: c.material ?? "" } : {}),
      imageUploadIds: imageIds,
      defectPhotoUploadIds: defectIds,
      skus,
    };
    if ((c.description_en ?? "") !== "" && (c.description_ar ?? "") === "") {
      addError({ row: first.line, column: "description_ar", code: "arabic_text_required" });
    }

    for (const issue of validateProductDraft(draft)) {
      if (issue.code === "condition_invalid") continue; // already reported from the raw cell
      const { column, skuIndex } = columnForPointer(issue.pointer);
      const target = skuIndex !== undefined ? group[skuIndex] : first;
      addError({ row: (target ?? first).line, ...(column !== undefined ? { column } : {}), code: issue.code });
    }

    // GTIN variant conflicts, against the store and within the file.
    group.forEach((r, i) => {
      const s = skus[i];
      if (s === undefined || s.gtin === undefined) return;
      const key = gtinVariantKey(s.gtin, s.color, s.sizeLabel);
      if (ctx.takenGtinVariants.has(key) || usedGtinVariants.has(key)) {
        addError({ row: r.line, column: "barcode_gtin", code: "invalid_value" });
      }
    });

    const groupFailed = rowParseFailed || mismatch || group.some((r) => failedLines.has(r.line)) || before > 0;
    if (groupFailed) {
      for (const r of group) {
        if (!failedLines.has(r.line)) addError({ row: r.line, code: "product_group_invalid" });
      }
      continue;
    }
    for (const s of skus) if (s.gtin !== undefined) usedGtinVariants.add(gtinVariantKey(s.gtin, s.color, s.sizeLabel));
    products.push({ productRef: ref, draft, rows: group.map((r) => r.line) });
  }

  // Rows whose product_ref was invalid are failed already; rows in failed groups were added above.
  errors.sort((a, b) => a.row - b.row);
  const rowsTotal = file.rows.length;
  const rowsFailed = failedLines.size;
  return { rowsTotal, rowsOk: rowsTotal - rowsFailed, rowsFailed, errors, products };
}

/** Parse then validate in one call. */
export function validateImportText(
  text: string,
  ctxFor: (parsed: Extract<ParsedImport, { ok: true }>) => ImportContext,
): { readonly kind: "file_error"; readonly error: ImportFileError } | { readonly kind: "report"; readonly report: ImportReport } {
  const parsed = parseImportFile(text);
  if (!parsed.ok) return { kind: "file_error", error: parsed.error };
  return { kind: "report", report: validateImportRows(parsed, ctxFor(parsed)) };
}

export { LIMITS as IMPORT_PRODUCT_LIMITS };
