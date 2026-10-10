import type { ExporterDescriptor } from "../domain/bridge";
import type { ExportRow, ExporterPort } from "../domain/ports";

export class ExporterRegistryError extends Error {}

export interface CollectedExport {
  /** Rows per table, tables sorted by name. Tables an exporter declared but had no rows for are present and empty. */
  readonly tables: Readonly<Record<string, readonly ExportRow[]>>;
  readonly exporterKeys: readonly string[];
}

/**
 * Registry of ExporterPort implementations. Construction fails on duplicate keys or on two exporters
 * claiming one table, so a user can never receive a table twice or have one silently overwritten.
 */
export class ExporterRegistry {
  private readonly exporters: readonly ExporterPort[];

  constructor(exporters: readonly ExporterPort[]) {
    const keys = new Set<string>();
    const tables = new Map<string, string>();
    for (const e of exporters) {
      if (keys.has(e.key)) throw new ExporterRegistryError(`duplicate exporter key ${e.key}`);
      keys.add(e.key);
      for (const t of e.tables) {
        const owner = tables.get(t);
        if (owner !== undefined) throw new ExporterRegistryError(`table ${t} claimed by ${owner} and ${e.key}`);
        tables.set(t, e.key);
      }
    }
    this.exporters = [...exporters].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  descriptors(): readonly ExporterDescriptor[] {
    return this.exporters.map((e) => ({ key: e.key, tables: [...e.tables].sort() }));
  }

  async collect(userId: string): Promise<CollectedExport> {
    const out = new Map<string, readonly ExportRow[]>();
    for (const e of this.exporters) {
      const declared = new Set(e.tables);
      const section = await e.collect(userId);
      for (const t of Object.keys(section.tables)) {
        if (!declared.has(t)) {
          throw new ExporterRegistryError(`exporter ${e.key} returned undeclared table ${t}`);
        }
      }
      for (const t of e.tables) out.set(t, section.tables[t] ?? []);
    }
    const sorted = [...out.keys()].sort();
    return {
      tables: Object.fromEntries(sorted.map((t) => [t, out.get(t) ?? []])),
      exporterKeys: this.exporters.map((e) => e.key),
    };
  }
}
