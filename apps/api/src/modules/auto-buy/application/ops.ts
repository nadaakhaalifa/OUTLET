import { idempotencyKeyFor, nextAttemptState } from "../domain/bridge";
import type { AttemptRecord, MitLookup } from "../domain/ports";
import { releaseHold, type AutoBuyDeps } from "./shared";

export type ManualReviewResolution = "confirm_purchased" | "confirm_not_charged";

export interface ResolveInput {
  readonly attemptId: string;
  readonly resolution: ManualReviewResolution;
  /** Required for `confirm_purchased` unless the PSP lookup itself now answers `placed`. */
  readonly orderGroupId: string | null;
  /** PSP evidence pointer (settlement or dashboard reference). Stored in the 64 char failure_reason column. */
  readonly pspReference: string;
  readonly resolverId: string;
}

export type ResolveResult =
  | { readonly kind: "resolved"; readonly outcome: "purchased" | "not_charged"; readonly attempt: AttemptRecord }
  | { readonly kind: "not_found" }
  | { readonly kind: "not_in_review"; readonly state: AttemptRecord["state"] }
  | { readonly kind: "order_group_required" }
  /** The PSP lookup now gives a definitive answer that contradicts the operator. */
  | { readonly kind: "evidence_conflict" };

/**
 * Operator queue for attempts parked in MANUAL_REVIEW (the PSP outcome could not be established).
 * A resolution is terminal and evidence based: it can only confirm what the PSP shows. Before it
 * acts, the lookup by idempotency key is re-run; a definitive answer that contradicts the operator
 * is refused (a late success is never overwritten with "not charged", nor the reverse).
 * No code path here reaches the merchant-initiated charge port.
 */
export class ManualReviewQueue {
  constructor(private readonly d: AutoBuyDeps) {}

  list(limit: number): Promise<readonly AttemptRecord[]> {
    return this.d.store.manualReview(Math.min(Math.max(limit, 1), 50));
  }

  async resolve(input: ResolveInput): Promise<ResolveResult> {
    const d = this.d;
    const first = await d.store.run((tx) => tx.getAttemptForUpdate(input.attemptId));
    if (first === null) return { kind: "not_found" };
    if (first.state !== "MANUAL_REVIEW") return { kind: "not_in_review", state: first.state };

    let found: MitLookup | null;
    try {
      found = await d.mit.lookup(idempotencyKeyFor(first.mandateId, first.priceEventId));
    } catch {
      found = null; // unknown: the operator's evidence stands
    }
    let orderGroupId = input.orderGroupId;
    if (input.resolution === "confirm_purchased") {
      if (found?.kind === "failed") return { kind: "evidence_conflict" };
      if (found?.kind === "placed") {
        if (orderGroupId !== null && orderGroupId !== found.orderGroupId) return { kind: "evidence_conflict" };
        orderGroupId = found.orderGroupId;
      }
      if (orderGroupId === null) return { kind: "order_group_required" };
    } else if (found?.kind === "placed") {
      return { kind: "evidence_conflict" };
    }

    const now = d.clock.nowMs();
    const ref = input.pspReference.slice(0, 40);
    const done = await d.store.run(async (tx): Promise<ResolveResult> => {
      const a = await tx.getAttemptForUpdate(input.attemptId);
      if (a === null) return { kind: "not_found" };
      if (a.state !== "MANUAL_REVIEW") return { kind: "not_in_review", state: a.state };
      if (input.resolution === "confirm_purchased" && orderGroupId !== null) {
        const next: AttemptRecord = {
          ...a,
          state: nextAttemptState(a.state, "CHARGE_SUCCEEDED"),
          orderGroupId,
          failureReason: `ops_purchased:${ref}`,
          updatedAtMs: now,
        };
        await tx.updateAttempt(next);
        const m = await tx.getMandateForUpdate(a.mandateId);
        if (m !== null && m.status === "ARMED") await tx.closeMandate(m.id, "PURCHASED", "purchased", now);
        await tx.emit([
          { type: "auto_buy.charged", userId: a.userId, mandateId: a.mandateId, attemptId: a.id, orderGroupId },
          { type: "auto_buy.manual_review_resolved", userId: a.userId, mandateId: a.mandateId, attemptId: a.id, resolution: "purchased", resolverId: input.resolverId },
        ]);
        return { kind: "resolved", outcome: "purchased", attempt: next };
      }
      const next: AttemptRecord = {
        ...a,
        state: nextAttemptState(a.state, "CHARGE_FAILED"),
        failureReason: `ops_not_charged:${ref}`,
        updatedAtMs: now,
      };
      await tx.updateAttempt(next);
      await tx.emit([
        { type: "auto_buy.failed", userId: a.userId, mandateId: a.mandateId, attemptId: a.id, reason: "ops_confirmed_not_charged" },
        { type: "auto_buy.manual_review_resolved", userId: a.userId, mandateId: a.mandateId, attemptId: a.id, resolution: "not_charged", resolverId: input.resolverId },
      ]);
      return { kind: "resolved", outcome: "not_charged", attempt: next };
    });
    if (done.kind !== "resolved") return done;
    if (done.outcome === "not_charged") await releaseHold(d, first.id);
    try {
      await d.notices.send({
        userId: first.userId,
        kind: done.outcome === "purchased" ? "charged" : "not_charged",
        attemptId: first.id,
        mandateId: first.mandateId,
        cancelDeadlineMs: null,
      });
    } catch {
      // The outcome is recorded and emitted; a missed courtesy notice is not a reason to fail the resolution.
    }
    return done;
  }
}
