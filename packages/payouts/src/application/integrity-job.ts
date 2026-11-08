import { Ledger } from "@outlet/ledger";
import { uuidv7 } from "@outlet/ids";
import { negate } from "@outlet/money";
import { acct } from "./accounts.js";
import { emit, inJob } from "./shared.js";
import type { FinanceDeps } from "./shared.js";

export interface IntegrityCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}
export interface IntegrityReport {
  readonly ok: boolean;
  readonly checks: readonly IntegrityCheck[];
}

/**
 * Ledger integrity (master prompt T4): trial balance 0 (I6), hash chain verifies end to end (I20), payouts_in_transit equals the SENT payouts
 * (projection, I21), seller_pending never debit (I11), store_credit never debit (I7). Reuses Ledger.trialBalance / verifyChain / balance.
 * Records a reconciliation run (source ledger_integrity) and emits `ledger.integrity_failed` when any check fails.
 */
export class IntegrityJob {
  constructor(private readonly deps: FinanceDeps) {}

  async run(marketId: string, now: Date = this.deps.now()): Promise<IntegrityReport> {
    const cur = this.deps.currency;
    return inJob(this.deps, marketId, "finance.reconcile", async (tx) => {
      const checks: IntegrityCheck[] = [];
      const tb = await Ledger.trialBalance(tx, marketId, cur);
      checks.push({ name: "trial_balance_zero", ok: tb.amountMinor === 0n, detail: `sum of postings ${tb.amountMinor.toString()}` });
      const chain = await Ledger.verifyChain(tx, marketId);
      checks.push({ name: "hash_chain", ok: chain.ok, detail: chain.ok ? `${String(chain.entries)} entries` : `broken at ${chain.entryId}: ${chain.reason}` });
      const transit = negate(await Ledger.balance(tx, acct("payouts_in_transit", marketId, cur))).amountMinor;
      const sent = await tx.query<{ total: string }>("SELECT COALESCE(sum(net_minor), 0)::text AS total FROM payouts WHERE status = 'SENT'");
      const sentTotal = BigInt(sent.rows[0]?.total ?? "0");
      checks.push({ name: "payouts_in_transit_projection", ok: transit === sentTotal, detail: `ledger ${transit.toString()} vs SENT payouts ${sentTotal.toString()}` });
      for (const type of ["seller_pending", "store_credit"] as const) {
        const bad = await tx.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM (SELECT 1 FROM postings p JOIN ledger_accounts a ON a.id = p.account_id WHERE a.type = $1 AND a.market_id = $2 GROUP BY a.id HAVING sum(p.amount_minor) > 0) x`,
          [type, marketId],
        );
        const n = Number(bad.rows[0]?.n ?? "0");
        checks.push({ name: `${type}_not_negative`, ok: n === 0, detail: `${String(n)} accounts with a debit balance` });
      }
      const failures = checks.filter((c) => !c.ok);
      const runId = uuidv7();
      await tx.query(
        `INSERT INTO reconciliation_runs (id, market_id, source, counterparty, business_date, mode, status, matched_count, unmatched_count, started_at, finished_at)
         VALUES ($1, $2, 'ledger_integrity', 'ledger', $3::date, 'nightly', $4, $5, $6, $7::timestamptz, $7::timestamptz)
         ON CONFLICT (market_id, source, counterparty, business_date, mode)
         DO UPDATE SET status = EXCLUDED.status, matched_count = EXCLUDED.matched_count, unmatched_count = EXCLUDED.unmatched_count, started_at = EXCLUDED.started_at, finished_at = EXCLUDED.finished_at`,
        [runId, marketId, now.toISOString().slice(0, 10), failures.length === 0 ? "completed" : "failed", checks.length - failures.length, failures.length, now.toISOString()],
      );
      if (failures.length > 0) {
        await emit(tx, marketId, now, "ledger.integrity_failed", "reconciliation_run", runId, { failed: failures.map((f) => f.name).join(","), market_id: marketId });
      }
      return { ok: failures.length === 0, checks };
    });
  }
}
