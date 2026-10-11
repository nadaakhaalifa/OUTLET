import { MAX_REFUND_ATTEMPTS, refundMachine, nextRetryAt } from "../domain/bridge";
import type { ClockPort, JitterPort, RefundStore } from "../domain/ports";

export type ProviderCallbackResult = "completed" | "failed" | "escalated" | "unknown" | "stale";

/**
 * Webhook-driven outcome for a leg the provider accepted asynchronously (`pending`). The webhook
 * adapter (payments module) has already verified signature and deduplicated the event.
 */
export class ConfirmProviderOutcome {
  constructor(
    private readonly store: RefundStore,
    private readonly clock: ClockPort,
    private readonly jitter: JitterPort,
  ) {}

  async execute(input: { provider: string; providerRef: string; result: "confirmed" | { rejected: string } }): Promise<ProviderCallbackResult> {
    const found = await this.store.findByProviderRef(input.provider, input.providerRef);
    if (found === null) return "unknown";
    const leg = found.leg;
    if (leg.state !== "SUBMITTED") return "stale";
    const now = this.clock.nowMs();
    if (input.result === "confirmed") {
      const r = await this.store.transitionLeg({
        legId: leg.id,
        from: "SUBMITTED",
        to: refundMachine.transition("SUBMITTED", "PSP_CONFIRMED", { attempts: leg.attempts }),
        attempts: leg.attempts,
        nextAttemptAtMs: null,
        failureCode: null,
        nowMs: now,
      });
      return r === "applied" ? "completed" : "stale";
    }
    const code = input.result.rejected;
    const retryAt = leg.attempts < MAX_REFUND_ATTEMPTS ? nextRetryAt(now, leg.attempts, this.jitter.next()) : null;
    const failed = await this.store.transitionLeg({
      legId: leg.id,
      from: "SUBMITTED",
      to: refundMachine.transition("SUBMITTED", "PSP_REJECTED", { attempts: leg.attempts }),
      attempts: leg.attempts,
      nextAttemptAtMs: retryAt,
      failureCode: code,
      attempt: { no: leg.attempts, outcome: "rejected", code },
      nowMs: now,
    });
    if (failed !== "applied") return "stale";
    if (leg.attempts >= MAX_REFUND_ATTEMPTS) {
      await this.store.transitionLeg({
        legId: leg.id,
        from: "FAILED",
        to: refundMachine.transition("FAILED", "ESCALATE", { attempts: leg.attempts }),
        attempts: leg.attempts,
        nextAttemptAtMs: null,
        failureCode: code,
        nowMs: this.clock.nowMs(),
      });
      return "escalated";
    }
    return "failed";
  }
}

/** Finance resolution of a MANUAL_REVIEW leg: money was sent by hand, or put back in the retry queue. */
export class ResolveManualReview {
  constructor(
    private readonly store: RefundStore,
    private readonly clock: ClockPort,
  ) {}

  async execute(input: { legId: string; refundId: string; outcome: "transferred" | "retry" }): Promise<"applied" | "stale" | "not_found"> {
    const refund = await this.store.get(input.refundId);
    const leg = refund?.legs.find((l) => l.id === input.legId);
    if (leg === undefined) return "not_found";
    if (leg.state !== "MANUAL_REVIEW") return "stale";
    const event = input.outcome === "transferred" ? "MANUAL_TRANSFER_CONFIRMED" : "RETRY";
    const to = refundMachine.transition("MANUAL_REVIEW", event, { attempts: leg.attempts });
    return this.store.transitionLeg({
      legId: leg.id,
      from: "MANUAL_REVIEW",
      to,
      // a manual retry gets a fresh budget of attempts
      attempts: input.outcome === "retry" ? 0 : leg.attempts,
      nextAttemptAtMs: null,
      failureCode: null,
      nowMs: this.clock.nowMs(),
    });
  }
}
