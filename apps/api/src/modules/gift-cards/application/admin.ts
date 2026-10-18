import { admin } from "@outlet/domain";
import { next, paidTotal } from "../domain/bridge";
import type { CardView, KeysetPos, PotRecord, VoidApprovalPort } from "../domain/ports";
import { cardEvent, cardView, type GiftCardDeps } from "./shared";

export type AdminVoidResult =
  | { readonly kind: "ok"; readonly card: CardView; readonly refundedAmount: bigint; readonly refund: "completed" | "pending" | "none"; readonly replayed: boolean }
  | { readonly kind: "not_found" }
  | { readonly kind: "not_voidable" }
  | { readonly kind: "approval_required" }
  | { readonly kind: "invalid_reason" }
  | { readonly kind: "conflict" };

/**
 * Admin void (any state that can still be spent: ISSUED or DELIVERED). Reason coded, audited, and
 * dual approved at or above the refund threshold. The unredeemed remainder is refunded to the
 * original payment method through the payments port (RefundRouter); the `gift_card.voided` outbox
 * event drives the ledger reversal of the remaining liability. Replaying a void returns the same card.
 */
export class AdminVoidGiftCard {
  constructor(
    private readonly d: GiftCardDeps,
    private readonly approvals: VoidApprovalPort,
    private readonly cfg: admin.ApprovalConfig = admin.DEFAULT_APPROVAL_CONFIG,
  ) {}

  async execute(input: { readonly actorId: string; readonly cardId: string; readonly reasonCode: string; readonly approvalId: string | null }): Promise<AdminVoidResult> {
    const d = this.d;
    if (!admin.isAdminReasonCode(input.reasonCode)) return { kind: "invalid_reason" };
    const card = await d.store.getCard(input.cardId);
    if (card === null) return { kind: "not_found" };
    if (card.status === "VOIDED") return { kind: "ok", card: cardView(card), refundedAmount: 0n, refund: "none", replayed: true };
    if (card.status !== "ISSUED" && card.status !== "DELIVERED") return { kind: "not_voidable" };
    const nowMs = d.clock.nowMs();
    if (admin.requiresDualApproval("refund", card.remaining, this.cfg)) {
      if (input.approvalId === null) return { kind: "approval_required" };
      const rec = await this.approvals.find(input.approvalId);
      const covered =
        rec !== null &&
        rec.requesterId === input.actorId &&
        admin.approvalCovers(rec, { kind: "refund", subjectType: "gift_card", subjectId: card.id, amountMinor: card.remaining }, nowMs);
      if (!covered) return { kind: "approval_required" };
      if (!(await this.approvals.consume(input.approvalId))) return { kind: "approval_required" };
    }
    const to = next(card.status, "VOID", { nowMs, expiresAtMs: card.expiresAtMs });
    const r = await d.store.updateCard(card.id, card.version, { status: to }, [
      cardEvent(card, "gift_card.voided", {
        refund_amount: Number(card.remaining),
        payment_intent_id: card.paymentIntentId,
        by_admin: true,
        reason_code: input.reasonCode,
      }),
    ]);
    if (r.kind === "not_found") return { kind: "not_found" };
    if (r.kind === "conflict") return { kind: "conflict" };
    await d.audit.record({ action: "gift_card.admin_voided", actorId: input.actorId, targetId: card.id, outcome: "ok", deviceHash: null, ipHash: null, atMs: nowMs });
    let refund: "completed" | "pending" | "none" = "none";
    if (card.paymentIntentId !== null && card.remaining > 0n) {
      try {
        const res = await d.payments.refund({ paymentIntentId: card.paymentIntentId, amount: card.remaining, idempotencyKey: `gift-card-void:${card.id}` });
        refund = res.ok ? "completed" : "pending";
      } catch {
        refund = "pending";
      }
    }
    return { kind: "ok", card: cardView(r.card), refundedAmount: card.remaining, refund, replayed: false };
  }
}

export interface AdminPotRow {
  readonly pot: PotRecord;
  readonly paid: bigint;
  readonly pending: bigint;
  readonly refunded: bigint;
  readonly refundFailedCount: number;
  readonly discrepancy: "funded_below_target" | "paid_after_refund" | "refund_failed" | "overdue_close" | null;
}

export class ListAdminPots {
  constructor(private readonly d: GiftCardDeps) {}
  async execute(after: KeysetPos | null, limit: number): Promise<{ readonly rows: readonly AdminPotRow[]; readonly next: KeysetPos | null }> {
    const pots = await this.d.store.listPotsPage(after, limit + 1);
    const page = pots.slice(0, limit);
    const nowMs = this.d.clock.nowMs();
    const rows: AdminPotRow[] = [];
    for (const pot of page) {
      const cs = await this.d.store.listContributions(pot.id);
      const sum = (s: string): bigint => cs.filter((c) => c.status === s).reduce((a, c) => a + c.amount, 0n);
      const paid = paidTotal(cs);
      const refundFailedCount = cs.filter((c) => c.status === "refund_failed").length;
      let discrepancy: AdminPotRow["discrepancy"] = null;
      if (refundFailedCount > 0) discrepancy = "refund_failed";
      else if (pot.status === "CLOSED_FUNDED" && paid < pot.target) discrepancy = "funded_below_target";
      else if (pot.status === "REFUNDED" && paid > 0n) discrepancy = "paid_after_refund";
      else if (pot.status === "OPEN" && pot.closesAtMs + 3_600_000 < nowMs) discrepancy = "overdue_close";
      rows.push({ pot, paid, pending: sum("pending"), refunded: sum("refunded"), refundFailedCount, discrepancy });
    }
    const last = page[page.length - 1];
    return { rows, next: pots.length > limit && last !== undefined ? { ms: last.createdAtMs, id: last.id } : null };
  }
}

export class ListThrottleEvents {
  constructor(private readonly d: GiftCardDeps) {}
  async execute(after: KeysetPos | null, limit: number) {
    const rows = await this.d.store.listThrottledAttempts(after, limit + 1);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return { rows: page, next: rows.length > limit && last !== undefined ? { ms: last.atMs, id: last.id } : null };
  }
}
