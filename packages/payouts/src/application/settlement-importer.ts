import { createHash } from "node:crypto";
import type { Queryable } from "@outlet/db";
import { uuidv7 } from "@outlet/ids";
import { LedgerError, Ledger } from "@outlet/ledger";
import type { JournalEntryDraft, PostingDraft } from "@outlet/ledger";
import { money } from "@outlet/money";
import type { Currency } from "@outlet/money";
import { PayoutsError } from "../domain/errors.js";
import { matchSettlementLine } from "../domain/reconcile.js";
import type { IntentView, LineMatch } from "../domain/reconcile.js";
import { parseSettlement } from "../domain/settlement-parse.js";
import type { SettlementLineInput } from "../domain/settlement-parse.js";
import { BANK_OWNER, acct, pspClearingOwner } from "./accounts.js";
import { inJob } from "./shared.js";
import type { FinanceDeps } from "./shared.js";

export interface PspSettlementFile {
  readonly provider: string;
  /** YYYY-MM-DD. */
  readonly businessDate: string;
  readonly format: "csv" | "json";
  readonly content: string;
}
export interface ImportSummary {
  readonly fileId: string;
  readonly duplicate: boolean;
  readonly matched: number;
  readonly unmatched: number;
  readonly mismatch: number;
}

/**
 * Settlement entry for one matched line (chart 4.1, model (b)). Pure; amounts are piastres.
 *   capture: Dr bank_collections (amount - fee), Dr psp_fee_expense (fee) / Cr psp_clearing (amount)
 *   refund : Dr psp_clearing (amount), Dr psp_fee_expense (fee) / Cr bank_collections (amount + fee)   (the PSP nets refunds from what it pays)
 *   fee    : Dr psp_fee_expense / Cr bank_collections
 */
export function settlementDraft(a: { marketId: string; currency: Currency; provider: string; line: SettlementLineInput; intentId: string | null }): JournalEntryDraft {
  const { marketId, currency: c, line } = a;
  const bank = acct("bank_collections", marketId, c, BANK_OWNER);
  const fee = acct("psp_fee_expense", marketId, c);
  const clearing = acct("psp_clearing", marketId, c, pspClearingOwner(a.provider));
  const postings: PostingDraft[] = [];
  const add = (accountCode: string, minor: bigint): void => {
    if (minor !== 0n) postings.push({ accountCode, amount: money(minor, c) });
  };
  if (line.kind === "capture") {
    if (line.feeMinor > line.amountMinor) throw new PayoutsError("INVALID_INPUT", "fee exceeds the captured amount");
    add(bank, line.amountMinor - line.feeMinor);
    add(fee, line.feeMinor);
    add(clearing, -line.amountMinor);
  } else if (line.kind === "refund") {
    add(clearing, line.amountMinor);
    add(fee, line.feeMinor);
    add(bank, -(line.amountMinor + line.feeMinor));
  } else if (line.kind === "fee") {
    add(fee, line.amountMinor);
    add(bank, -line.amountMinor);
  } else {
    throw new PayoutsError("INVALID_INPUT", `${line.kind} lines are not posted automatically`);
  }
  return {
    kind: "clearing_settled",
    idempotencyKey: `psp_settlement:${a.provider}:${line.kind}:${line.providerRef}`,
    marketId,
    occurredAt: new Date(`${line.valueDate}T12:00:00.000Z`),
    ref: line.kind === "fee" ? { type: "psp_settlement_fee", id: line.providerRef } : { type: "payment_intent", id: a.intentId ?? line.providerRef },
    postings,
  };
}

interface IntentDb { id: string; provider: string; amount_minor: string; currency: string; status: string }

/** Imports a PSP settlement file: stores it once (sha256), matches each line to its payment intent and posts one clearing_settled entry per matched line. */
export class SettlementImporter {
  constructor(private readonly deps: FinanceDeps) {}

  async importPsp(marketId: string, file: PspSettlementFile): Promise<ImportSummary> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(file.businessDate)) throw new PayoutsError("INVALID_INPUT", "businessDate must be YYYY-MM-DD");
    const lines = parseSettlement(file.format, file.content);
    const sha = createHash("sha256").update(file.content).digest();
    return inJob(this.deps, marketId, "finance.reconcile", async (tx) => {
      const fileId = uuidv7();
      const ins = await tx.query(
        `INSERT INTO psp_settlement_files (id, market_id, provider, business_date, sha256, row_count, status, received_at)
         VALUES ($1, $2, $3, $4::date, $5, $6, 'received', $7::timestamptz) ON CONFLICT (provider, business_date, sha256) DO NOTHING RETURNING id`,
        [fileId, marketId, file.provider, file.businessDate, sha, lines.length, this.deps.now().toISOString()],
      );
      if (ins.rows.length === 0) return this.summaryOfExisting(tx, file.provider, file.businessDate, sha);
      const counts = { matched: 0, unmatched: 0, mismatch: 0 };
      let lineNo = 0;
      for (const line of lines) {
        lineNo += 1;
        const { match, intent, entryId } = await this.processLine(tx, marketId, file.provider, line);
        counts[match.status] += 1;
        await tx.query(
          `INSERT INTO psp_settlement_lines (id, file_id, market_id, provider, line_no, provider_ref, kind, amount_minor, fee_minor, currency, value_date, intent_id, matched_entry_id, status, detail)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::bigint, $9::bigint, $10, $11::date, $12, $13, $14, $15)`,
          [uuidv7(), fileId, marketId, file.provider, lineNo, line.providerRef, line.kind, line.amountMinor.toString(), line.feeMinor.toString(), line.currency, line.valueDate, intent?.id ?? null, entryId, match.status, match.detail],
        );
      }
      await tx.query("UPDATE psp_settlement_files SET status = $2 WHERE id = $1", [fileId, counts.unmatched + counts.mismatch === 0 ? "reconciled" : "parsed"]);
      return { fileId, duplicate: false, ...counts };
    });
  }

  /**
   * Re-runs matching for lines still unmatched or mismatched (a payment intent that was captured late, a corrected amount, an account that was
   * seeded since). Matched lines are never touched. The next reconciliation run resolves their exceptions.
   */
  async rematch(marketId: string): Promise<{ matched: number; stillOpen: number }> {
    return inJob(this.deps, marketId, "finance.reconcile", async (tx) => {
      const rows = await tx.query<{ id: string; provider: string; provider_ref: string; kind: SettlementLineInput["kind"]; amount: string; fee: string; currency: string; value_date: string }>(
        `SELECT id, provider, provider_ref, kind, amount_minor::text AS amount, fee_minor::text AS fee, currency, value_date::text AS value_date
           FROM psp_settlement_lines WHERE status <> 'matched' ORDER BY value_date, id`,
      );
      let matched = 0;
      let stillOpen = 0;
      for (const r of rows.rows) {
        const line: SettlementLineInput = { providerRef: r.provider_ref, kind: r.kind, amountMinor: BigInt(r.amount), feeMinor: BigInt(r.fee), currency: r.currency, valueDate: r.value_date };
        const { match, intent, entryId } = await this.processLine(tx, marketId, r.provider, line);
        if (match.status === "matched") matched += 1;
        else stillOpen += 1;
        await tx.query("UPDATE psp_settlement_lines SET status = $2, detail = $3, intent_id = $4, matched_entry_id = $5 WHERE id = $1", [r.id, match.status, match.detail, intent?.id ?? null, entryId]);
      }
      return { matched, stillOpen };
    });
  }

  private async summaryOfExisting(tx: Queryable, provider: string, businessDate: string, sha: Buffer): Promise<ImportSummary> {
    const f = await tx.query<{ id: string }>("SELECT id FROM psp_settlement_files WHERE provider = $1 AND business_date = $2::date AND sha256 = $3", [provider, businessDate, sha]);
    const id = f.rows[0]?.id ?? "";
    const c = await tx.query<{ status: "matched" | "unmatched" | "mismatch"; n: string }>("SELECT status, count(*)::text AS n FROM psp_settlement_lines WHERE file_id = $1 GROUP BY status", [id]);
    const n = (s: string): number => Number(c.rows.find((r) => r.status === s)?.n ?? "0");
    return { fileId: id, duplicate: true, matched: n("matched"), unmatched: n("unmatched"), mismatch: n("mismatch") };
  }

  private async processLine(tx: Queryable, marketId: string, provider: string, line: SettlementLineInput): Promise<{ match: LineMatch; intent: IntentView | undefined; entryId: string | null }> {
    let intent: IntentView | undefined;
    if (line.kind === "capture" || line.kind === "refund") {
      const r = await tx.query<IntentDb>(
        "SELECT id, provider, amount_minor::text AS amount_minor, currency, status FROM payment_intents WHERE provider = $1 AND provider_ref = $2",
        [provider, line.providerRef],
      );
      const row = r.rows[0];
      if (row) intent = { id: row.id, provider: row.provider, amountMinor: BigInt(row.amount_minor), currency: row.currency, status: row.status };
    }
    const match = matchSettlementLine({ kind: line.kind, amountMinor: line.amountMinor, currency: line.currency }, intent);
    if (match.status !== "matched") return { match, intent, entryId: null };
    if (line.currency !== this.deps.currency) return { match: { status: "mismatch", detail: "currency_differs" }, intent, entryId: null };
    try {
      const { entryId } = await Ledger.post(tx, settlementDraft({ marketId, currency: this.deps.currency, provider, line, intentId: intent?.id ?? null }));
      return { match, intent, entryId };
    } catch (e) {
      if (e instanceof LedgerError) return { match: { status: "mismatch", detail: e.code.toLowerCase().slice(0, 100) }, intent, entryId: null };
      if (e instanceof PayoutsError) return { match: { status: "mismatch", detail: "invalid_line" }, intent, entryId: null };
      throw e;
    }
  }
}
