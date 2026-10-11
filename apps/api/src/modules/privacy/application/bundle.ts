import type { ExportLocale } from "../domain/bridge";
import type { CollectedExport } from "./exporters";
import { buildZip } from "./zip";

/** JSON that survives bigint (money in piastres) without losing precision: bigints become strings. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2);
}

const README_AR = [
  "نسخة من بياناتك الشخصية لدى Z-OUTLET",
  "",
  "هذا الملف يحتوي على البيانات الشخصية المرتبطة بحسابك، بصيغة JSON، ملف لكل جدول بيانات داخل المجلد data.",
  "الملف manifest.json يوضح الجداول وعدد السجلات. بعض السجلات المالية محفوظة بصيغة مجهولة الهوية وفقا للقانون.",
  "الرابط الذي وصلك صالح لمدة 24 ساعة. يمكنك طلب نسخة جديدة من مركز الخصوصية.",
].join("\n");

const README_EN = [
  "Your personal data held by Z-OUTLET",
  "",
  "This archive holds the personal data linked to your account as JSON, one file per data table inside the data folder.",
  "manifest.json lists the tables and record counts. Some financial records are kept in pseudonymised form as the law requires.",
  "The download link you received is valid for 24 hours. You can request a new copy from the Privacy Center.",
].join("\n");

export interface ExportManifest {
  readonly format: 1;
  readonly generated_at: string;
  readonly locale: ExportLocale;
  readonly exporters: readonly string[];
  readonly tables: Readonly<Record<string, number>>;
}

export function assembleExportZip(input: {
  readonly collected: CollectedExport;
  readonly locale: ExportLocale;
  readonly generatedAtMs: number;
}): { readonly bytes: Uint8Array; readonly manifest: ExportManifest } {
  const enc = new TextEncoder();
  const manifest: ExportManifest = {
    format: 1,
    generated_at: new Date(input.generatedAtMs).toISOString(),
    locale: input.locale,
    exporters: input.collected.exporterKeys,
    tables: Object.fromEntries(Object.entries(input.collected.tables).map(([t, rows]) => [t, rows.length])),
  };
  const entries = [
    { path: "README.ar.txt", data: enc.encode(README_AR) },
    { path: "README.en.txt", data: enc.encode(README_EN) },
    { path: "manifest.json", data: enc.encode(stableJson(manifest)) },
    ...Object.entries(input.collected.tables).map(([table, rows]) => ({
      path: `data/${table}.json`,
      data: enc.encode(stableJson(rows)),
    })),
  ];
  return { bytes: buildZip(entries, input.generatedAtMs), manifest };
}
