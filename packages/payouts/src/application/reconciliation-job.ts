import type { Queryable } from "@outlet/db";
import { uuidv7 } from "@outlet/ids";
import { DAY_MS } from "../domain/eligibility.js";
import { shouldEscalate } from "../domain/reconcile.js";
import { emit, inJob, toDate } from "./shared.js";
import type { FinanceDeps } from "./shared.js";

export const RECONCILIATION_SOURCES = ["psp_settlement", "cod_remittance", "store_credit_projection"] as const;
export type ReconciliationSource = (typeof RECONCILIATION_SOURCES)[number];

interface Found {
  readonly kind: string;
  readonly refType: string;
  readonly refId: string;
  readonly counterparty: string;
  readonly expectedMinor: bigint | null;
  readonly actualMinor: bigint | null;
  /** When the discrepancy started (value date, delivery time...): aging runs from here, not from the first scan. */
  readonly since: Date;
}
interface Matched {
  readonly refType: string;
  readonly refId: string;
  readonly entryId: string | null;
  readonly amountMinor: bigint;
}
interface SourceResult {
  readonly found: readonly Found[];
  readonly matched: readonly Matched[];
}

export interface SourceSummary {
  readonly source: ReconciliationSource;
  readonly runId: string;
  readonly matched: number;
  readonly open: number;
  readonly newExceptions: number;
  readonly escalated: number;
  readonly resolved: number;
}
export interface ReconciliationReport {
  readonly marketId: string;
  readonly businessDate: string;
  readonly sources: readonly SourceSummary[];
}

export interface ReconciliationOptions {
  readonly mode?: "nightly" | "intraday";
  /** A captured payment with no settlement line, or a delivered COD order with no remittance line, after this many days is an exception. */
  readonly missingAfterDays?: number;
}

const key = (f: { kind: string; refType: string; refId: string }): string => `${f.kind}|${f.refType}|${f.refId}`;
const minOf = (a: Date, b: Date): Date => (a.getTime() <= b.getTime() ? a : b);

/**
 * Nightly (and intraday) reconciliation: PSP settlement lines <-> payment intents and psp_clearing, courier COD remittances <-> cod_clearing,
 * store-credit balances <-> postings (never negative, I7). Idempotent per (source, business date, mode). Every unmatched item becomes a
 * reconciliation_exceptions row (OPEN) and an outbox event `reconciliation.exception` (the ticketing consumer opens the ticket); an item
 * unresolved for more than 3 days becomes ESCALATED with `reconciliation.escalated` (Finance). Items that match later are RESOLVED by the next run.
 */
export class ReconciliationJob {
  constructor(private readonly deps: FinanceDeps) {}

  async run(marketId: string, businessDate: string, now: Date = this.deps.now(), opts: ReconciliationOptions = {}): Promise<ReconciliationReport> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) throw new RangeError("businessDate must be YYYY-MM-DD");
    const mode = opts.mode ?? "nightly";
    const missingAfter = (opts.missingAfterDays ?? 3) * DAY_MS;
    const sources: SourceSummary[] = [];
    for (const source of RECONCILIATION_SOURCES) {
      sources.push(await inJob(this.deps, marketId, "finance.reconcile", async (tx) => {
        const runId = await this.openRun(tx, marketId, source, businessDate, mode, now);
        const res = source === "psp_settlement" ? await this.psp(tx, now, missingAfter) : source === "cod_remittance" ? await this.cod(tx, now, missingAfter) : await this.storeCredit(tx, now);
        return this.apply(tx, marketId, source, runId, res, now);
      }));
    }
    return { marketId, businessDate, sources };
  }

  private async openRun(tx: Queryable, marketId: string, source: string, businessDate: string, mode: string, now: Date): Promise<string> {
    const r = await tx.query<{ id: string }>(
      `INSERT INTO reconciliation_runs (id, market_id, source, counterparty, business_date, mode, status, started_at) VALUES ($1, $2, $3, 'all', $4::date, $5, 'running', $6::timestamptz)
       ON CONFLICT (market_id, source, counterparty, business_date, mode) DO UPDATE SET status = 'running', started_at = EXCLUDED.started_at, finished_at = NULL RETURNING id`,
      [uuidv7(), marketId, source, businessDate, mode, now.toISOString()],
    );
    return r.rows[0]?.id ?? "";
  }

  // ---------------------------------------------------------------- sources

  private async psp(tx: Queryable, now: Date, missingAfter: number): Promise<SourceResult> {
    const found: Found[] = [];
    const matched: Matched[] = [];
    const lines = await tx.query<{ id: string; provider: string; status: string; detail: string | null; kind: string; amount: string; value_date: string; entry: string | null; intent_amount: string | null }>(
      `SELECT l.id, l.provider, l.status, l.detail, l.kind, l.amount_minor::text AS amount, l.value_date::text AS value_date, l.matched_entry_id AS entry,
              pi.amount_minor::text AS intent_amount
         FROM psp_settlement_lines l LEFT JOIN payment_intents pi ON pi.id = l.intent_id`,
    );
    for (const l of lines.rows) {
      if (l.status === "matched") {
        matched.push({ refType: "psp_settlement_line", refId: l.id, entryId: l.entry, amountMinor: BigInt(l.amount) });
      } else {
        found.push({
          kind: `${l.status}_${l.detail ?? "line"}`.slice(0, 60), refType: "psp_settlement_line", refId: l.id, counterparty: l.provider,
          expectedMinor: l.intent_amount === null ? null : BigInt(l.intent_amount), actualMinor: BigInt(l.amount), since: minOf(new Date(`${l.value_date}T00:00:00Z`), now),
        });
      }
    }
    const cutoff = new Date(now.getTime() - missingAfter);
    const missing = await tx.query<{ id: string; provider: string; amount: string; updated_at: Date | string }>(
      `SELECT pi.id, pi.provider, pi.amount_minor::text AS amount, pi.updated_at FROM payment_intents pi
        WHERE pi.status IN ('CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED') AND pi.provider NOT IN ('none') AND pi.method NOT IN ('cod', 'store_credit', 'bnpl')
          AND pi.provider_ref IS NOT NULL AND pi.amount_minor > 0 AND pi.updated_at < $1::timestamptz
          AND NOT EXISTS (SELECT 1 FROM psp_settlement_lines l WHERE l.provider = pi.provider AND l.provider_ref = pi.provider_ref AND l.kind = 'capture')`,
      [cutoff.toISOString()],
    );
    for (const m of missing.rows) {
      found.push({ kind: "missing_settlement", refType: "payment_intent", refId: m.id, counterparty: m.provider, expectedMinor: BigInt(m.amount), actualMinor: null, since: toDate(m.updated_at) });
    }
    return { found, matched };
  }

  private async cod(tx: Queryable, now: Date, missingAfter: number): Promise<SourceResult> {
    const found: Found[] = [];
    const matched: Matched[] = [];
    const lines = await tx.query<{ id: string; courier: string; status: string; detail: string | null; collected: string; created: Date | string; business_date: string }>(
      `SELECT l.id, r.courier, l.status, l.detail, l.collected_minor::text AS collected, r.received_at AS created, r.business_date::text AS business_date
         FROM cod_remittance_lines l JOIN cod_remittances r ON r.id = l.remittance_id`,
    );
    for (const l of lines.rows) {
      if (l.status === "matched") matched.push({ refType: "cod_remittance_line", refId: l.id, entryId: null, amountMinor: BigInt(l.collected) });
      else {
        found.push({ kind: `${l.status}_${l.detail ?? "line"}`.slice(0, 60), refType: "cod_remittance_line", refId: l.id, counterparty: l.courier, expectedMinor: null, actualMinor: BigInt(l.collected), since: minOf(new Date(`${l.business_date}T00:00:00Z`), now) });
      }
    }
    const heads = await tx.query<{ id: string; courier: string; net: string; business_date: string }>(
      "SELECT id, courier, net_minor::text AS net, business_date::text AS business_date FROM cod_remittances WHERE status = 'mismatch'",
    );
    for (const h of heads.rows) {
      found.push({ kind: "remittance_total_mismatch", refType: "cod_remittance", refId: h.id, counterparty: h.courier, expectedMinor: null, actualMinor: BigInt(h.net), since: minOf(new Date(`${h.business_date}T00:00:00Z`), now) });
    }
    const cutoff = new Date(now.getTime() - missingAfter);
    const missing = await tx.query<{ id: string; total: string; delivered_at: Date | string }>(
      `SELECT s.id, s.total_minor::text AS total, s.delivered_at FROM seller_orders s JOIN payment_intents pi ON pi.order_group_id = s.order_group_id
        WHERE pi.method = 'cod' AND s.delivered_at IS NOT NULL AND s.delivered_at < $1::timestamptz
          AND EXISTS (SELECT 1 FROM journal_entries e WHERE e.idempotency_key = 'order_delivered_cod:' || s.id::text)
          AND NOT EXISTS (SELECT 1 FROM cod_remittance_lines l WHERE l.seller_order_id = s.id AND l.status = 'matched')`,
      [cutoff.toISOString()],
    );
    for (const m of missing.rows) {
      found.push({ kind: "missing_remittance", refType: "seller_order", refId: m.id, counterparty: "courier", expectedMinor: BigInt(m.total), actualMinor: null, since: toDate(m.delivered_at) });
    }
    return { found, matched };
  }

  /** I7 / I21: a store-credit account may never hold a debit balance (credit liabilities only). */
  private async storeCredit(tx: Queryable, now: Date): Promise<SourceResult> {
    const r = await tx.query<{ id: string; total: string }>(
      `SELECT a.id, sum(p.amount_minor)::text AS total FROM postings p JOIN ledger_accounts a ON a.id = p.account_id
        WHERE a.type = 'store_credit' GROUP BY a.id HAVING sum(p.amount_minor) > 0`,
    );
    return {
      found: r.rows.map((x) => ({ kind: "store_credit_negative", refType: "ledger_account", refId: x.id, counterparty: "ledger", expectedMinor: 0n, actualMinor: -BigInt(x.total), since: now })),
      matched: [],
    };
  }

  // ---------------------------------------------------------------- persistence, aging, escalation

  private async apply(tx: Queryable, marketId: string, source: ReconciliationSource, runId: string, res: SourceResult, now: Date): Promise<SourceSummary> {
    const cur = this.deps.currency;
    for (const m of res.matched) {
      await tx.query(
        `INSERT INTO reconciliation_matches (id, run_id, market_id, source, ref_type, ref_id, entry_id, amount_minor, currency, matched_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::bigint, $9, $10::timestamptz) ON CONFLICT (market_id, source, ref_type, ref_id) DO NOTHING`,
        [uuidv7(), runId, marketId, source, m.refType, m.refId, m.entryId, m.amountMinor.toString(), cur, now.toISOString()],
      );
    }
    const open = await tx.query<{ id: string; kind: string; ref_type: string; ref_id: string }>(
      "SELECT id, kind, ref_type, ref_id FROM reconciliation_exceptions WHERE market_id = $1 AND source = $2 AND status <> 'RESOLVED'", [marketId, source]);
    const foundKeys = new Set(res.found.map(key));
    let resolved = 0;
    for (const o of open.rows) {
      if (foundKeys.has(key({ kind: o.kind, refType: o.ref_type, refId: o.ref_id }))) continue;
      await tx.query("UPDATE reconciliation_exceptions SET status = 'RESOLVED', resolved_at = $2::timestamptz, last_seen_at = $2::timestamptz WHERE id = $1", [o.id, now.toISOString()]);
      resolved += 1;
    }
    let created = 0;
    for (const f of res.found) {
      const prior = await tx.query<{ id: string; status: string }>(
        "SELECT id, status FROM reconciliation_exceptions WHERE market_id = $1 AND source = $2 AND kind = $3 AND ref_type = $4 AND ref_id = $5", [marketId, source, f.kind, f.refType, f.refId]);
      const p = prior.rows[0];
      if (p && p.status !== "RESOLVED") {
        await tx.query("UPDATE reconciliation_exceptions SET last_seen_at = $2::timestamptz, actual_minor = $3::bigint WHERE id = $1", [p.id, now.toISOString(), f.actualMinor?.toString() ?? null]);
        continue;
      }
      let id = p?.id;
      if (p) {
        await tx.query(
          `UPDATE reconciliation_exceptions SET status = 'OPEN', resolved_at = NULL, escalated_at = NULL, first_seen_at = $2::timestamptz, last_seen_at = $3::timestamptz, actual_minor = $4::bigint WHERE id = $1`,
          [p.id, f.since.toISOString(), now.toISOString(), f.actualMinor?.toString() ?? null]);
      } else {
        id = uuidv7();
        await tx.query(
          `INSERT INTO reconciliation_exceptions (id, run_id, market_id, source, counterparty, kind, ref_type, ref_id, expected_minor, actual_minor, currency, status, first_seen_at, last_seen_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::bigint, $10::bigint, $11, 'OPEN', $12::timestamptz, $13::timestamptz)`,
          [id, runId, marketId, source, f.counterparty, f.kind, f.refType, f.refId, f.expectedMinor?.toString() ?? null, f.actualMinor?.toString() ?? null, cur, f.since.toISOString(), now.toISOString()]);
      }
      created += 1;
      await emit(tx, marketId, now, "reconciliation.exception", "reconciliation_exception", id ?? "", {
        source, kind: f.kind, ref_type: f.refType, ref_id: f.refId, counterparty: f.counterparty, currency: cur, expected_minor: f.expectedMinor?.toString() ?? null, actual_minor: f.actualMinor?.toString() ?? null,
      });
    }
    const aging = await tx.query<{ id: string; kind: string; first_seen_at: Date | string }>(
      "SELECT id, kind, first_seen_at FROM reconciliation_exceptions WHERE market_id = $1 AND source = $2 AND status = 'OPEN'", [marketId, source]);
    let escalated = 0;
    for (const a of aging.rows) {
      if (!shouldEscalate(toDate(a.first_seen_at), now)) continue;
      await tx.query("UPDATE reconciliation_exceptions SET status = 'ESCALATED', escalated_at = $2::timestamptz WHERE id = $1", [a.id, now.toISOString()]);
      await emit(tx, marketId, now, "reconciliation.escalated", "reconciliation_exception", a.id, { source, kind: a.kind, first_seen_at: toDate(a.first_seen_at).toISOString() });
      escalated += 1;
    }
    await tx.query("UPDATE reconciliation_runs SET status = 'completed', matched_count = $2, unmatched_count = $3, finished_at = $4::timestamptz WHERE id = $1", [runId, res.matched.length, res.found.length, now.toISOString()]);
    return { source, runId, matched: res.matched.length, open: res.found.length, newExceptions: created, escalated, resolved };
  }
}
