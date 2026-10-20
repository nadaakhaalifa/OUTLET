import {
  canReviveForLatePayment,
  isTerminal,
  reopenForRefund,
  reviveForLatePayment,
  type SagaFacts,
} from "../domain/bridge";
import type { PaymentEvent, SagaRecord } from "../domain/ports";
import type { CheckoutContext } from "./context";
import { SagaRunner } from "./saga-runner";

export type WebhookResult =
  | { readonly kind: "applied" | "duplicate" | "unknown_group" | "ignored" }
  | { readonly kind: "rejected"; readonly reason: string };

/** Pure: what an authenticated payment event does to the saga facts. Null = nothing to change. */
export function applyPaymentEvent(f: SagaFacts, e: PaymentEvent): SagaFacts | null {
  if (e.kind === "failed") {
    if (f.payment === "succeeded" || isTerminal(f.status) || f.claimed || f.status === "COMPENSATING") return null;
    if (f.payment === "failed") return null;
    return { ...f, payment: "failed", intentId: f.intentId ?? e.intentId };
  }
  if (f.payment === "succeeded") return null;
  if (f.intentId !== null && f.intentId !== e.intentId) return null;
  const paid: SagaFacts = { ...f, payment: "succeeded", intentId: f.intentId ?? e.intentId };
  if (f.status === "PLACED" || f.status === "REFUNDED") return null;
  if (f.status === "EXPIRED" || f.status === "FAILED" || f.status === "CANCELLED") {
    if (canReviveForLatePayment(paid)) return reviveForLatePayment(paid);
    return reopenForRefund(paid);
  }
  if (f.status === "COMPENSATING" && canReviveForLatePayment(paid)) return reviveForLatePayment(paid);
  return paid;
}

/**
 * Webhook before redirect, duplicates, late and out-of-order events all land here. The event is
 * recorded (deduplicated on provider event id) whatever step the saga is in, applied by CAS, then the
 * saga is driven. Recording and applying are separate so a crash between them is repaired by redelivery.
 */
export class HandlePaymentWebhook {
  private readonly runner: SagaRunner;
  constructor(private readonly ctx: CheckoutContext) {
    this.runner = new SagaRunner(ctx);
  }

  async execute(input: {
    readonly provider: string;
    readonly rawBody: string;
    readonly headers: Readonly<Record<string, string | undefined>>;
  }): Promise<WebhookResult> {
    const { ctx } = this;
    const adapter = ctx.payments.byName(input.provider);
    if (adapter === null) return { kind: "rejected", reason: "unknown_provider" };
    const nowMs = ctx.clock.nowMs();
    const v = adapter.verifyWebhook(input.rawBody, input.headers, nowMs);
    if (!v.ok) {
      ctx.metrics.increment("checkout_webhook_rejected_total", { reason: v.reason });
      return { kind: "rejected", reason: v.reason };
    }
    return this.applyVerified({ provider: input.provider, event: v.event, body: input.rawBody });
  }

  /**
   * Applies an event whose authenticity was already established upstream: either `execute` above
   * (HMAC checked by the provider adapter) or the payments module, which verifies, stores the raw
   * body and deduplicates before it emits `payment.*` (spec 7 step 6). `body` is kept for audit.
   */
  async applyVerified(input: {
    readonly provider: string;
    readonly event: PaymentEvent;
    readonly body: string;
  }): Promise<WebhookResult> {
    const { ctx } = this;
    const nowMs = ctx.clock.nowMs();
    const e = input.event;
    const rec: SagaRecord | null = await ctx.repo.get(e.orderGroupId);
    const mismatch =
      rec !== null &&
      e.kind === "succeeded" &&
      (e.amount.amount !== rec.facts.externalDue || (rec.facts.intentId !== null && rec.facts.intentId !== e.intentId));
    const recorded = await ctx.repo.recordPaymentEvent({
      id: ctx.ids.uuidV7(),
      provider: input.provider,
      eventId: e.eventId,
      orderGroupId: rec === null ? null : e.orderGroupId,
      intentId: e.intentId,
      kind: mismatch ? "rejected" : e.kind,
      amount: e.amount.amount,
      signatureOk: true,
      rejectReason: mismatch ? "amount_mismatch" : null,
      body: input.body.slice(0, 65536),
      receivedAtMs: nowMs,
    });
    if (mismatch) {
      if (recorded === "new") ctx.metrics.increment("checkout_amount_mismatch_total", { provider: input.provider });
      return { kind: "rejected", reason: "amount_mismatch" };
    }
    if (rec === null) return { kind: "unknown_group" }; // stored, never a 404 oracle

    let changed = false;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const cur = attempt === 0 ? rec : await ctx.repo.get(e.orderGroupId);
      if (cur === null) return { kind: "unknown_group" };
      const nextFacts = applyPaymentEvent(cur.facts, e);
      if (nextFacts === null) break;
      const next: SagaRecord = {
        ...cur,
        facts: nextFacts,
        nextWakeAtMs: ctx.clock.nowMs(),
        attempts: 0,
        stuck: false,
        version: cur.version + 1,
        updatedAtMs: ctx.clock.nowMs(),
      };
      if (await ctx.repo.save(next, cur.version, [])) {
        changed = true;
        break;
      }
    }
    await ctx.repo.markPaymentEventApplied(input.provider, e.eventId, ctx.clock.nowMs());
    await this.runner.drive(e.orderGroupId);
    return { kind: changed ? "applied" : recorded === "duplicate" ? "duplicate" : "ignored" };
  }
}
