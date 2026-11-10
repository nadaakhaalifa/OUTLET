import { createHash } from "node:crypto";
import { Ledger, integrityScan } from "@outlet/ledger";
import { uuidv7 } from "@outlet/ids";
import { negate } from "@outlet/money";
import { acct } from "./accounts.js";
import type { Queryable } from "@outlet/db";
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
  /** sha256 over (market, day, per-currency totals, chain head): the daily signed snapshot stored on the run row. */
  readonly snapshotSha256: string;
}

/** Shape stored in reconciliation_runs.details (bigints as decimal strings). The dashboard reader parses exactly this. */
export interface IntegrityDetails {
  readonly version: 1;
  readonly business_date: string;
  readonly balanced: boolean;
  readonly chain_ok: boolean;
  readonly chain_head: string | null;
  readonly entries: number | null;
  readonly totals: Readonly<Record<string, string>>;
  readonly snapshot_sha256: string;
  readonly checks: readonly { readonly name: string; readonly ok: boolean }[];
}

/** Deterministic uuid for a mismatch that has no row of its own (a currency total): the exception key (market, source, kind, ref_type, ref_id) stays stable across reruns. */
const refUuid = (seed: string): string => {
  const h = createHash("sha256").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

/**
 * Ledger integrity (master prompt T4): per-currency trial balance 0 (I6), every entry balanced, hash chain verifies end to end (I20), payouts_in_transit
 * equals the SENT payouts (projection, I21), seller_pending never debit (I11), store_credit never debit (I7). Reuses integrityScan / Ledger.balance.
 * Records ONE reconciliation run per (market, business date) (source ledger_integrity; a rerun replaces it) with `details` (per-currency totals, chain
 * head, snapshot digest), puts every mismatch in reconciliation_exceptions, and emits `ledger.integrity_failed` when any check fails.
 * The Admin dashboard tile reads the stored run; the scan is never run on a request path.
 */
export class IntegrityJob {
  constructor(private readonly deps: FinanceDeps) {}

  async run(marketId: string, now: Date = this.deps.now(), businessDate: string = now.toISOString().slice(0, 10)): Promise<IntegrityReport> {
    return inJob(this.deps, marketId, "finance.reconcile", (tx) => this.runIn(tx, marketId, now, businessDate));
  }

  /** Same as run, inside the caller's finance.reconcile transaction (the consumer commits its inbox row together with the run). */
  async runIn(tx: Queryable, marketId: string, now: Date = this.deps.now(), businessDate: string = now.toISOString().slice(0, 10)): Promise<IntegrityReport> {
    const cur = this.deps.currency;
    const checks: IntegrityCheck[] = [];
    const scan = await integrityScan(tx, marketId, businessDate);
    const nonZero = scan.totals.filter((t) => t.totalMinor !== 0n);
    checks.push({ name: "trial_balance_zero", ok: nonZero.length === 0, detail: scan.totals.length === 0 ? "no postings" : scan.totals.map((t) => `${t.currency} ${t.totalMinor.toString()}`).join(", ") });
    checks.push({ name: "entries_balanced", ok: scan.unbalancedTotal === 0, detail: `${String(scan.unbalancedTotal)} unbalanced entries` });
    const chain = scan.chain;
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
    const details: IntegrityDetails = {
      version: 1, business_date: businessDate, balanced: nonZero.length === 0 && scan.unbalancedTotal === 0, chain_ok: chain.ok,
      chain_head: chain.ok ? chain.headHash : null, entries: chain.ok ? chain.entries : null,
      totals: Object.fromEntries(scan.totals.map((t) => [t.currency, t.totalMinor.toString()])), snapshot_sha256: scan.snapshotSha256,
      checks: checks.map((c) => ({ name: c.name, ok: c.ok })),
    };
    const run = await tx.query<{ id: string }>(
      `INSERT INTO reconciliation_runs (id, market_id, source, counterparty, business_date, mode, status, matched_count, unmatched_count, started_at, finished_at, details)
       VALUES ($1, $2, 'ledger_integrity', 'ledger', $3::date, 'nightly', $4, $5, $6, $7::timestamptz, $7::timestamptz, $8::jsonb)
       ON CONFLICT (market_id, source, counterparty, business_date, mode)
       DO UPDATE SET status = EXCLUDED.status, matched_count = EXCLUDED.matched_count, unmatched_count = EXCLUDED.unmatched_count, started_at = EXCLUDED.started_at,
                     finished_at = EXCLUDED.finished_at, details = EXCLUDED.details
       RETURNING id`,
      [uuidv7(), marketId, businessDate, failures.length === 0 ? "completed" : "failed", checks.length - failures.length, failures.length, now.toISOString(), JSON.stringify(details)],
    );
    const runId = run.rows[0]?.id ?? uuidv7();
    interface Item { kind: string; refType: string; refId: string; entryId: string | null; expected: bigint | null; actual: bigint | null; currency: string }
    const items: Item[] = [
      ...scan.unbalanced.map((u): Item => ({ kind: "entry_unbalanced", refType: "journal_entry", refId: u.entryId, entryId: u.entryId, expected: 0n, actual: u.deltaMinor, currency: u.currency })),
      ...nonZero.map((t): Item => ({ kind: "currency_total_nonzero", refType: "currency_total", refId: refUuid(`${marketId}|${t.currency}`), entryId: null, expected: 0n, actual: t.totalMinor, currency: t.currency })),
      ...(chain.ok ? [] : [{ kind: "chain_broken", refType: "journal_entry", refId: chain.entryId, entryId: chain.entryId, expected: null, actual: null, currency: this.deps.currency } satisfies Item]),
    ];
    for (const it of items) {
      await tx.query(
        `INSERT INTO reconciliation_exceptions (id, run_id, market_id, source, counterparty, kind, ref_type, ref_id, entry_id, expected_minor, actual_minor, currency, status, first_seen_at, last_seen_at)
         VALUES ($1, $2, $3, 'ledger_integrity', 'ledger', $4, $5, $6, $7, $8, $9, $10, 'OPEN', $11::timestamptz, $11::timestamptz)
         ON CONFLICT (market_id, source, kind, ref_type, ref_id) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at, actual_minor = EXCLUDED.actual_minor, run_id = EXCLUDED.run_id,
                     status = CASE WHEN reconciliation_exceptions.status = 'RESOLVED' THEN 'OPEN' ELSE reconciliation_exceptions.status END,
                     resolved_at = CASE WHEN reconciliation_exceptions.status = 'RESOLVED' THEN NULL ELSE reconciliation_exceptions.resolved_at END`,
        [uuidv7(), runId, marketId, it.kind, it.refType, it.refId, it.entryId, it.expected?.toString() ?? null, it.actual?.toString() ?? null, it.currency, now.toISOString()],
      );
    }
    if (failures.length > 0) {
      await emit(tx, marketId, now, "ledger.integrity_failed", "reconciliation_run", runId, { failed: failures.map((f) => f.name).join(","), market_id: marketId });
    }
    return { ok: failures.length === 0, checks, snapshotSha256: scan.snapshotSha256 };
  }
}
