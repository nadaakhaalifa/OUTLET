import {
  applyCreatorPayoutEvent,
  creatorPayout,
  creatorPayoutApproval,
  money,
  payoutEligible,
  payoutLineAmount,
  reverseEntry,
  type PayoutContext,
  type PayoutState,
} from "../domain/bridge";
import type {
  Clock,
  CreatorApprovalsPort,
  CreatorFlagsPort,
  CreatorIdentityPort,
  CreatorKycVaultPort,
  CreatorLedgerPort,
  CreatorPayout,
  CreatorPayoutProviderPort,
  CreatorStore,
  IdPort,
} from "../domain/ports";
import { creatorFacts } from "./accounts";
import { payoutLedgerKey, payoutReversalKey, type CreatorRuntimeOptions } from "./shared";

export type PayoutResult =
  | { readonly kind: "ok"; readonly payout: CreatorPayout }
  | { readonly kind: "disabled" }
  | { readonly kind: "not_found" }
  | { readonly kind: "ineligible"; readonly reason: string }
  | { readonly kind: "credit_preference" }
  | { readonly kind: "nothing_payable" }
  | { readonly kind: "negative_balance"; readonly owes: bigint }
  | { readonly kind: "below_minimum"; readonly amount: bigint }
  | { readonly kind: "open_exists" }
  | { readonly kind: "invalid_transition"; readonly state: PayoutState }
  | { readonly kind: "approval_required" }
  | { readonly kind: "provider_unconfigured" }
  | { readonly kind: "held"; readonly payout: CreatorPayout; readonly reason: string }
  | { readonly kind: "conflict" };

/**
 * Creator payouts on the seller payout machine. ENGAGED OFF: `kill.creator_payouts` is blocked by
 * default and the provider defaults to Unconfigured, so no instruction is ever created or sent
 * until ADR-0037 and VR-P3-03 are resolved and Finance flips both on purpose.
 */
export class CreatorPayoutCommands {
  constructor(
    private readonly store: CreatorStore,
    private readonly identity: CreatorIdentityPort,
    private readonly ledger: CreatorLedgerPort,
    private readonly vault: CreatorKycVaultPort,
    private readonly approvals: CreatorApprovalsPort,
    private readonly provider: CreatorPayoutProviderPort,
    private readonly flags: CreatorFlagsPort,
    private readonly clock: Clock,
    private readonly ids: IdPort,
    private readonly opts: CreatorRuntimeOptions,
  ) {}

  private ctx(over: Partial<PayoutContext>): PayoutContext {
    return { approvalRequirementMet: false, noOpenDispute: true, ibanNameMatched: false, ...over };
  }

  async create(input: { readonly creatorId: string; readonly requestedBy: string }): Promise<PayoutResult> {
    if (!(await this.flags.payoutsEnabled())) return { kind: "disabled" };
    const a = await this.store.getById(input.creatorId);
    if (a === null) return { kind: "not_found" };
    const reason = payoutEligible(this.opts.config, await creatorFacts(this.identity, a));
    if (reason !== null) return { kind: "ineligible", reason };
    // Store-credit conversion needs a closed-loop sub-balance decision (ADR-0037 open item).
    if (a.payoutPref !== "cash") return { kind: "credit_preference" };

    const natural = await this.ledger.payableBalance(a.userId);
    if (natural < 0n) return { kind: "negative_balance", owes: -natural };
    if (natural === 0n) return { kind: "nothing_payable" };
    const reserved = await this.store.reservableTotal(a.id);
    const amount = payoutLineAmount(natural, reserved);
    if (amount === 0n) return { kind: "nothing_payable" };
    if (amount < this.opts.config.minPayout) return { kind: "below_minimum", amount };

    const nowMs = this.clock.nowMs();
    const payout: CreatorPayout = {
      id: this.ids.uuidV7(),
      creatorId: a.id,
      amount,
      state: "SCHEDULED",
      holdReason: null,
      attempt: 0,
      providerRef: null,
      failureReason: null,
      createdBy: input.requestedBy,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    };
    const r = await this.store.createPayout({
      payout,
      events: [{ type: "creator_payout.requested", creatorId: a.id, payoutId: payout.id, amount }],
    });
    return r === "open_exists" ? { kind: "open_exists" } : { kind: "ok", payout };
  }

  async approve(input: { readonly payoutId: string; readonly approverId: string }): Promise<PayoutResult> {
    if (!(await this.flags.payoutsEnabled())) return { kind: "disabled" };
    const p = await this.store.getPayout(input.payoutId);
    if (p === null) return { kind: "not_found" };
    if (p.state !== "SCHEDULED" && p.state !== "ON_HOLD") return { kind: "invalid_transition", state: p.state };
    if (p.createdBy === input.approverId) return { kind: "approval_required" };
    // A-6: approving out of ON_HOLD must not re-open a payout whose hold cause still stands.
    if (p.state === "ON_HOLD") {
      const a = await this.store.getById(p.creatorId);
      if (a === null) return { kind: "not_found" };
      const eligible = payoutEligible(this.opts.config, await creatorFacts(this.identity, a));
      if (eligible !== null) return { kind: "ineligible", reason: eligible };
      if (!(await this.vault.payoutIdentityMatched(a.id))) return { kind: "held", payout: p, reason: "iban_name_mismatch" };
    }
    const records = await this.approvals.forPayout(p.id);
    const gate = creatorPayoutApproval({ payoutId: p.id, amountMinor: p.amount, records, nowMs: this.clock.nowMs() });
    if (!gate.met) return { kind: "approval_required" };
    const to = applyCreatorPayoutEvent(p.state, "APPROVE", this.ctx({ approvalRequirementMet: true }));
    const next = await this.store.transitionPayout({
      id: p.id,
      from: p.state,
      to,
      holdReason: null,
      nowMs: this.clock.nowMs(),
      events: [],
    });
    return next === null ? { kind: "conflict" } : { kind: "ok", payout: next };
  }

  async send(input: { readonly payoutId: string }): Promise<PayoutResult> {
    if (!(await this.flags.payoutsEnabled())) return { kind: "disabled" };
    if (!this.provider.configured) return { kind: "provider_unconfigured" };
    const p = await this.store.getPayout(input.payoutId);
    if (p === null) return { kind: "not_found" };
    if (p.state !== "APPROVED") return { kind: "invalid_transition", state: p.state };
    const a = await this.store.getById(p.creatorId);
    if (a === null) return { kind: "not_found" };
    const nowMs = this.clock.nowMs();

    const hold = async (reason: string): Promise<PayoutResult> => {
      const held = await this.store.transitionPayout({
        id: p.id,
        from: "APPROVED",
        to: applyCreatorPayoutEvent("APPROVED", "RISK_HOLD", this.ctx({})),
        holdReason: reason,
        nowMs,
        events: [],
      });
      return held === null ? { kind: "conflict" } : { kind: "held", payout: held, reason };
    };

    const eligible = payoutEligible(this.opts.config, await creatorFacts(this.identity, a));
    if (eligible !== null) return hold(eligible);
    // Clawbacks since approval may have shrunk the payable: never send more than the ledger holds.
    if ((await this.ledger.payableBalance(a.userId)) < p.amount) return hold("exceeds_ledger_balance");
    const matched = await this.vault.payoutIdentityMatched(a.id);
    if (!matched) return hold("iban_name_mismatch");

    const attempt = p.attempt + 1;
    const entry = creatorPayout(
      { creatorId: a.userId, amount: money(p.amount), bankAccount: this.opts.bankAccount },
      {
        id: this.ids.uuidV7(),
        idempotencyKey: payoutLedgerKey(p.id, attempt),
        occurredAt: new Date(nowMs),
        ref: { type: "creator_payout", id: p.id },
      },
    );
    // A-2: claim first. The APPROVED -> SENT compare-and-set is the claim token: a concurrent cancel
    // or hold that wins leaves no ledger entry at all. Only the winner posts, then calls the rail.
    // A crash after the CAS leaves SENT without an entry; recoverOrphans re-posts (idempotent key).
    const sent = await this.store.transitionPayout({
      id: p.id,
      from: "APPROVED",
      to: applyCreatorPayoutEvent("APPROVED", "SEND", this.ctx({ ibanNameMatched: true })),
      attempt,
      nowMs,
      events: [],
    });
    if (sent === null) return { kind: "conflict" };
    return this.postAndSend(sent, entry);
  }

  /** Ledger entry (idempotent on the attempt key), then the rail (idempotent on the same key). */
  private async postAndSend(sent: CreatorPayout, entry: ReturnType<typeof creatorPayout>): Promise<PayoutResult> {
    const p = sent;
    const nowMs = this.clock.nowMs();
    const a = await this.store.getById(p.creatorId);
    if (a === null) return { kind: "not_found" };
    await this.ledger.post(entry);
    const attempt = p.attempt;
    const outcome = await this.provider.send({
      idempotencyKey: payoutLedgerKey(p.id, attempt),
      amount: p.amount,
      creatorId: a.id,
      reference: p.id,
    });
    switch (outcome.kind) {
      case "settled":
        return this.finish(sent, "settled", outcome.providerRef, null);
      case "rejected":
        return this.finish(sent, "rejected", null, outcome.reason);
      case "accepted": {
        const r = await this.store.transitionPayout({ id: p.id, from: "SENT", to: "SENT", providerRef: outcome.providerRef, nowMs, events: [] });
        return r === null ? { kind: "conflict" } : { kind: "ok", payout: r };
      }
      case "unavailable":
        return { kind: "ok", payout: sent };
    }
  }

  /**
   * A-2 recovery job. (1) A payout in SENT with no provider reference is resumed: the entry is
   * re-posted under its attempt key (a replay is a no-op) and the rail is asked again (idempotent
   * by the same key). (2) A ledger entry whose payout is not SENT or SETTLED for that attempt is
   * reversed, exactly once, under the reversal key. Safe to run repeatedly and concurrently.
   */
  async recoverOrphans(staleMs = 10 * 60_000, limit = 100): Promise<{ readonly resumed: number; readonly reversed: number }> {
    if (!this.provider.configured) return { resumed: 0, reversed: 0 };
    const now = this.clock.nowMs();
    let resumed = 0;
    let reversed = 0;
    for (const p of await this.store.listPayouts({ state: "SENT", limit })) {
      if (p.providerRef !== null || now - p.updatedAtMs < staleMs || p.attempt < 1) continue;
      const a = await this.store.getById(p.creatorId);
      if (a === null) continue;
      const entry = this.entryFor(a.userId, p, p.attempt, now);
      await this.postAndSend(p, entry);
      resumed += 1;
    }
    const open: PayoutState[] = ["SCHEDULED", "ON_HOLD", "APPROVED", "CANCELLED", "FAILED"];
    for (const state of open) {
      for (const p of await this.store.listPayouts({ state, limit })) {
        const a = await this.store.getById(p.creatorId);
        if (a === null) continue;
        // The attempt that could have posted is the current one (SENT is the only state that
        // keeps it live) and the next one (CAS lost after a post by older code).
        for (const attempt of [p.attempt, p.attempt + 1]) {
          if (attempt < 1) continue;
          const key = payoutLedgerKey(p.id, attempt);
          if (!(await this.ledger.hasEntry(key))) continue;
          if (await this.ledger.hasEntry(payoutReversalKey(p.id, attempt))) continue;
          const original = this.entryFor(a.userId, p, attempt, now);
          await this.ledger.post(
            reverseEntry(original, { id: this.ids.uuidV7(), idempotencyKey: payoutReversalKey(p.id, attempt), occurredAt: new Date(now) }),
          );
          reversed += 1;
        }
      }
    }
    return { resumed, reversed };
  }

  private entryFor(creatorUserId: string, p: CreatorPayout, attempt: number, nowMs: number) {
    return creatorPayout(
      { creatorId: creatorUserId, amount: money(p.amount), bankAccount: this.opts.bankAccount },
      {
        id: this.ids.uuidV7(),
        idempotencyKey: payoutLedgerKey(p.id, attempt),
        occurredAt: new Date(nowMs),
        ref: { type: "creator_payout", id: p.id },
      },
    );
  }

  /** Finance records what the bank or PSP reported for a SENT payout (no webhooks exist yet). */
  async recordOutcome(input: {
    readonly payoutId: string;
    readonly outcome: "settled" | "rejected";
    readonly providerRef: string | null;
    readonly reason: string | null;
  }): Promise<PayoutResult> {
    const p = await this.store.getPayout(input.payoutId);
    if (p === null) return { kind: "not_found" };
    if (p.state !== "SENT") return { kind: "invalid_transition", state: p.state };
    return this.finish(p, input.outcome, input.providerRef, input.reason);
  }

  private async finish(p: CreatorPayout, outcome: "settled" | "rejected", providerRef: string | null, reason: string | null): Promise<PayoutResult> {
    const nowMs = this.clock.nowMs();
    const a = await this.store.getById(p.creatorId);
    if (a === null) return { kind: "not_found" };
    if (outcome === "settled") {
      const r = await this.store.transitionPayout({
        id: p.id,
        from: "SENT",
        to: applyCreatorPayoutEvent("SENT", "BANK_CONFIRMED", this.ctx({})),
        providerRef,
        nowMs,
        events: [{ type: "creator_payout.settled", creatorId: a.id, payoutId: p.id, amount: p.amount }],
      });
      return r === null ? { kind: "conflict" } : { kind: "ok", payout: r };
    }
    // Rejected: undo the ledger entry of this attempt, then FAILED (retryable via reschedule).
    const original = creatorPayout(
      { creatorId: a.userId, amount: money(p.amount), bankAccount: this.opts.bankAccount },
      {
        id: this.ids.uuidV7(),
        idempotencyKey: payoutLedgerKey(p.id, p.attempt),
        occurredAt: new Date(nowMs),
        ref: { type: "creator_payout", id: p.id },
      },
    );
    await this.ledger.post(
      reverseEntry(original, { id: this.ids.uuidV7(), idempotencyKey: payoutReversalKey(p.id, p.attempt), occurredAt: new Date(nowMs) }),
    );
    const r = await this.store.transitionPayout({
      id: p.id,
      from: "SENT",
      to: applyCreatorPayoutEvent("SENT", "BANK_REJECTED", this.ctx({})),
      failureReason: reason ?? "rejected",
      nowMs,
      events: [{ type: "creator_payout.failed", creatorId: a.id, payoutId: p.id, reason: reason ?? "rejected" }],
    });
    return r === null ? { kind: "conflict" } : { kind: "ok", payout: r };
  }

  async cancel(input: { readonly payoutId: string }): Promise<PayoutResult> {
    const p = await this.store.getPayout(input.payoutId);
    if (p === null) return { kind: "not_found" };
    if (p.state === "SENT" || p.state === "SETTLED" || p.state === "CANCELLED") return { kind: "invalid_transition", state: p.state };
    const to = applyCreatorPayoutEvent(p.state, "CANCEL", this.ctx({}));
    const r = await this.store.transitionPayout({ id: p.id, from: p.state, to, nowMs: this.clock.nowMs(), events: [] });
    return r === null ? { kind: "conflict" } : { kind: "ok", payout: r };
  }
}

export class ListCreatorPayouts {
  constructor(private readonly store: CreatorStore) {}
  async forCreator(userId: string, limit: number): Promise<readonly CreatorPayout[] | null> {
    const a = await this.store.getByUser(userId);
    return a === null ? null : this.store.listPayouts({ creatorId: a.id, limit });
  }
  async forAdmin(filter: { creatorId?: string; state?: PayoutState; limit: number }): Promise<readonly CreatorPayout[]> {
    return this.store.listPayouts(filter);
  }
}
