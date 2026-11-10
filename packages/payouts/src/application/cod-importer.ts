import { createHash } from "node:crypto";
import type { Queryable } from "@outlet/db";
import { uuidv7 } from "@outlet/ids";
import { Ledger } from "@outlet/ledger";
import { money } from "@outlet/money";
import { z } from "zod";
import { PayoutsError } from "../domain/errors.js";
import { BANK_OWNER, acct } from "./accounts.js";
import { inJob } from "./shared.js";
import type { FinanceDeps } from "./shared.js";

const Piastres = z.string().regex(/^\d{1,18}$/);
export const CodRemittanceSchema = z.strictObject({
  courier: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  remittanceRef: z.string().min(1).max(200),
  businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** What the courier actually transferred to the bank (piastres). Must equal collected minus fees, or nothing is posted. */
  declaredNetMinor: Piastres,
  lines: z.array(z.strictObject({
    awb: z.string().min(1).max(100),
    sellerOrderId: z.uuid().nullable(),
    collectedMinor: Piastres,
    feeMinor: Piastres.default("0"),
  })).min(1).max(20_000),
});
export type CodRemittanceInput = z.input<typeof CodRemittanceSchema>;

export interface CodImportSummary {
  readonly remittanceId: string;
  readonly duplicate: boolean;
  readonly status: "reconciled" | "mismatch" | "received";
  readonly matched: number;
  readonly unmatched: number;
  readonly mismatch: number;
  readonly entryId: string | null;
}

interface OrderDb { id: string; total_minor: string; currency: string; method: string | null; has_entry: boolean }

/**
 * Imports a courier COD remittance (chart 4.3): each line is matched to a delivered COD seller order (cash = order total, the
 * order_delivered_cod entry must exist: I15). One courier_remitted entry per remittance posts the matched lines:
 *   Dr bank_collections (collected - fee), Dr courier_payable (fee) / Cr cod_clearing:{courier} (collected).
 * If the courier's declared net differs from the lines, nothing is posted and the remittance is flagged for Finance.
 */
export class CodRemittanceImporter {
  constructor(private readonly deps: FinanceDeps) {}

  async import(marketId: string, raw: CodRemittanceInput): Promise<CodImportSummary> {
    const parsed = CodRemittanceSchema.safeParse(raw);
    if (!parsed.success) throw new PayoutsError("INVALID_INPUT", `cod remittance: ${parsed.error.issues[0]?.message ?? "invalid"}`);
    const r = parsed.data;
    const cur = this.deps.currency;
    const lines = r.lines.map((l) => ({ ...l, collected: BigInt(l.collectedMinor), fee: BigInt(l.feeMinor) }));
    const gross = lines.reduce((s, l) => s + l.collected, 0n);
    const fees = lines.reduce((s, l) => s + l.fee, 0n);
    if (fees > gross) throw new PayoutsError("INVALID_INPUT", "fees exceed collected cash");
    const totalsOk = gross - fees === BigInt(r.declaredNetMinor);
    const sha = createHash("sha256").update(JSON.stringify(r)).digest();
    return inJob(this.deps, marketId, "finance.reconcile", async (tx) => {
      const id = uuidv7();
      const ins = await tx.query(
        `INSERT INTO cod_remittances (id, market_id, courier, remittance_ref, business_date, currency, gross_minor, fee_minor, net_minor, sha256, status, received_at)
         VALUES ($1, $2, $3, $4, $5::date, $6, $7::bigint, $8::bigint, $9::bigint, $10, $11, $12::timestamptz) ON CONFLICT (courier, remittance_ref) DO NOTHING RETURNING id`,
        [id, marketId, r.courier, r.remittanceRef, r.businessDate, cur, gross.toString(), fees.toString(), r.declaredNetMinor, sha, totalsOk ? "received" : "mismatch", this.deps.now().toISOString()],
      );
      if (ins.rows.length === 0) return this.existing(tx, r.courier, r.remittanceRef);
      const counts = { matched: 0, unmatched: 0, mismatch: 0 };
      let matchedCollected = 0n;
      let matchedFee = 0n;
      let lineNo = 0;
      for (const l of lines) {
        lineNo += 1;
        const { status, detail } = await this.matchLine(tx, l.sellerOrderId, l.collected, cur);
        counts[status] += 1;
        if (status === "matched") {
          matchedCollected += l.collected;
          matchedFee += l.fee;
        }
        await tx.query(
          `INSERT INTO cod_remittance_lines (id, remittance_id, market_id, line_no, awb, seller_order_id, collected_minor, fee_minor, currency, status, detail)
           VALUES ($1, $2, $3, $4, $5, $6, $7::bigint, $8::bigint, $9, $10, $11)`,
          [uuidv7(), id, marketId, lineNo, l.awb, l.sellerOrderId, l.collected.toString(), l.fee.toString(), cur, status, detail],
        );
      }
      let entryId: string | null = null;
      if (totalsOk && matchedCollected > 0n && matchedFee <= matchedCollected) {
        const postings = [
          ...(matchedCollected - matchedFee > 0n ? [{ accountCode: acct("bank_collections", marketId, cur, BANK_OWNER), amount: money(matchedCollected - matchedFee, cur) }] : []),
          ...(matchedFee > 0n ? [{ accountCode: acct("courier_payable", marketId, cur, r.courier), amount: money(matchedFee, cur) }] : []),
          { accountCode: acct("cod_clearing", marketId, cur, r.courier), amount: money(-matchedCollected, cur) },
        ];
        entryId = (await Ledger.post(tx, {
          kind: "courier_remitted", idempotencyKey: `cod_remittance:${r.courier}:${r.remittanceRef}`, marketId, occurredAt: new Date(`${r.businessDate}T12:00:00.000Z`),
          ref: { type: "cod_remittance", id }, postings,
        })).entryId;
      }
      const status = !totalsOk ? "mismatch" : counts.unmatched + counts.mismatch === 0 ? "reconciled" : "received";
      await tx.query("UPDATE cod_remittances SET status = $2, matched_entry_id = $3 WHERE id = $1", [id, status, entryId]);
      return { remittanceId: id, duplicate: false, status, ...counts, entryId };
    });
  }

  private async existing(tx: Queryable, courier: string, ref: string): Promise<CodImportSummary> {
    const h = await tx.query<{ id: string; status: "reconciled" | "mismatch" | "received"; matched_entry_id: string | null }>(
      "SELECT id, status, matched_entry_id FROM cod_remittances WHERE courier = $1 AND remittance_ref = $2", [courier, ref]);
    const row = h.rows[0];
    const c = await tx.query<{ status: "matched" | "unmatched" | "mismatch"; n: string }>("SELECT status, count(*)::text AS n FROM cod_remittance_lines WHERE remittance_id = $1 GROUP BY status", [row?.id ?? ""]);
    const n = (s: string): number => Number(c.rows.find((x) => x.status === s)?.n ?? "0");
    return { remittanceId: row?.id ?? "", duplicate: true, status: row?.status ?? "received", matched: n("matched"), unmatched: n("unmatched"), mismatch: n("mismatch"), entryId: row?.matched_entry_id ?? null };
  }

  private async matchLine(tx: Queryable, sellerOrderId: string | null, collected: bigint, cur: string): Promise<{ status: "matched" | "unmatched" | "mismatch"; detail: string | null }> {
    if (sellerOrderId === null) return { status: "unmatched", detail: "no_order_reference" };
    const r = await tx.query<OrderDb>(
      `SELECT s.id, s.total_minor::text AS total_minor, s.currency, pi.method,
              EXISTS (SELECT 1 FROM journal_entries e WHERE e.idempotency_key = 'order_delivered_cod:' || s.id::text) AS has_entry
         FROM seller_orders s LEFT JOIN payment_intents pi ON pi.order_group_id = s.order_group_id WHERE s.id = $1`,
      [sellerOrderId],
    );
    const o = r.rows[0];
    if (!o) return { status: "unmatched", detail: "unknown_order" };
    if (o.method !== "cod") return { status: "mismatch", detail: "not_a_cod_order" };
    if (o.currency !== cur) return { status: "mismatch", detail: "currency_differs" };
    if (!o.has_entry) return { status: "unmatched", detail: "no_delivery_entry" };
    return BigInt(o.total_minor) === collected ? { status: "matched", detail: null } : { status: "mismatch", detail: "amount_differs" };
  }
}
