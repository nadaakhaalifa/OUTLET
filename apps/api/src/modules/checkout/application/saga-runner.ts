import {
  beginCompensation,
  canReviveForLatePayment,
  checkoutOrderEntry,
  finishCompensation,
  isTerminal,
  lateReceiptEntry,
  lateRefundEntry,
  money,
  nextAction,
  orderRecognitionKey,
  needsHold,
  reservationTtlSeconds,
  reverseEntry,
  reviveForLatePayment,
  type CompensationReason,
  type CompensationStep,
  type SagaFacts,
  InvalidCheckoutError,
} from "../domain/bridge";
import type {
  ClientAction,
  OutboxDraft,
  PlaceOrdersCommand,
  ReserveResult,
  SagaRecord,
  StoredQuote,
} from "../domain/ports";
import { LedgerKeyConflictError } from "../domain/ports";
import type { CheckoutContext } from "./context";
import { derivedUuid } from "./ids";

/** Grace before the recovery sweeper may re-drive a saga that another driver is actively running. */
export const IN_FLIGHT_GRACE_MS = 30_000;
export const MAX_STEP_ATTEMPTS = 8;
const MAX_STEPS_PER_DRIVE = 60;
/** Added to the method's payment window so the hold outlives the reservation and the sweeper's retries. */
export const CREDIT_HOLD_GRACE_SECONDS = 300;

export type Shortfall = { readonly skuId: string; readonly requested: number; readonly available: number };

export interface DriveOutcome {
  readonly record: SagaRecord;
  /** Present when this drive ended in `stock_unavailable` at reservation time. */
  readonly shortfalls: readonly Shortfall[] | null;
}

interface Step {
  readonly facts: SagaFacts;
  readonly provider?: string | null;
  readonly clientAction?: ClientAction | null;
  readonly events?: readonly Omit<OutboxDraft, "id" | "occurredAtMs" | "aggregateId">[];
  readonly metrics?: readonly { readonly name: string; readonly labels?: Record<string, string> }[];
  readonly shortfalls?: readonly Shortfall[];
  /** Wait: keep facts, set the wake time, stop driving. */
  readonly wakeAtMs?: number | null;
  readonly stop?: boolean;
}

const releaseReason = (r: CompensationReason | undefined): "payment_failed" | "cancelled" | "abandoned" =>
  r === "payment_failed" ? "payment_failed" : r === "cancelled_by_shopper" ? "cancelled" : "abandoned";

const keyOf = (g: string, what: string): string => `checkout:${g}:${what}`;
/** The prepaid recognition entry key: the one shared with refunds and the ledger-posting template (R-1). */
const recognitionKey = (g: string): string => orderRecognitionKey(g, "prepaid");

/**
 * Executes the persisted saga. Each loop: read the record, ask the pure domain for the next action,
 * perform ONE effect through a port (always keyed, so a crash and replay is harmless), then persist the
 * new facts with a compare-and-swap together with outbox events. Any number of drivers (request, webhook,
 * sweeper) may run concurrently: the loser of a CAS just re-reads.
 */
export class SagaRunner {
  constructor(private readonly ctx: CheckoutContext) {}

  async drive(orderGroupId: string): Promise<DriveOutcome> {
    const { ctx } = this;
    let shortfalls: readonly Shortfall[] | null = null;
    for (let i = 0; i < MAX_STEPS_PER_DRIVE; i += 1) {
      const rec = await ctx.repo.get(orderGroupId);
      if (rec === null) throw new Error(`saga ${orderGroupId} not found`);
      if (isTerminal(rec.facts.status) || rec.stuck) return { record: rec, shortfalls };
      const nowMs = ctx.clock.nowMs();
      const action = nextAction(rec.facts, nowMs);
      if (action.kind === "none") return { record: rec, shortfalls };

      let step: Step;
      try {
        step = await this.perform(rec, action, nowMs);
      } catch (e) {
        return { record: await this.recordFailure(rec, e, nowMs), shortfalls };
      }
      if (step.shortfalls !== undefined) shortfalls = step.shortfalls;

      const terminal = isTerminal(step.facts.status);
      const waiting = step.wakeAtMs !== undefined;
      const events = (step.events ?? []).map((e) => ({
        id: ctx.ids.uuidV7(),
        aggregateId: orderGroupId,
        occurredAtMs: nowMs,
        ...e,
      }));
      const next: SagaRecord = {
        ...rec,
        facts: step.facts,
        provider: step.provider === undefined ? rec.provider : step.provider,
        clientAction: step.clientAction === undefined ? rec.clientAction : step.clientAction,
        attempts: 0,
        lastError: null,
        nextWakeAtMs: terminal ? null : waiting ? (step.wakeAtMs ?? null) : nowMs + IN_FLIGHT_GRACE_MS,
        version: rec.version + 1,
        updatedAtMs: nowMs,
      };
      const saved = await ctx.repo.save(next, rec.version, events);
      if (!saved) continue; // another driver won; re-read and continue
      for (const m of step.metrics ?? []) ctx.metrics.increment(m.name, m.labels);
      if (step.stop === true || waiting) return { record: next, shortfalls };
    }
    const last = await ctx.repo.get(orderGroupId);
    if (last === null) throw new Error(`saga ${orderGroupId} not found`);
    return { record: last, shortfalls };
  }

  /** Port failure: back off and let the sweeper retry; park as stuck after MAX_STEP_ATTEMPTS (never dropped). */
  private async recordFailure(rec: SagaRecord, e: unknown, nowMs: number): Promise<SagaRecord> {
    const { ctx } = this;
    const attempts = rec.attempts + 1;
    const stuck = attempts >= MAX_STEP_ATTEMPTS || e instanceof LedgerKeyConflictError;
    const message = (e instanceof Error ? e.message : "unknown error").slice(0, 400);
    const backoff = Math.min(2 ** attempts, 300) * 1000;
    const next: SagaRecord = {
      ...rec,
      attempts,
      lastError: message,
      stuck,
      nextWakeAtMs: stuck ? null : nowMs + backoff,
      version: rec.version + 1,
      updatedAtMs: nowMs,
    };
    const events: OutboxDraft[] = stuck
      ? [
          {
            id: ctx.ids.uuidV7(),
            type: "checkout.saga_stuck",
            aggregateId: rec.orderGroupId,
            occurredAtMs: nowMs,
            payload: { status: rec.facts.status, attempts },
          },
        ]
      : [];
    const ok = await ctx.repo.save(next, rec.version, events);
    if (!ok) return (await ctx.repo.get(rec.orderGroupId)) ?? rec;
    if (stuck) ctx.metrics.increment("checkout_saga_stuck_total");
    return next;
  }

  private async perform(rec: SagaRecord, action: ReturnType<typeof nextAction>, nowMs: number): Promise<Step> {
    const { ctx } = this;
    const f = rec.facts;
    const g = rec.orderGroupId;
    const stored = rec.stored;

    switch (action.kind) {
      case "validate": {
        const bag = await ctx.cart.snapshot(rec.userId);
        const bySku = new Map(bag.lines.map((l) => [l.lineId, l]));
        for (const l of stored.lines) {
          const live = bySku.get(l.lineId);
          if (live === undefined) continue; // removed from the bag after commit: the order is still honoured
          const store = bag.stores.get(live.storeId);
          if (!live.available || store === undefined || !store.open) {
            return { facts: beginCompensation(f, "stock_unavailable") };
          }
          if (live.unitPrice.amount > l.unitPrice.amount && !this.lockCovers(rec, nowMs)) {
            return { facts: beginCompensation(f, "price_changed") };
          }
        }
        return { facts: { ...f, status: "RESERVE_INVENTORY" } };
      }
      case "reserve": {
        const bySku = new Map<string, number>();
        for (const l of stored.lines) bySku.set(l.skuId, (bySku.get(l.skuId) ?? 0) + l.qty);
        const r: ReserveResult = await ctx.inventory.reserve({
          orderGroupId: g,
          userId: rec.userId,
          method: f.method,
          lines: [...bySku].sort(([a], [b]) => (a < b ? -1 : 1)).map(([skuId, qty]) => ({ skuId, qty })),
        });
        if (r.kind === "reserved") {
          return { facts: { ...f, reservationId: r.reservationId, reservationExpiresAtMs: r.expiresAtMs } };
        }
        if (r.kind === "insufficient") {
          return { facts: beginCompensation(f, "stock_unavailable"), shortfalls: r.shortfalls };
        }
        return { facts: beginCompensation(f, "stock_unavailable") };
      }
      case "hold_credit": {
        const holdId = f.holdSeq === 0 ? `hold:${g}` : `hold:${g}:${f.holdSeq}`;
        const r = await ctx.credit.hold({
          holdId,
          userId: rec.userId,
          plan: stored.quote.tender.storeCredit.map((c) => ({ sub: c.sub, amount: c.amount })),
          ttlSeconds: this.holdTtlSeconds(f),
        });
        return r.kind === "held"
          ? { facts: { ...f, holdId: r.holdId, holdReleased: false } }
          : { facts: beginCompensation(f, "credit_unavailable") };
      }
      case "create_intent": {
        const provider = ctx.payments.forMethod(f.method);
        if (provider === null) return { facts: beginCompensation(f, "intent_rejected") };
        const r = await provider.createIntent({
          idempotencyKey: g,
          amount: money(f.externalDue),
          method: f.method,
          userId: rec.userId,
        });
        if (r.kind === "rejected") return { facts: beginCompensation(f, "intent_rejected") };
        return {
          facts: { ...f, intentId: r.intentId },
          provider: r.provider,
          clientAction: r.clientAction,
        };
      }
      case "wait":
        return { facts: f, wakeAtMs: action.wakeAtMs };
      case "advance":
        return { facts: { ...f, status: action.to } };
      case "claim": {
        const r = await ctx.inventory.claim(g);
        if (r.kind === "claimed" || r.kind === "claimed_late" || r.kind === "already_claimed") {
          return { facts: { ...f, claimed: true } };
        }
        const paid = f.payment === "succeeded";
        return {
          facts: beginCompensation(f, paid ? "late_payment_no_stock" : "stock_unavailable"),
          events: paid
            ? [{ type: "checkout.apology_voucher_requested", payload: { user_id: rec.userId, reason: "no_stock_after_payment" } }]
            : [],
        };
      }
      case "post_ledger": {
        // Credit capture and the ledger entry are one step, persisted by one CAS: the entry's
        // store_credit debits are only ever written for credit that was really consumed (F-1).
        let facts = f;
        if (needsHold(f) && !f.holdCaptured) {
          const cap = await this.captureOrRehold(rec, nowMs);
          if (cap.kind === "compensate") return { facts: cap.facts };
          facts = cap.facts;
        }
        const entry = this.recognitionEntry(rec, nowMs);
        if (entry !== null) await ctx.ledger.post(entry);
        return { facts: { ...facts, ledgerPosted: true } };
      }
      case "place_orders": {
        await ctx.orders.place(this.placeCommand(rec, nowMs));
        return { facts: { ...f, ordersPlaced: true } };
      }
      case "capture_credit": {
        if (f.holdId === null) throw new Error("capture_credit without a hold");
        const cap = await this.captureOrRehold(rec, nowMs);
        return { facts: cap.facts };
      }
      case "mark_placed": {
        await ctx.cart.removePurchased(rec.userId, stored.lines.map((l) => l.lineId)).catch(() => undefined);
        return {
          facts: { ...f, status: "PLACED" },
          events: [
            {
              type: f.method === "cod" ? "order_group.cod_confirmed" : "order_group.paid",
              payload: {
                user_id: rec.userId,
                method: f.method,
                total: stored.quote.total.amount.toString(),
                // Additive (backward compatible) fields for downstream consumers: creators
                // attribution and auto-buy CloseOnPurchase. Flat primitives only (OutboxDraft).
                order_group_id: g,
                sku_ids: [...new Set(stored.lines.map((l) => l.skuId))].sort().join(","),
                paid_at_ms: nowMs,
              },
            },
          ],
          metrics: [{ name: "checkout_placed_total", labels: { method: f.method } }],
        };
      }
      case "begin_compensation":
        return { facts: beginCompensation(f, action.reason) };
      case "compensate":
        return this.compensate(rec, action.step, nowMs);
      case "none":
        return { facts: f, stop: true };
      case "finish_compensation": {
        const done = finishCompensation(f);
        const reason = f.compensating?.reason ?? "payment_failed";
        const type = done.status === "EXPIRED" ? "order_group.expired" : done.status === "REFUNDED" ? "checkout.late_payment_refunded" : "order_group.failed";
        return {
          facts: done,
          events: [{ type, payload: { user_id: rec.userId, reason } }],
          metrics: [
            { name: "checkout_failed_total", labels: { reason } },
            ...(done.status === "REFUNDED" && reason === "late_payment_no_stock"
              ? [{ name: "checkout_late_payment_refund_total" }]
              : []),
          ],
        };
      }
    }
  }

  private lockCovers(rec: SagaRecord, nowMs: number): boolean {
    // The price lock was honoured at commit: a catalog price above the locked price is not a change.
    // Use the signed lock's own expiry (F-14); rows written before it fall back to commit time + 10 min.
    const expires = rec.stored.lockExpiresAtMs ?? rec.createdAtMs + 10 * 60 * 1000;
    return nowMs < expires;
  }

  private holdTtlSeconds(f: SagaFacts): number {
    return reservationTtlSeconds(f.method) + CREDIT_HOLD_GRACE_SECONDS;
  }

  /**
   * Consumes the credit hold. `not_held` / `not_found` means the value is no longer reserved: the
   * saga re-holds under a fresh id before anything is posted, and if the credit cannot be taken
   * again the whole group is compensated (refund) rather than recognising credit that was not spent.
   */
  private async captureOrRehold(
    rec: SagaRecord,
    _nowMs: number,
  ): Promise<{ readonly kind: "ok"; readonly facts: SagaFacts } | { readonly kind: "compensate"; readonly facts: SagaFacts }> {
    const { ctx } = this;
    const f = rec.facts;
    const g = rec.orderGroupId;
    const orderEntryKey = recognitionKey(g);
    const lost = (facts: SagaFacts) => ({
      kind: "compensate" as const,
      facts: beginCompensation(facts, f.payment === "succeeded" ? "late_credit_unavailable" : "credit_unavailable"),
    });
    if (f.holdId !== null) {
      const r = await ctx.credit.capture({ holdId: f.holdId, userId: rec.userId, orderEntryKey });
      if (r.kind === "captured") return { kind: "ok", facts: { ...f, holdCaptured: true } };
    }
    const seq = f.holdSeq + 1;
    const holdId = `hold:${g}:${seq}`;
    const h = await ctx.credit.hold({
      holdId,
      userId: rec.userId,
      plan: rec.stored.quote.tender.storeCredit.map((c) => ({ sub: c.sub, amount: c.amount })),
      ttlSeconds: this.holdTtlSeconds(f),
    });
    const rehomed: SagaFacts = { ...f, holdId, holdSeq: seq, holdReleased: false };
    if (h.kind !== "held") return lost(f);
    const r2 = await ctx.credit.capture({ holdId, userId: rec.userId, orderEntryKey });
    if (r2.kind !== "captured") return lost(rehomed);
    return { kind: "ok", facts: { ...rehomed, holdCaptured: true } };
  }

  private async compensate(rec: SagaRecord, step: CompensationStep, nowMs: number): Promise<Step> {
    const { ctx } = this;
    const f = rec.facts;
    const g = rec.orderGroupId;
    const provider = rec.provider === null ? null : ctx.payments.byName(rec.provider);
    switch (step) {
      case "reverse_ledger": {
        const key = recognitionKey(g);
        // Never invent the original: a missing entry is an error for the operator (F-13).
        const original = await ctx.ledger.find(key);
        if (original === null) throw new Error(`reverse_ledger: recognition entry ${key} not found`);
        await ctx.ledger.post(
          reverseEntry(original, {
            id: derivedUuid(`${key}:reversal`),
            idempotencyKey: `${key}:reversal`,
            occurredAt: new Date(nowMs),
          }),
        );
        return { facts: { ...f, ledgerReversed: true } };
      }
      case "refund_payment": {
        if (f.intentId === null || provider === null) throw new Error("refund without a provider intent");
        const amount = money(f.externalDue);
        const parked = !f.ledgerPosted;
        if (parked) {
          await ctx.ledger.post(
            lateReceiptEntry(amount, provider.provider, {
              id: derivedUuid(keyOf(g, "late-receipt")),
              idempotencyKey: keyOf(g, "late-receipt"),
              occurredAt: new Date(nowMs),
              ref: { type: "order_group", id: g },
            }),
          );
        }
        await provider.refund({ intentId: f.intentId, amount, idempotencyKey: keyOf(g, "refund") });
        if (parked) {
          await ctx.ledger.post(
            lateRefundEntry(amount, provider.provider, {
              id: derivedUuid(keyOf(g, "late-refund")),
              idempotencyKey: keyOf(g, "late-refund"),
              occurredAt: new Date(nowMs),
              ref: { type: "order_group", id: g },
            }),
          );
        }
        return { facts: { ...f, refunded: true, lateReceiptPosted: parked || f.lateReceiptPosted } };
      }
      case "void_intent": {
        if (f.intentId === null || provider === null) return { facts: { ...f, intentVoided: true } };
        const r = await provider.voidIntent(f.intentId);
        if (r.kind !== "not_voidable_succeeded") return { facts: { ...f, intentVoided: true } };
        // The money had already arrived: stop treating this as a void, recover the sale if still possible.
        const paid: SagaFacts = { ...f, payment: "succeeded" };
        return { facts: canReviveForLatePayment(paid) ? reviveForLatePayment(paid) : paid };
      }
      case "release_hold": {
        if (f.holdId !== null) await ctx.credit.release({ holdId: f.holdId, userId: rec.userId });
        return { facts: { ...f, holdReleased: true } };
      }
      case "release_reservation": {
        // R-2: claimed stock whose orders will never be placed goes back to the pool; release()
        // alone is a noop for a CLAIMED reservation and would leak the units.
        if (f.claimed && !f.ordersPlaced) await ctx.inventory.unclaim(g, releaseReason(f.compensating?.reason));
        else await ctx.inventory.release(g, releaseReason(f.compensating?.reason));
        return { facts: { ...f, reservationReleased: true } };
      }
    }
  }

  private recognitionEntry(rec: SagaRecord, nowMs: number) {
    const key = recognitionKey(rec.orderGroupId);
    return checkoutOrderEntry(
      {
        quote: rec.stored.quote,
        userId: rec.userId,
        provider: rec.provider,
        commissionBps: new Map(Object.entries(rec.stored.commissionBps)),
      },
      {
        id: derivedUuid(key),
        idempotencyKey: key,
        occurredAt: new Date(nowMs),
        ref: { type: "order_group", id: rec.orderGroupId },
      },
    );
  }

  private commissionOf(s: StoredQuote, storeId: string): number {
    const bps = s.commissionBps[storeId];
    if (bps === undefined) throw new InvalidCheckoutError(`commission missing for store ${storeId}`);
    return bps;
  }

  private placeCommand(rec: SagaRecord, nowMs: number): PlaceOrdersCommand {
    const s: StoredQuote = rec.stored;
    return {
      groupId: rec.orderGroupId,
      userId: rec.userId,
      idempotencyKey: keyOf(rec.orderGroupId, "place"),
      paymentMethod: rec.facts.method,
      paidAtMs: nowMs,
      storeCredit: s.quote.tender.storeCreditTotal,
      sellerOrders: s.quote.stores.map((st) => ({
        id: derivedUuid(`${rec.orderGroupId}:${st.storeId}`),
        storeId: st.storeId,
        commissionRateBps: this.commissionOf(s, st.storeId),
        shipping: st.shipping,
        discount: money(st.platformFundedDiscount.amount + st.sellerFundedDiscount.amount),
        vat: st.vat,
        lines: s.lines
          .filter((l) => l.storeId === st.storeId)
          .map((l) => ({
            id: l.lineId,
            skuId: l.skuId,
            productId: l.productId,
            qty: l.qty,
            unitPrice: l.unitPrice,
            discountAlloc: l.discount,
            vat: l.vat,
            title: l.title,
            ...(l.sizeLabel !== undefined ? { sizeLabel: l.sizeLabel } : {}),
          })),
        buyer: s.buyer,
      })),
    };
  }
}
