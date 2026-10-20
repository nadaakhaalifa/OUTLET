import {
  MAX_REFUND_ATTEMPTS,
  isInternalChannel,
  money,
  nextRetryAt,
  refundMachine,
  type RefundState,
} from "../domain/bridge";
import type {
  ClockPort,
  CreditRestorePort,
  ExecutionOutcome,
  ExecutionRequest,
  JitterPort,
  PayoutDetailsPort,
  RefundExecutionPort,
  RefundLedgerPort,
  RefundLegRecord,
  RefundRecord,
  RefundStore,
} from "../domain/ports";
import { fromStoredEntry } from "./entry-codec";
import { RefundRecognitionMissingError } from "./errors";

export interface ProcessResult {
  readonly refundId: string;
  readonly status: RefundRecord["status"];
  readonly ledger: "posted" | "replayed" | "already";
}

/**
 * Drives one refund: ledger first (idempotent post of the entry computed at intake), then each
 * leg through the shared Refund machine. Every step is safe to repeat: the ledger is keyed by the
 * entry's idempotency key, credit restores by leg id, provider calls by leg id. A crash anywhere
 * leaves a state the next pass resumes from.
 */
export class ProcessRefund {
  constructor(
    private readonly store: RefundStore,
    private readonly ledger: RefundLedgerPort,
    private readonly credit: CreditRestorePort,
    private readonly executor: RefundExecutionPort,
    private readonly payout: PayoutDetailsPort,
    private readonly clock: ClockPort,
    private readonly jitter: JitterPort,
  ) {}

  async execute(refundId: string): Promise<ProcessResult | null> {
    let refund = await this.store.get(refundId);
    if (refund === null) return null;
    if (refund.status === "COMPLETED" || refund.status === "CANCELLED") {
      return { refundId, status: refund.status, ledger: "already" };
    }

    let ledger: ProcessResult["ledger"] = "already";
    if (refund.ledgerPostedAtMs === null) {
      // F-8: never refund value the ledger never recognised (the seller side would go negative).
      const required = refund.entry.requires;
      if (required.length > 0) {
        const found = await Promise.all(required.map((k) => this.ledger.hasEntry(k)));
        if (!found.some(Boolean)) throw new RefundRecognitionMissingError(refund.id, required);
      }
      const entry = fromStoredEntry(refund.entry);
      const r = await this.ledger.post(entry);
      ledger = r.kind;
      await this.store.markLedgerPosted(refund.id, this.clock.nowMs());
      refund = (await this.store.get(refundId)) ?? refund;
    }

    for (const leg of refund.legs) {
      if (leg.state === "LEDGER_POSTED") await this.fromLedgerPosted(refund, leg);
      else if (leg.state === "FAILED") await this.retryIfDue(refund, leg);
    }
    const after = await this.store.get(refundId);
    return { refundId, status: (after ?? refund).status, ledger };
  }

  private async fromLedgerPosted(refund: RefundRecord, leg: RefundLegRecord): Promise<void> {
    if (isInternalChannel(leg.channel)) {
      const sub = leg.creditSub;
      if (sub === null) return;
      await this.credit.restore({
        userId: refund.userId,
        sub,
        amount: money(leg.amount),
        refundId: refund.id,
        legId: leg.id,
      });
      await this.apply(leg, "CREDIT_ISSUED", { attempts: leg.attempts });
      return;
    }
    if (leg.needsPayoutDetails) {
      const channel = leg.channel === "wallet_transfer" ? "wallet_transfer" : "bank_transfer_iban";
      // Waiting for details is not a failure: the SLO view shows the refund as APPROVED.
      if (!(await this.payout.verified(refund.userId, channel))) return;
    }
    await this.submit(refund, leg);
  }

  private async retryIfDue(refund: RefundRecord, leg: RefundLegRecord): Promise<void> {
    const now = this.clock.nowMs();
    if (leg.attempts >= MAX_REFUND_ATTEMPTS) {
      await this.apply(leg, "ESCALATE", { attempts: leg.attempts, code: leg.failureCode });
      return;
    }
    if (leg.nextAttemptAtMs !== null && leg.nextAttemptAtMs > now) return;
    await this.submit(refund, leg);
  }

  /** LEDGER_POSTED or FAILED -> SUBMITTED, call the provider, then settle the outcome. */
  private async submit(refund: RefundRecord, leg: RefundLegRecord): Promise<void> {
    const event = leg.state === "FAILED" ? "RETRY" : "SUBMIT_TO_PSP";
    const attempt = leg.attempts + 1;
    const submitted = await this.apply(leg, event, { attempts: attempt, resetNext: true });
    if (submitted === null) return;
    const request: ExecutionRequest = {
      idempotencyKey: leg.id,
      channel: leg.channel as ExecutionRequest["channel"],
      method: leg.method,
      amount: money(leg.amount),
      tender: leg.tender,
      attempt,
    };
    let outcome: ExecutionOutcome;
    let unavailable = false;
    try {
      outcome = await this.executor.execute(request);
    } catch {
      unavailable = true;
      outcome = { kind: "rejected", code: "provider_unavailable" };
    }
    const sub = { ...leg, state: "SUBMITTED" as RefundState, attempts: attempt };
    if (outcome.kind === "confirmed") {
      await this.apply(sub, "PSP_CONFIRMED", {
        attempts: attempt,
        providerRef: outcome.providerRef,
        attempt: { no: attempt, outcome: "confirmed", code: null },
      });
    } else if (outcome.kind === "pending") {
      // Stays SUBMITTED until the provider confirms by webhook (ConfirmProviderOutcome).
      await this.store.transitionLeg({
        legId: leg.id,
        from: "SUBMITTED",
        to: "SUBMITTED",
        attempts: attempt,
        nextAttemptAtMs: null,
        providerRef: outcome.providerRef,
        failureCode: null,
        attempt: { no: attempt, outcome: "pending", code: null },
        nowMs: this.clock.nowMs(),
      });
    } else {
      await this.fail(sub, attempt, outcome.code, unavailable);
    }
  }

  private async fail(leg: RefundLegRecord, attempts: number, code: string, unavailable: boolean): Promise<void> {
    const now = this.clock.nowMs();
    const retryAt = attempts < MAX_REFUND_ATTEMPTS ? nextRetryAt(now, attempts, this.jitter.next()) : null;
    const failed = await this.store.transitionLeg({
      legId: leg.id,
      from: "SUBMITTED",
      to: refundMachine.transition("SUBMITTED", "PSP_REJECTED", { attempts }),
      attempts,
      nextAttemptAtMs: retryAt,
      failureCode: code,
      attempt: { no: attempts, outcome: unavailable ? "unavailable" : "rejected", code },
      nowMs: now,
    });
    if (failed === "applied" && attempts >= MAX_REFUND_ATTEMPTS) {
      await this.store.transitionLeg({
        legId: leg.id,
        from: "FAILED",
        to: refundMachine.transition("FAILED", "ESCALATE", { attempts }),
        attempts,
        nextAttemptAtMs: null,
        failureCode: code,
        nowMs: this.clock.nowMs(),
      });
    }
  }

  private async apply(
    leg: RefundLegRecord,
    event: "CREDIT_ISSUED" | "SUBMIT_TO_PSP" | "RETRY" | "PSP_CONFIRMED" | "ESCALATE",
    o: {
      attempts: number;
      providerRef?: string | null;
      code?: string | null;
      resetNext?: boolean;
      attempt?: { no: number; outcome: "confirmed" | "pending" | "rejected" | "unavailable"; code: string | null };
    },
  ): Promise<"applied" | null> {
    // The machine's guards count attempts already made: a retry is judged before it is counted.
    const made = event === "RETRY" ? leg.attempts : o.attempts;
    const to = refundMachine.transition(leg.state, event, { attempts: made });
    const r = await this.store.transitionLeg({
      legId: leg.id,
      from: leg.state,
      to,
      attempts: o.attempts,
      nextAttemptAtMs: null,
      ...(o.providerRef === undefined ? {} : { providerRef: o.providerRef }),
      failureCode: o.code ?? null,
      ...(o.attempt === undefined ? {} : { attempt: o.attempt }),
      nowMs: this.clock.nowMs(),
    });
    return r === "applied" ? "applied" : null;
  }
}

/** Sweeper: processes up to `limit` refunds that have work due. Safe to run concurrently with itself. */
export class SweepRefunds {
  constructor(
    private readonly store: RefundStore,
    private readonly process: ProcessRefund,
    private readonly clock: ClockPort,
  ) {}
  async execute(limit = 50): Promise<{ processed: number }> {
    const ids = await this.store.listActionable(this.clock.nowMs(), limit);
    for (const id of ids) {
      try {
        await this.process.execute(id);
      } catch (e) {
        // A refund waiting for its order's recognition entry must not stall the others.
        if (!(e instanceof RefundRecognitionMissingError)) throw e;
      }
    }
    return { processed: ids.length };
  }
}
