import { InvalidPrivacyInputError } from "./errors";

/**
 * Pure erasure planning from the data inventory (spec section 2 Rules, docs/privacy/data_inventory.yaml).
 * Input is the RESOLVED inventory (field tags with table defaults applied). Nothing here does I/O.
 */
export type InventoryOnErasure = "delete" | "pseudonymize" | "retain_legal" | "not_personal";
export type PiiClass = "P0" | "P1" | "P2" | "P3";

export interface InventoryField {
  readonly name: string;
  readonly piiClass: PiiClass;
  readonly onErasure: InventoryOnErasure;
  /** Retention key from the inventory, when set. */
  readonly retention: string | null;
  /** Effective dsar_export tag (explicit, else true for P2/P3). */
  readonly dsarExport: boolean;
}

export interface InventoryTable {
  readonly name: string;
  readonly storage: "platform_db" | "processor_hosted" | "device_only";
  readonly fields: readonly InventoryField[];
}

export type FieldErasure = "erase" | "pseudonymise" | "retain_by_law";
export type TableErasureAction = FieldErasure | "none";

export interface TableErasurePlan {
  readonly table: string;
  /** Strongest treatment: retain_by_law > pseudonymise > erase > none. */
  readonly action: TableErasureAction;
  readonly eraseFields: readonly string[];
  readonly pseudonymiseFields: readonly string[];
  readonly retainFields: readonly string[];
  readonly retentionKeys: readonly string[];
  readonly storage: InventoryTable["storage"];
}

export interface ErasurePlan {
  readonly tables: readonly TableErasurePlan[];
  readonly counts: Readonly<Record<TableErasureAction, number>>;
}

const FIELD_ACTION: Readonly<Record<Exclude<InventoryOnErasure, "not_personal">, FieldErasure>> = {
  delete: "erase",
  pseudonymize: "pseudonymise",
  retain_legal: "retain_by_law",
};

const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function planErasure(tables: readonly InventoryTable[]): ErasurePlan {
  const seen = new Set<string>();
  const plans: TableErasurePlan[] = [];
  for (const t of tables) {
    if (seen.has(t.name)) throw new InvalidPrivacyInputError(`duplicate inventory table ${t.name}`);
    seen.add(t.name);
    const erase: string[] = [];
    const pseudo: string[] = [];
    const retain: string[] = [];
    const retention = new Set<string>();
    for (const f of t.fields) {
      if (f.onErasure === "not_personal") continue;
      const action = FIELD_ACTION[f.onErasure];
      if (action === "erase") erase.push(f.name);
      else if (action === "pseudonymise") pseudo.push(f.name);
      else retain.push(f.name);
      if (f.retention !== null && action !== "erase") retention.add(f.retention);
    }
    const action: TableErasureAction =
      retain.length > 0 ? "retain_by_law" : pseudo.length > 0 ? "pseudonymise" : erase.length > 0 ? "erase" : "none";
    plans.push({
      table: t.name,
      action,
      eraseFields: erase.sort(byName),
      pseudonymiseFields: pseudo.sort(byName),
      retainFields: retain.sort(byName),
      retentionKeys: [...retention].sort(byName),
      storage: t.storage,
    });
  }
  plans.sort((a, b) => byName(a.table, b.table));
  const counts: Record<TableErasureAction, number> = { erase: 0, pseudonymise: 0, retain_by_law: 0, none: 0 };
  for (const p of plans) counts[p.action] += 1;
  return { tables: plans, counts };
}

/** Stable pseudonym that replaces the user id in retained records. Hasher must be keyed with an external secret. */
export function pseudonymFor(userId: string, hasher: (input: string) => string): string {
  if (userId.length === 0) throw new InvalidPrivacyInputError("userId required");
  const h = hasher(`user:${userId}`);
  if (h.length === 0) throw new InvalidPrivacyInputError("hasher returned an empty value");
  return `del_${h}`;
}
