import type { PayoutRecord } from "../domain/ports";
import type { Statement } from "../domain/bridge";
import type { PayoutSummary, StatementView, StoreBalanceView } from "../application/queries";

const iso = (ms: number): string => new Date(ms).toISOString();
const isoOrNull = (ms: number | null): string | null => (ms === null ? null : iso(ms));
export const moneyWire = (amount: bigint): { amount: string; currency: "EGP" } => ({ amount: amount.toString(), currency: "EGP" });

/** What a seller sees. Hold reasons, approvals, tokens and ledger refs are staff only. */
export function sellerPayoutWire(p: PayoutRecord) {
  return {
    id: p.id,
    store_id: p.storeId,
    cycle_key: p.cycleKey,
    status: p.status,
    amount: moneyWire(p.amount),
    eligible_total: moneyWire(p.eligibleTotal),
    netted_total: moneyWire(p.nettedTotal),
    carry_forward: moneyWire(p.carryForward),
    line_count: p.lineCount,
    iban_last4: p.ibanLast4,
    sent_at: isoOrNull(p.sentAtMs),
    settled_at: isoOrNull(p.settledAtMs),
    created_at: iso(p.createdAtMs),
  };
}

export function adminPayoutWire(p: PayoutRecord) {
  return {
    ...sellerPayoutWire(p),
    cutoff_at: iso(p.cutoffAtMs),
    hold_reason: p.holdReason,
    approval_id: p.approvalId,
    approved_by: p.approvedBy,
    approved_at: isoOrNull(p.approvedAtMs),
    attempts: p.attempts,
    failure_code: p.failureCode,
    ledger_ref: p.ledgerRef,
    provider_ref: p.providerRef,
    version: p.version,
    updated_at: iso(p.updatedAtMs),
    lines: p.lines.map((l) => ({ source_type: l.sourceType, source_id: l.sourceId, amount: moneyWire(l.amount) })),
  };
}

function statementWire(s: Statement) {
  return {
    store_id: s.storeId,
    from: iso(s.fromMs),
    to: iso(s.toMs),
    opening_balance: moneyWire(s.opening),
    closing_balance: moneyWire(s.closing),
    totals: {
      merchandise: moneyWire(s.totals.merchandise),
      commission: moneyWire(s.totals.commission),
      vat_on_commission: moneyWire(s.totals.vatOnCommission),
      adjustments: moneyWire(s.totals.adjustments),
      payouts: moneyWire(s.totals.payouts),
      net: moneyWire(s.totals.net),
    },
    lines: s.lines.map((l) => ({
      id: l.id,
      type: l.type,
      at: iso(l.atMs),
      merchandise: moneyWire(l.merchandise),
      commission: moneyWire(l.commission),
      vat_on_commission: moneyWire(l.vatOnCommission),
      adjustment: moneyWire(l.adjustment),
      net: moneyWire(l.net),
      balance_after: moneyWire(l.balanceAfter),
    })),
  };
}

export function statementViewWire(v: StatementView) {
  return {
    ...statementWire(v.statement),
    payouts: v.payouts.map((p) => ({
      id: p.id,
      cycle_key: p.cycleKey,
      status: p.status,
      amount: moneyWire(p.amount),
      eligible_total: moneyWire(p.eligibleTotal),
      netted_total: moneyWire(p.nettedTotal),
      carry_forward: moneyWire(p.carryForward),
    })),
  };
}

export function payoutSummaryWire(v: PayoutSummary) {
  return {
    as_of: iso(v.asOfMs),
    next_cycle_at: iso(v.nextCycleAtMs),
    by_state: Object.fromEntries(
      Object.entries(v.byState).map(([k, t]) => [
        k,
        {
          count: t.count,
          amount: moneyWire(t.amount),
          oldest_updated_at: isoOrNull(t.oldestUpdatedAtMs),
          ...(t.byHoldReason !== undefined ? { by_hold_reason: t.byHoldReason } : {}),
          ...(t.byFailureCode !== undefined ? { by_failure_code: t.byFailureCode } : {}),
        },
      ]),
    ),
    settled_window_days: v.settledWindowDays,
  };
}

/** Seller balance wire. No hold reason, no next payout date (VR-DB-02 safe default). */
export function storeBalanceWire(b: StoreBalanceView) {
  return {
    available: moneyWire(b.available),
    pending_release: moneyWire(b.pendingRelease),
    held: moneyWire(b.held),
    in_transit: moneyWire(b.inTransit),
    negative_carry: moneyWire(b.negativeCarry),
    as_of: iso(b.asOfMs),
  };
}
