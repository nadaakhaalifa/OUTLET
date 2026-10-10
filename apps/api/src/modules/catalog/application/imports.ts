import {
  csvCell,
  gtinVariantKey,
  parseImportFile,
  referencedUploadIds,
  validateImportRows,
  type ImportReport,
} from "../domain/catalog-domain";
import type { ImportErrorRow, ImportRecord, ImportRepository } from "../domain/ports";
import { checkReferences, type CatalogDeps, type CreateProduct } from "./products";

export interface ImportDeps extends CatalogDeps {
  readonly imports: ImportRepository;
}

export type CreateImportResult =
  | { readonly kind: "ok"; readonly record: ImportRecord }
  | { readonly kind: "upload_not_found" };

/**
 * Bulk import. The same validator runs for dry run and real run; the dry-run branch performs no
 * catalog write at all (no insert, no stock seed, no event), only the import record is saved.
 */
export class CreateImport {
  constructor(
    private readonly deps: ImportDeps,
    private readonly creator: CreateProduct,
  ) {}

  async execute(input: { storeId: string; actorId: string; uploadId: string; dryRun: boolean }): Promise<CreateImportResult> {
    const text = await this.deps.uploads.readText(input.storeId, input.uploadId);
    if (text === null) return { kind: "upload_not_found" };
    const id = this.deps.ids.uuidV7();
    const createdAtMs = this.deps.clock.nowMs();
    const base = { id, storeId: input.storeId, actorId: input.actorId, uploadId: input.uploadId, dryRun: input.dryRun, createdAtMs };

    const parsed = parseImportFile(text);
    if (!parsed.ok) {
      const errors: ImportErrorRow[] =
        parsed.error.columns.length === 0
          ? [{ row: 1, code: parsed.error.code }]
          : parsed.error.columns.map((c) => ({ row: 1, column: c, code: parsed.error.code }));
      const record: ImportRecord = { ...base, status: "failed", rowsTotal: 0, rowsOk: 0, rowsFailed: 0, errors };
      await this.deps.imports.save(record);
      return { kind: "ok", record };
    }

    const owned = await this.deps.uploads.ownedBy(input.storeId, [...referencedUploadIds(parsed)]);
    const [categories, brands, taken] = await Promise.all([
      this.deps.taxonomy.allCategories(),
      this.deps.taxonomy.allBrands(),
      this.deps.products.takenGtinVariants(input.storeId),
    ]);
    const report: ImportReport = validateImportRows(parsed, {
      categories: new Map(categories.map((c) => [c.slug, { id: c.id, active: c.active }])),
      brands: new Map(brands.map((b) => [b.slug, b.id])),
      ownedUploadIds: owned,
      takenGtinVariants: taken,
    });
    const errors: ImportErrorRow[] = report.errors.map((e) => ({ row: e.row, ...(e.column !== undefined ? { column: e.column } : {}), code: e.code }));
    const counts = { rowsTotal: report.rowsTotal, rowsOk: report.rowsOk, rowsFailed: report.rowsFailed, errors };

    if (input.dryRun) {
      const record: ImportRecord = { ...base, ...counts, status: "dry_run_complete" };
      await this.deps.imports.save(record);
      return { kind: "ok", record };
    }

    // Real run: only fully valid products, each atomically. Referenced taxonomy was resolved by the validator.
    let created = 0;
    for (const p of report.products) {
      if (!(await this.deps.imports.claimProduct(id, p.productRef))) continue;
      const refs = await checkReferences(this.deps, input.storeId, p.draft);
      if (refs.issues.length > 0) continue;
      const stillTaken = await this.deps.products.takenGtinVariants(input.storeId);
      if (p.draft.skus.some((s) => s.gtin !== undefined && stillTaken.has(gtinVariantKey(s.gtin, s.color, s.sizeLabel)))) continue;
      await this.creator.persist(input.storeId, input.actorId, p.draft);
      created += 1;
    }
    const status = created === 0 ? "failed" : "completed";
    const record: ImportRecord = { ...base, ...counts, status };
    await this.deps.imports.save(record);
    return { kind: "ok", record };
  }
}

export class GetImport {
  constructor(private readonly imports: ImportRepository) {}
  /** Only after the policy guard authorised the import's tenant. */
  async executeAuthorised(importId: string): Promise<ImportRecord | null> {
    return this.imports.find(importId);
  }
  async execute(storeId: string, importId: string): Promise<ImportRecord | null> {
    const r = await this.imports.find(importId);
    return r !== null && r.storeId === storeId ? r : null;
  }
}

export const ERROR_REPORT_MAX_BYTES = 64 * 1024;

/**
 * CSV error report as a data URI (development adapter, spec deviation D-2). Contains only row numbers,
 * column names and machine codes, never cell contents. Returns null when there are no errors.
 */
export function errorReportDataUri(errors: readonly ImportErrorRow[]): string | null {
  if (errors.length === 0) return null;
  const lines = ["row,column,code"];
  let size = lines[0]?.length ?? 0;
  for (const e of errors) {
    const line = `${e.row},${csvCell(e.column ?? "")},${csvCell(e.code)}`;
    if (size + line.length + 1 > ERROR_REPORT_MAX_BYTES - 32) {
      lines.push("0,,truncated");
      break;
    }
    lines.push(line);
    size += line.length + 1;
  }
  return `data:text/csv;charset=utf-8;base64,${Buffer.from(lines.join("\n"), "utf8").toString("base64")}`;
}
