import { createHash } from "node:crypto";
import { GENESIS_CURSOR, Ledger, integrityScan, verifyChainPage } from "@outlet/ledger";
import type { ChainCursor, ChainVerification } from "@outlet/ledger";
import { uuidv7 } from "@outlet/ids";
import { negate } from "@outlet/money";
import { z } from "zod";
import { acct } from "./accounts.js";
import type { Queryable } from "@outlet/db";
import { emit, inJob } from "./shared.js";
import type { FinanceDeps } from "./shared.js";

export const INTEGRITY_REQUESTED_EVENT = "ledger.integrity_requested";
/** Time budget per tick for chain verification (ms); the loop stops between pages once spent and a continuation event resumes it. */
export const DEFAULT_INTEGRITY_BUDGET_MS = 8_000;
/** Entries verified per page = per short transaction. */
export const INTEGRITY_PAGE_SIZE = 10_000;
/** Safety cap on self-emitted continuations of one run; a run that still is not done resumes at the next nightly tick. */
export const MAX_CONTINUATIONS = 500;

/** Deps of the integrity job: the finance deps plus the verification budget (tests inject a tiny one and a fake clock). */
export interface IntegrityDeps extends FinanceDeps {
  readonly budgetMs?: number;
  readonly pageSize?: number;
  /** Monotonic millisecond clock for the budget (default performance.now). */
  readonly monotonicMs?: () => number;
}

export interface IntegrityRunOptions {
  /** Weekly full pass: reset the cursor to 0 unless this business date's run already is a full pass (a continuation or redelivery must not reset again). */
  readonly full?: boolean;
  /** Number of the continuation event being handled (0 = scheduler tick). */
  readonly continuation?: number;
}

/** Where chain verification stands after the pages of one tick. */
export interface ChainProgress {
  /** Last verified entry; after a break it stays at the last good entry before it. */
  readonly cursor: ChainCursor;
  /** The chain head was reached. */
  readonly complete: boolean;
  readonly broken: { readonly entryId: string; readonly chainSeq: bigint; readonly reason: string } | null;
  readonly full: boolean;
  readonly pages: number;
}

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
  /** False when the tick spent its budget before the chain head: the heavy checks are deferred to the run's last tick and `checks` is empty. */
  readonly complete: boolean;
  readonly verifiedThroughSeq: bigint;
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
  /** Chain cursor (decimal string): last verified chain_seq and its hash. It stays at the last good entry when the chain is broken, so the next run re-reports the break. */
  readonly verified_through_seq: string;
  readonly cursor_hash: string;
  readonly complete: boolean;
  /** This run is a full pass (cursor was reset to 0, or inherited from an unfinished full pass). */
  readonly full: boolean;
}

/** Details of a run row still in progress (status running): only the cursor; the dashboard reads completed and failed rows only. */
export interface IntegrityProgressDetails {
  readonly version: 1;
  readonly business_date: string;
  readonly chain_ok: true;
  readonly verified_through_seq: string;
  readonly cursor_hash: string;
  readonly complete: false;
  readonly full: boolean;
}

const CursorDetails = z.object({
  verified_through_seq: z.string().regex(/^\d+$/).optional(),
  cursor_hash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  complete: z.boolean().optional(),
  full: z.boolean().optional(),
  // Rows written before the cursor existed: a verified chain stored its head and entry count.
  chain_ok: z.boolean().optional(),
  chain_head: z.string().nullable().optional(),
  entries: z.number().nullable().optional(),
}).loose();

interface PriorRun {
  readonly businessDate: string;
  readonly cursor: ChainCursor;
  readonly complete: boolean;
  readonly full: boolean;
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
  private readonly budgetMs: number;
  private readonly pageSize: number;
  private readonly mono: () => number;

  constructor(private readonly deps: IntegrityDeps) {
    this.budgetMs = deps.budgetMs ?? DEFAULT_INTEGRITY_BUDGET_MS;
    this.pageSize = deps.pageSize ?? INTEGRITY_PAGE_SIZE;
    this.mono = deps.monotonicMs ?? (() => performance.now());
  }

  /** One tick on its own transactions: verify pages (each one short transaction), then store the result. */
  async run(marketId: string, now: Date = this.deps.now(), businessDate: string = now.toISOString().slice(0, 10), opts: IntegrityRunOptions = {}): Promise<IntegrityReport> {
    const progress = await this.advance(marketId, now, businessDate, opts);
    return inJob(this.deps, marketId, "finance.reconcile", (tx) => this.finalizeIn(tx, marketId, now, businessDate, progress, opts));
  }

  /**
   * Cursor source: the latest ledger_integrity run row's `details` (verified_through_seq + cursor_hash), not a dedicated table: the run row is already
   * the unit the dashboard and the exception rows hang off, it is replaced per (market, business date) and survives across dates, and no migration or
   * data_inventory column is needed. Rows written before the cursor existed (chain_ok + chain_head + entries) are read as a cursor too.
   */
  private async loadPrior(tx: Queryable, marketId: string): Promise<PriorRun | null> {
    const r = await tx.query<{ d: string; details: unknown }>(
      "SELECT business_date::text AS d, details FROM reconciliation_runs WHERE market_id = $1 AND source = 'ledger_integrity' ORDER BY business_date DESC, started_at DESC LIMIT 1",
      [marketId],
    );
    const row = r.rows[0];
    if (row === undefined) return null;
    const p = CursorDetails.safeParse(row.details);
    if (!p.success) return { businessDate: row.d, cursor: GENESIS_CURSOR, complete: false, full: false };
    const d = p.data;
    if (d.verified_through_seq !== undefined && d.cursor_hash !== undefined) {
      return { businessDate: row.d, cursor: { seq: BigInt(d.verified_through_seq), hash: d.cursor_hash }, complete: d.complete === true, full: d.full === true };
    }
    if (d.chain_ok === true && typeof d.chain_head === "string" && typeof d.entries === "number") {
      return { businessDate: row.d, cursor: { seq: BigInt(d.entries), hash: d.chain_head }, complete: true, full: false };
    }
    return { businessDate: row.d, cursor: GENESIS_CURSOR, complete: false, full: false };
  }

  private saveProgress(tx: Queryable, marketId: string, now: Date, businessDate: string, cursor: ChainCursor, full: boolean): Promise<unknown> {
    const details: IntegrityProgressDetails = { version: 1, business_date: businessDate, chain_ok: true, verified_through_seq: cursor.seq.toString(), cursor_hash: cursor.hash, complete: false, full };
    return tx.query(
      `INSERT INTO reconciliation_runs (id, market_id, source, counterparty, business_date, mode, status, matched_count, unmatched_count, started_at, details)
       VALUES ($1, $2, 'ledger_integrity', 'ledger', $3::date, 'nightly', 'running', 0, 0, $4::timestamptz, $5::jsonb)
       ON CONFLICT (market_id, source, counterparty, business_date, mode)
       DO UPDATE SET status = 'running', finished_at = NULL, details = EXCLUDED.details`,
      [uuidv7(), marketId, businessDate, now.toISOString(), JSON.stringify(details)],
    );
  }

  /**
   * Verifies the chain forward from the stored cursor in pages of `pageSize`, each page in its own short finance.reconcile transaction (bounded by the
   * worker's statement_timeout) that also stores the new cursor on the run row, until the head is reached, a link breaks or the time budget is spent.
   * At least one page runs per tick, so a tiny budget still makes progress. A crash loses at most the page in flight.
   */
  async advance(marketId: string, now: Date, businessDate: string, opts: IntegrityRunOptions = {}): Promise<ChainProgress> {
    const prior = await inJob(this.deps, marketId, "finance.reconcile", (tx) => this.loadPrior(tx, marketId));
    const alreadyFull = prior !== null && prior.businessDate === businessDate && prior.full;
    const reset = opts.full === true && !alreadyFull;
    const full = opts.full === true || (prior !== null && prior.full && !prior.complete);
    let cursor = reset ? GENESIS_CURSOR : (prior?.cursor ?? GENESIS_CURSOR);
    const started = this.mono();
    let pages = 0;
    for (;;) {
      const from = cursor;
      const page = await inJob(this.deps, marketId, "finance.reconcile", async (tx) => {
        const r = await verifyChainPage(tx, marketId, from, this.pageSize);
        await this.saveProgress(tx, marketId, now, businessDate, r.cursor, full);
        return r;
      });
      pages += 1;
      cursor = page.cursor;
      if (!page.ok) return { cursor, complete: false, broken: { entryId: page.entryId, chainSeq: page.chainSeq, reason: page.reason }, full, pages };
      if (page.done) return { cursor, complete: true, broken: null, full, pages };
      if (this.mono() - started >= this.budgetMs) return { cursor, complete: false, broken: null, full, pages };
    }
  }

  /**
   * Stores the outcome of a tick inside the caller's finance.reconcile transaction (the consumer commits its inbox row together with it). An unfinished,
   * unbroken chain only emits a continuation event (the cursor is already stored); a finished or broken chain runs the remaining checks and stores the
   * completed or failed run.
   */
  async finalizeIn(tx: Queryable, marketId: string, now: Date, businessDate: string, progress: ChainProgress, opts: IntegrityRunOptions = {}): Promise<IntegrityReport> {
    if (!progress.complete && progress.broken === null) {
      const next = (opts.continuation ?? 0) + 1;
      if (next <= MAX_CONTINUATIONS) {
        const scope = progress.full ? "ledger_integrity_full" : "ledger_integrity";
        await emit(tx, marketId, now, INTEGRITY_REQUESTED_EVENT, "ledger_integrity", uuidv7(), { scope, window: `${scope}:${businessDate}`, continuation: next });
      }
      return { ok: true, checks: [], snapshotSha256: "", complete: false, verifiedThroughSeq: progress.cursor.seq };
    }
    const chainResult: ChainVerification = progress.broken === null
      ? { ok: true, entries: Number(progress.cursor.seq), headHash: progress.cursor.hash }
      : { ok: false, entryId: progress.broken.entryId, chainSeq: progress.broken.chainSeq, reason: progress.broken.reason };
    return this.completeIn(tx, marketId, now, businessDate, progress, chainResult);
  }

  private async completeIn(tx: Queryable, marketId: string, now: Date, businessDate: string, progress: ChainProgress, chainResult: ChainVerification): Promise<IntegrityReport> {
    const cur = this.deps.currency;
    const checks: IntegrityCheck[] = [];
    const scan = await integrityScan(tx, marketId, businessDate, chainResult);
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
      verified_through_seq: progress.cursor.seq.toString(), cursor_hash: progress.cursor.hash, complete: chain.ok, full: progress.full,
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
    return { ok: failures.length === 0, checks, snapshotSha256: scan.snapshotSha256, complete: chain.ok, verifiedThroughSeq: progress.cursor.seq };
  }
}
