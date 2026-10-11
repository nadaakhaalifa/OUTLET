import { effectiveCutoffMs, FINANCIAL_RULES, type RetentionPeriod } from "../domain/bridge";
import { TARGETS } from "../domain/catalog";
import type { BlobDeletePort, PurgeExecutor, PurgeRunStore, PurgeTarget, RetentionMetrics, RunStatus } from "../domain/ports";
import { RULE_PARAMS } from "../domain/rules.snapshot";

export const BATCH_SIZE = 1000;
export const DEFAULT_MAX_BATCHES = 200;

export interface RetentionDeps {
  readonly executor: PurgeExecutor;
  readonly runs: PurgeRunStore;
  readonly metrics: RetentionMetrics;
  readonly clock: { nowMs(): number };
  readonly ids: { uuidV7(): string };
}

export interface TargetReport {
  readonly targetId: string;
  readonly status: RunStatus;
  readonly eligible: number;
  readonly held: number;
  readonly purged: number;
  readonly batches: number;
  readonly lagSeconds: number;
}

export interface RuleReport {
  readonly ruleId: string;
  readonly dryRun: boolean;
  readonly targets: readonly TargetReport[];
  readonly purged: number;
  readonly eligible: number;
  readonly held: number;
  readonly failed: number;
}

export interface RunOptions {
  readonly dryRun?: boolean;
  readonly maxBatches?: number;
  readonly batchSize?: number;
}

export class UnknownRetentionRuleError extends Error {
  constructor(readonly ruleId: string) {
    super(`no purge targets for retention rule ${ruleId}`);
    this.name = "UnknownRetentionRuleError";
  }
}

/** The period a target waits: the rule's own period, else the target's grace for event-driven rules. */
export function periodFor(t: PurgeTarget): RetentionPeriod {
  const rule = RULE_PARAMS[t.ruleId];
  const p = rule?.period ?? t.grace;
  if (p === undefined || p === null) throw new Error(`target ${t.id} has no retention period or grace`);
  return p;
}

export const targetsOf = (ruleId: string): readonly PurgeTarget[] => TARGETS.filter((t) => t.ruleId === ruleId);

export class RunRetention {
  constructor(private readonly d: RetentionDeps) {}

  /** Nightly entry point for one rule: purges every target of the rule, or only counts when `dryRun`. */
  async runRule(ruleId: string, o: RunOptions = {}): Promise<RuleReport> {
    const targets = targetsOf(ruleId);
    if (targets.length === 0) throw new UnknownRetentionRuleError(ruleId);
    const reports: TargetReport[] = [];
    for (const t of targets) reports.push(await this.runTarget(t, o));
    const sum = (f: (r: TargetReport) => number): number => reports.reduce((a, r) => a + f(r), 0);
    const rule: RuleReport = {
      ruleId,
      dryRun: o.dryRun === true,
      targets: reports,
      purged: sum((r) => r.purged),
      eligible: sum((r) => r.eligible),
      held: sum((r) => r.held),
      failed: reports.filter((r) => r.status === "FAILED").length,
    };
    return rule;
  }

  async runTarget(t: PurgeTarget, o: RunOptions = {}): Promise<TargetReport> {
    const dryRun = o.dryRun === true;
    const batch = o.batchSize ?? BATCH_SIZE;
    const maxBatches = o.maxBatches ?? DEFAULT_MAX_BATCHES;
    const now = this.d.clock.nowMs();
    const cutoff = effectiveCutoffMs(now, t.ruleId, periodFor(t), FINANCIAL_RULES.has(t.ruleId));
    const runId = this.d.ids.uuidV7();
    await this.d.runs.start({ id: runId, ruleId: t.ruleId, targetId: t.id, dryRun, cutoffMs: cutoff, startedMs: now });

    let purged = 0;
    let batches = 0;
    let eligible = 0;
    let held = 0;
    let oldest: number | null = null;
    let status: RunStatus = "COMPLETED";
    let errorCode: string | null = null;
    try {
      const c = await this.d.executor.count(t, cutoff);
      eligible = c.eligible;
      held = c.held;
      oldest = c.oldestEligibleMs;
      if (!dryRun) {
        for (;;) {
          if (batches >= maxBatches) {
            status = "PARTIAL";
            break;
          }
          const n = await this.d.executor.purgeBatch(t, cutoff, batch);
          batches += 1;
          purged += n;
          if (n < batch) break;
        }
      }
    } catch (e) {
      status = "FAILED";
      errorCode = e instanceof Error ? e.name.slice(0, 80) : "unknown";
    }

    const lagSeconds = oldest === null ? 0 : Math.max(0, Math.floor((now - oldest) / 1000));
    const metric = RULE_PARAMS[t.ruleId]?.purgeMetric ?? `privacy_${t.ruleId}_purged_total`;
    const labels = { rule: t.ruleId, target: t.id, mode: dryRun ? "dry_run" : "live" };
    if (!dryRun) this.d.metrics.counter(metric, purged, labels);
    this.d.metrics.gauge("retention_eligible_rows", eligible, labels);
    this.d.metrics.gauge("retention_held_rows", held, labels);
    this.d.metrics.gauge("retention_oldest_eligible_lag_seconds", lagSeconds, labels);

    await this.d.runs.finish(runId, {
      finishedMs: this.d.clock.nowMs(),
      status,
      rowsPurged: purged,
      rowsEligible: eligible,
      rowsHeld: held,
      batches,
      oldestEligibleMs: oldest,
      errorCode,
    });
    return { targetId: t.id, status, eligible, held, purged, batches, lagSeconds };
  }
}

/**
 * Worker-facing use case. `run` is what the scheduler calls: it purges for real and throws when any target
 * failed, so the scheduler records a failure and the dead-man gauge alerts.
 */
export class PurgeRetentionJob {
  constructor(private readonly runner: RunRetention) {}
  async run(ruleId: string): Promise<{ purged: number; eligible: number; held: number; failed: number }> {
    const r = await this.runner.runRule(ruleId);
    if (r.failed > 0) throw new Error(`retention ${ruleId}: ${r.failed} target(s) failed`);
    return { purged: r.purged, eligible: r.eligible, held: r.held, failed: r.failed };
  }
  /** Admin/DPO dry run: counts only. */
  async dryRun(ruleId: string): Promise<RuleReport> {
    return this.runner.runRule(ruleId, { dryRun: true });
  }
}

export type { BlobDeletePort };
