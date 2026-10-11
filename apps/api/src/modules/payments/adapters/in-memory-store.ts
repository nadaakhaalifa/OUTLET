import type { Clock } from "../../../platform/ports";
import {
  type InboxRef,
  type IntentMutation,
  type IntentPatch,
  type MutateResult,
  type PaymentIntentRecord,
  type PaymentStore,
  type RawEventRecord,
  type RefundInsert,
  type RefundRecord,
  type SavedCardRecord,
  type SettleRefundResult,
} from "../domain/ports";
import {
  decideRefundApplication,
  paymentIntentMachine,
  type PaymentDomainEvent,
  type PaymentIntentEvent,
  type PaymentIntentStatus,
} from "../domain/seam";
import { draftsFor, type OutboxDraft } from "./event-outbox";

const STATUS_EVENT: Readonly<Partial<Record<PaymentIntentStatus, PaymentIntentEvent>>> = {
  REQUIRES_ACTION: "REQUIRE_ACTION",
  AUTHORIZED: "AUTHORIZE",
  SUCCEEDED: "SUCCEED",
  FAILED: "FAIL",
  VOIDED: "VOID",
};

/**
 * In-memory PaymentStore. Same observable behaviour as the Kysely store (the shared contract suite
 * runs against both): unique keys, transition validation, inbox dedup, outbox appended with the
 * state change. Every method is a single synchronous critical section.
 */
export class InMemoryPaymentStore implements PaymentStore {
  private readonly intents = new Map<string, PaymentIntentRecord>();
  private readonly raw = new Map<string, RawEventRecord>();
  private readonly refunds = new Map<string, RefundRecord>();
  private readonly cards = new Map<string, SavedCardRecord & { deletedAtMs: number | null }>();
  private readonly inbox = new Set<string>();
  readonly outbox: OutboxDraft[] = [];

  constructor(
    private readonly clock: Clock,
    private readonly newId: () => string,
  ) {}

  // ---- test helpers -------------------------------------------------------------------------
  allRawEvents(): readonly RawEventRecord[] {
    return [...this.raw.values()];
  }
  allIntents(): readonly PaymentIntentRecord[] {
    return [...this.intents.values()];
  }
  outboxTypes(): string[] {
    return this.outbox.map((o) => o.type);
  }

  private emit(events: readonly PaymentDomainEvent[], fallbackAggregateId: string): void {
    this.outbox.push(...draftsFor(events, this.newId, this.clock.nowMs(), fallbackAggregateId));
  }

  private inboxKey(i: InboxRef): string {
    return `${i.consumer}\u0000${i.messageId}`;
  }

  // ---- intents ------------------------------------------------------------------------------
  async insertIntent(intent: PaymentIntentRecord, events: readonly PaymentDomainEvent[]) {
    for (const cur of this.intents.values()) {
      if (cur.orderGroupId === intent.orderGroupId) return { kind: "exists" as const, intent: cur };
    }
    this.intents.set(intent.id, intent);
    this.emit(events, intent.id);
    return { kind: "inserted" as const, intent };
  }

  async getIntent(id: string) {
    return this.intents.get(id) ?? null;
  }

  async getIntentByOrderGroup(orderGroupId: string) {
    for (const i of this.intents.values()) if (i.orderGroupId === orderGroupId) return i;
    return null;
  }

  async getIntentByProviderRef(provider: string, providerRef: string) {
    for (const i of this.intents.values()) if (i.provider === provider && i.providerRef === providerRef) return i;
    return null;
  }

  private applyPatch(cur: PaymentIntentRecord, patch: IntentPatch): PaymentIntentRecord {
    if (patch.status !== undefined && patch.status !== cur.status) {
      const ev = STATUS_EVENT[patch.status];
      const ok =
        ev !== undefined &&
        paymentIntentMachine.can(cur.status, ev, { amount: cur.amount, refunded: cur.refundedAmount, refundAmount: 0n });
      if (!ok) throw new Error(`illegal payment intent transition ${cur.status} -> ${patch.status}`);
    }
    if (patch.providerRef !== undefined && cur.providerRef !== null && patch.providerRef !== cur.providerRef) {
      throw new Error("payment intent provider reference is immutable once set");
    }
    if (patch.providerRef !== undefined && patch.providerRef !== null) {
      const provider = patch.provider ?? cur.provider;
      for (const o of this.intents.values()) {
        if (o.id !== cur.id && o.provider === provider && o.providerRef === patch.providerRef) {
          throw new Error("duplicate provider reference");
        }
      }
    }
    return { ...cur, ...patch, version: cur.version + 1, updatedAtMs: this.clock.nowMs() };
  }

  async mutateIntent(input: {
    readonly intentId: string;
    readonly decide: (current: PaymentIntentRecord) => IntentMutation | null;
    readonly inbox?: InboxRef;
    readonly rawEventId?: string;
  }): Promise<MutateResult> {
    const cur = this.intents.get(input.intentId);
    if (cur === undefined) return { kind: "not_found" };
    if (input.inbox !== undefined && this.inbox.has(this.inboxKey(input.inbox))) return { kind: "duplicate" };
    const raw = input.rawEventId === undefined ? undefined : this.raw.get(input.rawEventId);
    if (raw !== undefined && raw.processedAtMs !== null) return { kind: "duplicate" };
    const m = input.decide(cur);
    let next = cur;
    if (m !== null) {
      next = this.applyPatch(cur, m.patch);
      this.intents.set(cur.id, next);
      this.emit(m.events, cur.id);
    }
    if (input.inbox !== undefined) this.inbox.add(this.inboxKey(input.inbox));
    if (raw !== undefined) {
      this.raw.set(raw.id, { ...raw, processedAtMs: this.clock.nowMs(), processOutcome: m?.outcome ?? "noop" });
    }
    return { kind: "applied", intent: next, outcome: m?.outcome ?? "noop" };
  }

  async listExpirable(nowMs: number, limit: number) {
    return [...this.intents.values()]
      .filter((i) => (i.status === "CREATED" || i.status === "REQUIRES_ACTION") && i.expiresAtMs <= nowMs)
      .sort((a, b) => a.expiresAtMs - b.expiresAtMs)
      .slice(0, limit);
  }

  // ---- raw events ---------------------------------------------------------------------------
  async recordRawEvent(rec: RawEventRecord, events: readonly PaymentDomainEvent[] = []) {
    for (const r of this.raw.values()) {
      if (r.provider === rec.provider && r.eventId === rec.eventId) return "duplicate" as const;
    }
    this.raw.set(rec.id, rec);
    this.emit(events, rec.id);
    if (rec.signatureOk) {
      this.outbox.push({
        id: this.newId(),
        type: "payment.webhook_received",
        aggregateType: "payment_event",
        aggregateId: rec.id,
        occurredAtMs: this.clock.nowMs(),
        payload: { raw_event_id: rec.id, provider: rec.provider },
      });
    }
    return "stored" as const;
  }

  async getRawEvent(id: string) {
    return this.raw.get(id) ?? null;
  }

  async listUnprocessedEventIds(limit: number) {
    return [...this.raw.values()]
      .filter((r) => r.signatureOk && r.processedAtMs === null)
      .sort((a, b) => a.receivedAtMs - b.receivedAtMs)
      .slice(0, limit)
      .map((r) => r.id);
  }

  async settleRawEvent(input: {
    readonly rawEventId: string;
    readonly outcome: string;
    readonly events: readonly PaymentDomainEvent[];
    readonly inbox?: InboxRef;
  }) {
    const raw = this.raw.get(input.rawEventId);
    if (raw === undefined) return "not_found" as const;
    if (input.inbox !== undefined && this.inbox.has(this.inboxKey(input.inbox))) return "duplicate" as const;
    if (raw.processedAtMs !== null) return "duplicate" as const;
    this.emit(input.events, raw.id);
    if (input.inbox !== undefined) this.inbox.add(this.inboxKey(input.inbox));
    this.raw.set(raw.id, { ...raw, processedAtMs: this.clock.nowMs(), processOutcome: input.outcome });
    return "settled" as const;
  }

  // ---- refunds ------------------------------------------------------------------------------
  async insertRefund(rec: RefundRecord): Promise<RefundInsert> {
    for (const r of this.refunds.values()) {
      if (r.intentId === rec.intentId && r.idempotencyKey === rec.idempotencyKey) return { kind: "exists", refund: r };
    }
    const intent = this.intents.get(rec.intentId);
    if (intent === undefined || (intent.status !== "SUCCEEDED" && intent.status !== "PARTIALLY_REFUNDED")) {
      return { kind: "not_refundable" };
    }
    let committed = 0n;
    for (const r of this.refunds.values()) {
      if (r.intentId === rec.intentId && r.status !== "failed") committed += r.amount;
    }
    if (committed + rec.amount > intent.amount) return { kind: "exceeds_captured" };
    this.refunds.set(rec.id, rec);
    return { kind: "inserted", refund: rec };
  }

  async getRefundByKey(intentId: string, idempotencyKey: string) {
    for (const r of this.refunds.values()) if (r.intentId === intentId && r.idempotencyKey === idempotencyKey) return r;
    return null;
  }

  async getRefundByProviderRef(providerRefundRef: string) {
    for (const r of this.refunds.values()) if (r.providerRefundRef === providerRefundRef) return r;
    return null;
  }

  async findPendingRefunds(intentId: string, amount: bigint) {
    return [...this.refunds.values()]
      .filter((r) => r.intentId === intentId && r.status === "pending" && r.providerRefundRef === null && r.amount === amount)
      .sort((a, b) => a.createdAtMs - b.createdAtMs || (a.id < b.id ? -1 : 1));
  }

  async listPendingRefundsWithoutRef(limit: number) {
    return [...this.refunds.values()]
      .filter((r) => r.status === "pending" && r.providerRefundRef === null)
      .sort((a, b) => a.createdAtMs - b.createdAtMs || (a.id < b.id ? -1 : 1))
      .slice(0, limit);
  }

  async settleRefund(input: {
    readonly refundId: string;
    readonly outcome: "succeeded" | "failed";
    readonly providerRefundRef: string | null;
    readonly failureCode: string | null;
    readonly inbox?: InboxRef;
    readonly rawEventId?: string;
  }): Promise<SettleRefundResult> {
    const refund = this.refunds.get(input.refundId);
    if (refund === undefined) return { kind: "not_found" };
    if (input.inbox !== undefined && this.inbox.has(this.inboxKey(input.inbox))) return { kind: "duplicate" };
    const markRaw = (outcome: string): void => {
      if (input.rawEventId === undefined) return;
      const raw = this.raw.get(input.rawEventId);
      if (raw !== undefined && raw.processedAtMs === null) {
        this.raw.set(raw.id, { ...raw, processedAtMs: this.clock.nowMs(), processOutcome: outcome });
      }
    };
    if (input.inbox !== undefined) this.inbox.add(this.inboxKey(input.inbox));
    if (refund.status !== "pending") {
      markRaw("refund_already_settled");
      return { kind: "already_settled", refund };
    }
    const intent = this.intents.get(refund.intentId);
    if (intent === undefined) return { kind: "not_found" };
    const settled: RefundRecord = {
      ...refund,
      status: input.outcome,
      providerRefundRef: input.providerRefundRef ?? refund.providerRefundRef,
      failureCode: input.outcome === "failed" ? input.failureCode : null,
    };
    this.refunds.set(refund.id, settled);
    if (input.outcome === "failed") {
      this.emit(
        [
          {
            type: "payment.refund_failed",
            intentId: intent.id,
            orderGroupId: intent.orderGroupId,
            refundId: refund.id,
            reason: input.failureCode ?? "unknown",
          },
        ],
        intent.id,
      );
      markRaw("refund_failed");
      return { kind: "applied", refund: settled, intent };
    }
    const d = decideRefundApplication(intent, refund.amount);
    if (d.kind === "reject") {
      this.emit(
        [{ type: "payment.anomaly", intentId: intent.id, orderGroupId: intent.orderGroupId, anomaly: d.anomaly, detail: "refund" }],
        intent.id,
      );
      markRaw("refund_anomaly");
      return { kind: "applied", refund: settled, intent };
    }
    const next: PaymentIntentRecord = {
      ...intent,
      status: d.to,
      refundedAmount: d.totalRefunded,
      version: intent.version + 1,
      updatedAtMs: this.clock.nowMs(),
    };
    this.intents.set(intent.id, next);
    this.emit(
      [
        {
          type: "payment.refunded",
          intentId: intent.id,
          orderGroupId: intent.orderGroupId,
          refundId: refund.id,
          refundAmount: refund.amount,
          totalRefunded: d.totalRefunded,
          currency: intent.currency,
          full: d.full,
        },
      ],
      intent.id,
    );
    markRaw("refund_succeeded");
    return { kind: "applied", refund: settled, intent: next };
  }

  // ---- saved cards --------------------------------------------------------------------------
  async upsertSavedCard(rec: SavedCardRecord, rawEventId?: string) {
    for (const c of this.cards.values()) {
      if (c.provider === rec.provider && c.pspToken === rec.pspToken) {
        this.markCardRaw(rawEventId);
        return { kind: "exists" as const, card: c };
      }
    }
    this.cards.set(rec.id, { ...rec, deletedAtMs: null });
    this.outbox.push({
      id: this.newId(),
      type: "payment_method.saved",
      aggregateType: "payment_method",
      aggregateId: rec.id,
      occurredAtMs: this.clock.nowMs(),
      payload: { card_id: rec.id, brand: rec.brand },
    });
    this.markCardRaw(rawEventId);
    return { kind: "inserted" as const, card: rec };
  }

  private markCardRaw(rawEventId: string | undefined): void {
    if (rawEventId === undefined) return;
    const raw = this.raw.get(rawEventId);
    if (raw !== undefined && raw.processedAtMs === null) {
      this.raw.set(raw.id, { ...raw, processedAtMs: this.clock.nowMs(), processOutcome: "card_saved" });
    }
  }

  async listSavedCards(userId: string) {
    return [...this.cards.values()]
      .filter((c) => c.userId === userId && c.deletedAtMs === null)
      .sort((a, b) => a.createdAtMs - b.createdAtMs)
      .map(({ deletedAtMs: _d, ...c }) => c);
  }

  async getSavedCard(id: string, userId: string) {
    const c = this.cards.get(id);
    if (c === undefined || c.userId !== userId || c.deletedAtMs !== null) return null;
    const { deletedAtMs: _d, ...rec } = c;
    return rec;
  }

  async deleteSavedCard(id: string, userId: string, nowMs: number) {
    const c = this.cards.get(id);
    if (c === undefined || c.userId !== userId || c.deletedAtMs !== null) return false;
    this.cards.set(id, { ...c, deletedAtMs: nowMs });
    return true;
  }
}
