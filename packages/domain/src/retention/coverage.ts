import type { PolicyRule, RetentionPolicy } from "./policy";
import { FINANCIAL_FLOOR, retentionCutoffMs } from "./period";
import { FINANCIAL_RULES } from "./policy";

export type ExemptionKind =
  | "retained_by_law" // financial/tax/consent evidence kept for the legal period
  | "append_only_archival" // append-only or trigger-protected: archive/partition-drop, never DELETE
  | "owned_elsewhere" // another worker job already purges it (owner must be a registered job)
  | "erasure_flow" // user-driven: handled by the deletion/consent-withdrawal flow, not by age
  | "pending_tables"; // inventory tables not migrated yet

export interface Exemption {
  readonly kind: ExemptionKind;
  readonly reason: string;
  /** Required for owned_elsewhere: the worker job name that owns it. */
  readonly owner?: string;
}

/** What the nightly job does for one retention rule. */
export interface RuleDisposition {
  readonly ruleId: string;
  /** Purge target ids that apply to this rule (see the module's target catalog). */
  readonly targets: readonly string[];
  /** Applies to every migrated table of the rule that no target covers. Required when anything is left uncovered. */
  readonly rest?: Exemption;
}

export interface TargetRef {
  readonly id: string;
  readonly ruleId: string;
  readonly table: string;
  /** Child tables the handler purges in the same batch. */
  readonly dependents?: readonly string[];
}

export interface CoverageReport {
  readonly problems: readonly string[];
  /** rule -> inventory tables that do not exist in migrations yet (cannot be purged until they land). */
  readonly pending: ReadonlyMap<string, readonly string[]>;
  /** rule -> migrated tables left to `rest`. */
  readonly rested: ReadonlyMap<string, readonly string[]>;
}

const ownedNeedsOwner = (e: Exemption): boolean => e.kind === "owned_elsewhere" && (e.owner === undefined || e.owner === "");

export function verifyCoverage(
  policy: RetentionPolicy,
  dispositions: readonly RuleDisposition[],
  targets: readonly TargetRef[],
  migratedTables: ReadonlySet<string>,
): CoverageReport {
  const problems: string[] = [];
  const pending = new Map<string, readonly string[]>();
  const rested = new Map<string, readonly string[]>();
  const byRule = new Map(dispositions.map((d) => [d.ruleId, d] as const));
  const targetById = new Map(targets.map((t) => [t.id, t] as const));
  for (const d of dispositions) if (!policy.has(d.ruleId)) problems.push(`disposition for unknown rule ${d.ruleId}`);

  for (const rule of policy.values()) {
    if (rule.after === "none") continue; // catalog/device data: nothing to purge
    const d = byRule.get(rule.id);
    if (d === undefined) {
      problems.push(`rule ${rule.id} (${rule.purgeJob}) has no purge handler and no explicit exemption`);
      continue;
    }
    problemsForRule(rule, d, targetById, migratedTables, problems, pending, rested);
  }
  return { problems, pending, rested };
}

function problemsForRule(
  rule: PolicyRule,
  d: RuleDisposition,
  targetById: ReadonlyMap<string, TargetRef>,
  migrated: ReadonlySet<string>,
  problems: string[],
  pending: Map<string, readonly string[]>,
  rested: Map<string, readonly string[]>,
): void {
  const covered = new Set<string>();
  for (const id of d.targets) {
    const t = targetById.get(id);
    if (t === undefined) problems.push(`rule ${rule.id}: unknown target ${id}`);
    else if (t.ruleId !== rule.id) problems.push(`target ${id} belongs to ${t.ruleId}, not ${rule.id}`);
    else if (!rule.tables.has(t.table)) problems.push(`target ${id}: table ${t.table} is not under rule ${rule.id} in the inventory`);
    else if (!migrated.has(t.table)) problems.push(`target ${id}: table ${t.table} is not in the migrations`);
    else {
      covered.add(t.table);
      for (const c of t.dependents ?? []) if (rule.tables.has(c)) covered.add(c);
    }
  }
  const existing = [...rule.tables.keys()].filter((t) => migrated.has(t));
  const missing = [...rule.tables.keys()].filter((t) => !migrated.has(t));
  const left = existing.filter((t) => !covered.has(t));
  if (missing.length > 0) pending.set(rule.id, missing);
  if (left.length > 0) rested.set(rule.id, left);

  if (d.rest !== undefined) {
    if (d.rest.reason.trim().length < 20) problems.push(`rule ${rule.id}: exemption reason is too short`);
    if (ownedNeedsOwner(d.rest)) problems.push(`rule ${rule.id}: owned_elsewhere needs an owner job`);
  }
  if (left.length > 0 && d.rest === undefined) problems.push(`rule ${rule.id}: tables ${left.join(", ")} have no purge target and no exemption`);
  if (d.targets.length === 0 && d.rest === undefined) problems.push(`rule ${rule.id}: no targets and no exemption`);
  if (d.rest?.kind === "pending_tables" && existing.length > 0 && missing.length === 0)
    problems.push(`rule ${rule.id}: marked pending_tables but every table is migrated`);
  if (d.rest?.kind === "retained_by_law" && rule.period === null)
    problems.push(`rule ${rule.id}: retained_by_law needs a finite period`);
  if (FINANCIAL_RULES.has(rule.id) && d.targets.length > 0 && rule.period !== null) {
    const now = Date.UTC(2030, 0, 1);
    if (retentionCutoffMs(now, rule.period) > retentionCutoffMs(now, FINANCIAL_FLOOR))
      problems.push(`financial rule ${rule.id} has a period shorter than the legal floor`);
  }
}
