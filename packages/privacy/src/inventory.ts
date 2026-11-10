import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { z } from "zod";

const columnSchema = z.object({ name: z.string(), pii_class: z.enum(["P0", "P1", "P2", "P3"]), retention: z.string().optional() });
const inventorySchema = z.object({
  tables: z.array(z.object({ name: z.string(), columns: z.array(columnSchema) })),
});

export interface ExportField {
  readonly table: string;
  readonly column: string;
  readonly piiClass: "P2" | "P3";
  readonly retention: string | null;
}

export const DEFAULT_INVENTORY_PATH = fileURLToPath(new URL("../../../data_inventory.yaml", import.meta.url));

/** Every P2/P3 column in data_inventory.yaml, in file order: the scope of a DSAR export. */
export const loadExportFields = async (path: string = DEFAULT_INVENTORY_PATH): Promise<ExportField[]> => {
  const doc = inventorySchema.parse(parse(await readFile(path, "utf8")));
  const out: ExportField[] = [];
  for (const t of doc.tables) {
    for (const c of t.columns) {
      if (c.pii_class === "P2" || c.pii_class === "P3") out.push({ table: t.name, column: c.name, piiClass: c.pii_class, retention: c.retention ?? null });
    }
  }
  return out;
};

export const groupByTable = (fields: readonly ExportField[]): Map<string, ExportField[]> => {
  const m = new Map<string, ExportField[]>();
  for (const f of fields) {
    const list = m.get(f.table);
    if (list) list.push(f);
    else m.set(f.table, [f]);
  }
  return m;
};
