import { z } from "zod";
import type { InventoryTable } from "../domain/bridge";

const PiiClass = z.enum(["P0", "P1", "P2", "P3"]);
const OnErasure = z.enum(["delete", "pseudonymize", "retain_legal", "not_personal"]);

const Field = z
  .object({
    name: z.string().min(1),
    pii_class: PiiClass,
    on_erasure: OnErasure.optional(),
    retention: z.string().optional(),
    dsar_export: z.boolean().optional(),
  })
  .passthrough();

const Defaults = z
  .object({
    on_erasure: OnErasure.optional(),
    retention: z.string().optional(),
    dsar_export: z.boolean().optional(),
  })
  .passthrough();

const Table = z
  .object({
    name: z.string().min(1),
    storage: z.enum(["platform_db", "processor_hosted", "device_only"]).default("platform_db"),
    defaults: Defaults.optional(),
    fields: z.array(Field).min(1),
  })
  .passthrough();

const Inventory = z.object({ tables: z.array(Table).min(1) }).passthrough();

export class InventoryResolutionError extends Error {}

/**
 * Resolves a parsed data_inventory.yaml into the tags this module needs, applying the inventory's
 * own conventions: a field overrides its table defaults; `on_erasure` defaults to not_personal for
 * P0/P1 and is mandatory for P2/P3; `dsar_export` defaults to true for P2/P3.
 */
export function resolveInventory(raw: unknown): readonly InventoryTable[] {
  const parsed = Inventory.safeParse(raw);
  if (!parsed.success) throw new InventoryResolutionError(`inventory is malformed: ${parsed.error.message}`);
  return parsed.data.tables.map((t) => {
    const d = t.defaults ?? {};
    return {
      name: t.name,
      storage: t.storage,
      fields: t.fields.map((f) => {
        const personal = f.pii_class === "P2" || f.pii_class === "P3";
        const onErasure = f.on_erasure ?? d.on_erasure ?? (personal ? undefined : "not_personal");
        if (onErasure === undefined) {
          throw new InventoryResolutionError(`untagged field ${t.name}.${f.name}: on_erasure is required for ${f.pii_class}`);
        }
        return {
          name: f.name,
          piiClass: f.pii_class,
          onErasure,
          retention: f.retention ?? d.retention ?? null,
          dsarExport: f.dsar_export ?? d.dsar_export ?? personal,
        };
      }),
    };
  });
}
