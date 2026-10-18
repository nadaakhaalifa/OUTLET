import { ineligibleReason, type Clawback, type PayableItem } from "./bridge";

/**
 * Seller-visible store balance (ADR-0021, ADR-0050). All amounts are integer piastres.
 *
 *  - available: closed past the hold window, no open dispute, not in a payout, net of outstanding
 *    clawbacks (same netting as the payout planner, minimum payout ignored), and never above what the
 *    ledger `seller_payable` account actually owes.
 *  - pending_release: not yet closed, or inside the post-close hold window.
 *  - held: payouts ON_HOLD plus orders with an open dispute. ONE total: no reason is exposed
 *    (VR-DB-02 safe default; ADR-0049 decides visibility).
 *  - in_transit: payouts already cut for the store and not yet settled (SCHEDULED, APPROVED, SENT, and
 *    FAILED while it is retried). Amount only: no date, no status, no reason (VR-DB-02).
 *  - negative_carry: clawbacks the available amount could not absorb, and any negative ledger balance.
 *
 * Eligibility order (`ineligibleReason`): not closed, then post-close window, then open dispute. So an
 * open dispute on an order that is not CLOSED yet, or still inside the window, counts as pending_release,
 * not held; only a closed, past-window order with an open dispute counts as held.
 */
export interface StoreBalance {
  readonly available: bigint;
  readonly pendingRelease: bigint;
  readonly held: bigint;
  readonly inTransit: bigint;
  readonly negativeCarry: bigint;
}

export interface StoreBalanceInput {
  readonly storeId: string;
  readonly nowMs: number;
  /** Source items NOT already inside an active payout. */
  readonly items: readonly PayableItem[];
  /** Clawbacks with the amount still outstanding (full minus applied). */
  readonly clawbacks: readonly Clawback[];
  /** Sum of the amounts of this store's payouts in ON_HOLD. */
  readonly heldPayoutTotal: bigint;
  /** Sum of the amounts of this store's payouts in SCHEDULED, APPROVED, SENT or FAILED. */
  readonly inTransitPayoutTotal: bigint;
  /** Natural ledger balance of seller_payable (positive = owed to the seller). */
  readonly ledgerPayable: bigint;
}

export function computeStoreBalance(i: StoreBalanceInput): StoreBalance {
  let pending = 0n;
  let disputed = 0n;
  let eligible = 0n;
  for (const item of i.items) {
    if (item.net <= 0n) continue;
    const reason = ineligibleReason(item, i.storeId, i.nowMs);
    if (reason === null) eligible += item.net;
    else if (reason === "not_closed" || reason === "hold_window") pending += item.net;
    else if (reason === "open_dispute") disputed += item.net;
  }
  let owed = 0n;
  for (const c of i.clawbacks) if (c.storeId === i.storeId && c.amount > 0n) owed += c.amount;
  const net = eligible - owed;
  const ceiling = i.ledgerPayable > 0n ? i.ledgerPayable : 0n;
  const capped = net > 0n ? net : 0n;
  // A negative ledger balance means the seller owes: it counts even when the clawback list is empty.
  let carry = net < 0n ? -net : 0n;
  if (i.ledgerPayable < 0n && -i.ledgerPayable > carry) carry = -i.ledgerPayable;
  return {
    available: capped < ceiling ? capped : ceiling,
    pendingRelease: pending,
    held: disputed + i.heldPayoutTotal,
    inTransit: i.inTransitPayoutTotal,
    negativeCarry: carry,
  };
}
