import type { InventoryTable } from "./erasure-plan";

/**
 * Export coverage gate (spec B1 data subject rights): every inventory table that holds P2/P3 data
 * tagged for DSAR export needs an exporter, or an explicit, reasoned exemption.
 */
export interface ExporterDescriptor {
  readonly key: string;
  readonly tables: readonly string[];
}

export interface ExporterExemption {
  readonly table: string;
  readonly reason: string;
}

/** Tables with at least one personal (P2/P3) field whose effective dsar_export tag is true. */
export function exportableTables(tables: readonly InventoryTable[]): readonly string[] {
  return tables
    .filter((t) => t.fields.some((f) => f.dsarExport && (f.piiClass === "P2" || f.piiClass === "P3")))
    .map((t) => t.name)
    .sort();
}

export interface ExporterCoverageReport {
  /** Exportable tables with neither an exporter nor an exemption. */
  readonly missing: readonly string[];
  /** Tables named by an exporter or exemption that are not exportable inventory tables. */
  readonly unknown: readonly string[];
  /** Tables claimed by more than one exporter. */
  readonly duplicates: readonly string[];
  /** Exemptions with a blank reason. */
  readonly unexplained: readonly string[];
  /** Tables that have both an exporter and an exemption. */
  readonly contradictory: readonly string[];
  readonly ok: boolean;
}

export function checkExporterCoverage(
  tables: readonly InventoryTable[],
  exporters: readonly ExporterDescriptor[],
  exemptions: readonly ExporterExemption[],
): ExporterCoverageReport {
  const exportable = new Set(exportableTables(tables));
  const claimed = new Map<string, number>();
  for (const e of exporters) for (const t of e.tables) claimed.set(t, (claimed.get(t) ?? 0) + 1);
  const exempt = new Set(exemptions.map((e) => e.table));
  const covered = new Set([...claimed.keys(), ...exempt]);
  const missing = [...exportable].filter((t) => !covered.has(t)).sort();
  const unknown = [...covered].filter((t) => !exportable.has(t)).sort();
  const duplicates = [...claimed].filter(([, n]) => n > 1).map(([t]) => t).sort();
  const unexplained = exemptions.filter((e) => e.reason.trim().length === 0).map((e) => e.table).sort();
  const contradictory = [...exempt].filter((t) => claimed.has(t)).sort();
  return {
    missing,
    unknown,
    duplicates,
    unexplained,
    contradictory,
    ok:
      missing.length === 0 &&
      unknown.length === 0 &&
      duplicates.length === 0 &&
      unexplained.length === 0 &&
      contradictory.length === 0,
  };
}
