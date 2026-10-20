import type { RetentionPeriod } from "./period";

/** Structural subset of docs/privacy/data_inventory.yaml (validated upstream by tooling/privacy/check-inventory.mjs). */
export interface InventoryRetentionRule {
  readonly period: RetentionPeriod | null;
  readonly trigger: string;
  readonly after: string;
  readonly purge_job: string;
  readonly purge_metric: string;
  readonly verify: boolean;
}
export interface InventoryField {
  readonly retention?: string;
  readonly on_erasure?: string;
}
export interface InventoryTable {
  readonly name: string;
  readonly defaults?: { readonly retention?: string; readonly on_erasure?: string };
  readonly fields: readonly InventoryField[];
}
export interface InventoryLike {
  readonly retention: Readonly<Record<string, InventoryRetentionRule>>;
  readonly tables: readonly InventoryTable[];
}

export interface PolicyRule {
  readonly id: string;
  readonly period: RetentionPeriod | null;
  readonly trigger: string;
  readonly after: string;
  readonly purgeJob: string;
  readonly purgeMetric: string;
  readonly verify: boolean;
  /** Table -> distinct on_erasure values of its fields under this rule. */
  readonly tables: ReadonlyMap<string, readonly string[]>;
}
export type RetentionPolicy = ReadonlyMap<string, PolicyRule>;

/** Rules whose records are financial or tax evidence: never purged inside the legal period (spec B1, B4). */
export const FINANCIAL_RULES: ReadonlySet<string> = new Set([
  "orders_tax_records",
  "raw_webhooks_financial",
  "stock_movement_evidence",
  "delivery_records",
]);

export function buildRetentionPolicy(inv: InventoryLike): RetentionPolicy {
  const acc = new Map<string, Map<string, Set<string>>>();
  for (const t of inv.tables) {
    for (const f of t.fields) {
      const rule = f.retention ?? t.defaults?.retention;
      if (rule === undefined) continue;
      const tables = acc.get(rule) ?? new Map<string, Set<string>>();
      const onErasure = tables.get(t.name) ?? new Set<string>();
      onErasure.add(f.on_erasure ?? t.defaults?.on_erasure ?? "not_personal");
      tables.set(t.name, onErasure);
      acc.set(rule, tables);
    }
  }
  const out = new Map<string, PolicyRule>();
  for (const [id, r] of Object.entries(inv.retention)) {
    const tables = new Map<string, readonly string[]>();
    for (const [name, set] of [...(acc.get(id) ?? [])].sort(([a], [b]) => a.localeCompare(b))) tables.set(name, [...set].sort());
    out.set(id, { id, period: r.period, trigger: r.trigger, after: r.after, purgeJob: r.purge_job, purgeMetric: r.purge_metric, verify: r.verify, tables });
  }
  return out;
}
