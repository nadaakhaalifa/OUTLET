import { aggregateStatus, refundMachine, type RefundState } from "../domain/bridge";
import type {
  CommittedRefunds,
  IntakeOutcome,
  LegTransition,
  RefundEvent,
  RefundLegRecord,
  RefundRecord,
  RefundStore,
} from "../domain/ports";

/** Reference implementation of RefundStore. The contract suite runs against this and Kysely. */
export class InMemoryRefundStore implements RefundStore {
  private readonly refunds = new Map<string, RefundRecord>();
  private readonly inbox = new Set<string>();
  private readonly byKey = new Map<string, string>();
  readonly events: RefundEvent[] = [];
  readonly attempts: { legId: string; no: number; outcome: string; code: string | null }[] = [];

  async committedForSellerOrder(sellerOrderId: string): Promise<CommittedRefunds> {
    const byLine = new Map<string, bigint>();
    const byTender = new Map<string, bigint>();
    const idempotencyKeys = new Set<string>();
    let count = 0;
    let fee = 0n;
    for (const r of this.refunds.values()) {
      if (r.sellerOrderId !== sellerOrderId || r.status === "CANCELLED") continue;
      count += 1;
      fee += r.deliveryFeeTotal;
      idempotencyKeys.add(r.idempotencyKey);
      for (const l of r.lines) byLine.set(l.orderLineId, (byLine.get(l.orderLineId) ?? 0n) + l.itemAmount);
      for (const l of r.legs) byTender.set(l.tenderId, (byTender.get(l.tenderId) ?? 0n) + l.amount);
    }
    return { count, byLine, byTender, idempotencyKeys, fee };
  }

  async acknowledgeExisting(input: { consumer: string; messageId: string }): Promise<"exists" | "duplicate"> {
    const inbox = `${input.consumer}:${input.messageId}`;
    if (this.inbox.has(inbox)) return "duplicate";
    this.inbox.add(inbox);
    return "exists";
  }

  async intake(input: { consumer: string; messageId: string; refund: RefundRecord; expectedCommitted: number }): Promise<IntakeOutcome> {
    const inbox = `${input.consumer}:${input.messageId}`;
    if (this.inbox.has(inbox)) return "duplicate";
    // Synchronous from here to the write: the compare-and-set that serialises intents per seller order.
    if (!this.byKey.has(input.refund.idempotencyKey)) {
      let count = 0;
      for (const r of this.refunds.values()) {
        if (r.sellerOrderId === input.refund.sellerOrderId && r.status !== "CANCELLED") count += 1;
      }
      if (count !== input.expectedCommitted) return "stale";
    }
    this.inbox.add(inbox);
    if (this.byKey.has(input.refund.idempotencyKey)) return "exists";
    this.refunds.set(input.refund.id, input.refund);
    this.byKey.set(input.refund.idempotencyKey, input.refund.id);
    this.events.push({
      type: "refund.requested",
      refundId: input.refund.id,
      userId: input.refund.userId,
      amount: input.refund.amount,
      returnId: input.refund.returnId,
    });
    return "created";
  }

  async reject(input: { consumer: string; messageId: string; returnId: string; reason: string }): Promise<"recorded" | "duplicate"> {
    const inbox = `${input.consumer}:${input.messageId}`;
    if (this.inbox.has(inbox)) return "duplicate";
    this.inbox.add(inbox);
    this.events.push({ type: "refund.intent_rejected", returnId: input.returnId, reason: input.reason });
    return "recorded";
  }

  async get(id: string): Promise<RefundRecord | null> {
    return this.refunds.get(id) ?? null;
  }

  async findByProviderRef(provider: string, providerRef: string): Promise<{ refundId: string; leg: RefundLegRecord } | null> {
    for (const r of this.refunds.values()) {
      const leg = r.legs.find(
        (l) => l.providerRef === providerRef && (l.tender.psp ?? l.tender.provider ?? l.tender.courier) === provider,
      );
      if (leg !== undefined) return { refundId: r.id, leg };
    }
    return null;
  }

  async listForUser(
    userId: string,
    page: { after: { createdAtMs: number; id: string } | null; limit: number },
  ): Promise<readonly RefundRecord[]> {
    const rows = [...this.refunds.values()]
      .filter((r) => r.userId === userId)
      .sort((a, b) => b.requestedAtMs - a.requestedAtMs || (a.id < b.id ? 1 : -1));
    const after = page.after;
    const start =
      after === null
        ? 0
        : rows.findIndex((r) => r.requestedAtMs < after.createdAtMs || (r.requestedAtMs === after.createdAtMs && r.id < after.id));
    return start < 0 ? [] : rows.slice(start, start + page.limit);
  }

  async markLedgerPosted(refundId: string, nowMs: number): Promise<void> {
    const r = this.refunds.get(refundId);
    if (r === undefined || r.ledgerPostedAtMs !== null) return;
    const legs = r.legs.map((l) =>
      l.state === "REQUESTED" ? { ...l, state: refundMachine.transition("REQUESTED", "POST_LEDGER", { attempts: 0 }) as RefundState } : l,
    );
    this.put({ ...r, legs, status: aggregateStatus(legs.map((l) => l.state)), ledgerPostedAtMs: nowMs, initiatedAtMs: nowMs });
    this.events.push({ type: "refund.approved", refundId, userId: r.userId });
  }

  async transitionLeg(t: LegTransition): Promise<"applied" | "stale"> {
    for (const r of this.refunds.values()) {
      const leg = r.legs.find((l) => l.id === t.legId);
      if (leg === undefined) continue;
      if (leg.state !== t.from) return "stale";
      const next: RefundLegRecord = {
        ...leg,
        state: t.to,
        attempts: t.attempts,
        nextAttemptAtMs: t.nextAttemptAtMs,
        providerRef: t.providerRef === undefined ? leg.providerRef : t.providerRef,
        failureCode: t.failureCode,
      };
      if (t.attempt !== undefined) this.attempts.push({ legId: t.legId, no: t.attempt.no, outcome: t.attempt.outcome, code: t.attempt.code });
      const legs = r.legs.map((l) => (l.id === leg.id ? next : l));
      const before = r.status;
      const status = aggregateStatus(legs.map((l) => l.state));
      this.put({
        ...r,
        legs,
        status,
        completedAtMs: status === "COMPLETED" ? (r.completedAtMs ?? t.nowMs) : r.completedAtMs,
      });
      if (t.to === "FAILED") {
        this.events.push({ type: "refund.failed", refundId: r.id, legId: leg.id, code: t.failureCode ?? "unknown", attempts: t.attempts });
      }
      if (t.to === "MANUAL_REVIEW" && t.from !== "MANUAL_REVIEW") {
        this.events.push({ type: "refund.manual_review", refundId: r.id, legId: leg.id, code: t.failureCode ?? "unknown" });
      }
      if (status === "COMPLETED" && before !== "COMPLETED") {
        this.events.push({ type: "refund.completed", refundId: r.id, userId: r.userId, amount: r.amount, returnId: r.returnId });
      }
      return "applied";
    }
    return "stale";
  }

  async listActionable(nowMs: number, limit: number): Promise<readonly string[]> {
    const out: { id: string; at: number }[] = [];
    for (const r of this.refunds.values()) {
      if (r.status === "COMPLETED" || r.status === "CANCELLED") continue;
      const due =
        r.ledgerPostedAtMs === null ||
        r.legs.some(
          (l) =>
            l.state === "LEDGER_POSTED" ||
            (l.state === "FAILED" && (l.nextAttemptAtMs === null || l.nextAttemptAtMs <= nowMs)),
        );
      if (due) out.push({ id: r.id, at: r.requestedAtMs });
    }
    return out.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1)).slice(0, limit).map((x) => x.id);
  }

  private put(r: RefundRecord): void {
    this.refunds.set(r.id, { ...r, version: r.version + 1 });
  }
}
