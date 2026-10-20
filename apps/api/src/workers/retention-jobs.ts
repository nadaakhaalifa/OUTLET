import { RETENTION_PURGE, TARGETS } from "../modules/retention";
import type { JobSpec } from "./job-spec";

const MIN = 60_000;

/** Rules with at least one purge target, in a stable order. Rules that are retained by law have no job by design. */
export const RETENTION_RULES: readonly string[] = [...new Set(TARGETS.map((t) => t.ruleId))].sort();

/**
 * One nightly job per rule family, staggered three minutes apart from 03:00 Cairo (16 jobs, 03:01 to 03:46, clear of forecasting at 03:15 and creators at 03:50) (low-traffic, after the
 * 02:30 ledger integrity run and before the 04:00 payout cycle). Each purges in batches of 1000 and reports
 * counters; a failed target throws so the scheduler records the failure.
 */
export const RETENTION_JOB_SPECS: readonly JobSpec[] = RETENTION_RULES.map((ruleId, i): JobSpec => ({
  name: `retention.purge.${ruleId}`,
  token: RETENTION_PURGE,
  method: "run",
  args: () => [ruleId],
  ownerModule: "retention",
  cadence: { kind: "cairo", hour: 3, minute: i * 3 + 1 },
  timeoutMs: 20 * MIN,
  criticality: "routine",
  idempotency: "delete/nullify of rows strictly older than the cutoff; legal holds and guards re-evaluated each batch; a rerun finds nothing left",
}));
