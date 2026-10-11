import type { Clock, IdGenerator } from "../../../platform/ports";
import {
  DEFAULT_APPROVAL_CONFIG,
  DEFAULT_CYCLE_CONFIG,
  DEFAULT_MINIMUM_PAYOUT_MINOR,
  applyPayoutEvent,
  approvalRequirementMet,
  eventForOutcome,
  latestCycle,
  ledgerPayoutRef,
  payoutApprovalStatus,
  planPayout,
  type PayoutEvent,
  type PayoutState,
} from "../domain/bridge";
import type {
  AttemptLog,
  BankDetails,
  HoldReason,
  IbanNameMatchPort,
  OutboxEventDraft,
  PayoutApprovalsPort,
  PayoutConfig,
  PayoutFlagsPort,
  PayoutLedgerPort,
  PayoutLineRecord,
  PayoutPort,
  PayoutRecord,
  PayoutRiskPort,
  PayoutSourcePort,
  PayoutStore,
  SellerBankPort,
  TransitionCommand,
} from "../domain/ports";

export const DEFAULT_PAYOUT_CONFIG: PayoutConfig = {
  cycle: DEFAULT_CYCLE_CONFIG,
  minimumPayoutMinor: DEFAULT_MINIMUM_PAYOUT_MINOR,
  approval: DEFAULT_APPROVAL_CONFIG,
  bankAccount: "payout_main",
};

export interface PayoutDeps {
  readonly store: PayoutStore;
  readonly source: PayoutSourcePort;
  readonly bank: SellerBankPort;
  readonly nameMatch: IbanNameMatchPort;
  readonly risk: PayoutRiskPort;
  readonly approvals: PayoutApprovalsPort;
  readonly ledger: PayoutLedgerPort;
  readonly provider: PayoutPort;
  readonly flags: PayoutFlagsPort;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly config?: PayoutConfig;
}

export type StaffActor = { readonly id: string };

export type CommandResult =
  | { readonly kind: "ok"; readonly payout: PayoutRecord }
  | { readonly kind: "replayed"; readonly payout: PayoutRecord }
  | { readonly kind: "not_found" }
  | { readonly kind: "conflict" }
  | { readonly kind: "invalid_transition"; readonly status: PayoutState }
  | { readonly kind: "approval_required"; readonly approval: "missing" | "not_covering" }
  | { readonly kind: "open_dispute" }
  | { readonly kind: "hold_not_cleared"; readonly reason: HoldReason };

export type SendResult =
  | { readonly kind: "kill_switch" }
  | { readonly kind: "not_found" }
  | { readonly kind: "invalid_transition"; readonly status: PayoutState }
  | { readonly kind: "held"; readonly reason: HoldReason; readonly payout: PayoutRecord }
  | { readonly kind: "sent" | "settled" | "failed" | "pending"; readonly payout: PayoutRecord }
  | { readonly kind: "conflict" };

export interface ScheduleSummary {
  readonly cycleKey: string;
  readonly created: readonly string[];
  readonly duplicates: readonly string[];
  readonly held: readonly { readonly payoutId: string; readonly reason: HoldReason }[];
  readonly skipped: readonly { readonly storeId: string; readonly reason: "nothing_eligible" | "below_minimum" }[];
}

const SYSTEM = { actorType: "SYSTEM" as const, actorId: null };

/**
 * Payout use cases (spec T4, ADR-0021 points 5 and 7). Every state change is a version-checked,
 * idempotent store transition with its outbox events in the same transaction. Money is posted to
 * the ledger BEFORE the provider is asked to pay, and a provider rejection posts the reversal.
 */
export class PayoutCommands {
  private readonly cfg: PayoutConfig;
  constructor(private readonly d: PayoutDeps) {
    this.cfg = d.config ?? DEFAULT_PAYOUT_CONFIG;
  }

  private event(type: string, p: Pick<PayoutRecord, "id" | "storeId">, nowMs: number, extra: Record<string, string | number | boolean | null> = {}): OutboxEventDraft {
    return {
      id: this.d.ids.uuidV7(),
      type,
      aggregateId: p.id,
      occurredAtMs: nowMs,
      payload: { payout_id: p.id, store_id: p.storeId, ...extra },
    };
  }

  private async transition(
    p: PayoutRecord,
    t: {
      readonly event: PayoutEvent;
      readonly to: PayoutState;
      readonly key: string;
      readonly actorType: "SYSTEM" | "FINANCE";
      readonly actorId: string | null;
      readonly reason?: string | null;
      readonly patch?: TransitionCommand["patch"];
      readonly attempt?: AttemptLog;
      readonly release?: boolean;
      readonly events: readonly OutboxEventDraft[];
    },
  ) {
    return this.d.store.apply({
      payoutId: p.id,
      expectedVersion: p.version,
      commandKey: t.key,
      from: p.status,
      to: t.to,
      event: t.event,
      actorType: t.actorType,
      actorId: t.actorId,
      reasonCode: t.reason ?? null,
      nowMs: this.d.clock.nowMs(),
      historyId: this.d.ids.uuidV7(),
      patch: t.patch ?? {},
      ...(t.attempt !== undefined ? { attempt: t.attempt } : {}),
      releaseLines: t.release ?? false,
      events: t.events,
    });
  }

  // ---------------------------------------------------------------- schedule

  /** Creates one payout per store for the latest weekly cycle. Safe to run any number of times. */
  async schedule(): Promise<ScheduleSummary> {
    const nowMs = this.d.clock.nowMs();
    const cycle = latestCycle(nowMs, this.cfg.cycle);
    const created: string[] = [];
    const duplicates: string[] = [];
    const held: { payoutId: string; reason: HoldReason }[] = [];
    const skipped: { storeId: string; reason: "nothing_eligible" | "below_minimum" }[] = [];

    for (const storeId of await this.d.source.storesWithPayables(cycle.cutoffMs)) {
      const active = await this.d.store.activeSellerOrderIds(storeId);
      const applied = await this.d.store.appliedClawbacks(storeId);
      const items = (await this.d.source.items(storeId, cycle.cutoffMs)).filter((i) => !active.has(i.sellerOrderId));
      const clawbacks = (await this.d.source.clawbacks(storeId))
        .map((c) => ({ ...c, amount: c.amount - (applied.get(c.id) ?? 0n) }))
        .filter((c) => c.amount > 0n);
      const plan = planPayout({
        storeId,
        items,
        clawbacks,
        cutoffMs: cycle.cutoffMs,
        minimumPayoutMinor: this.cfg.minimumPayoutMinor,
      });
      if (!plan.payable || plan.skip !== null) {
        skipped.push({ storeId, reason: plan.skip ?? "nothing_eligible" });
        continue;
      }
      const bank = await this.d.bank.details(storeId);
      const id = this.d.ids.uuidV7();
      const lines: PayoutLineRecord[] = [
        ...plan.eligible.map((i) => ({ sourceType: "seller_order" as const, sourceId: i.sellerOrderId, amount: i.net })),
        ...plan.applied.map((a) => ({ sourceType: "clawback" as const, sourceId: a.clawbackId, amount: a.applied })),
      ];
      const r = await this.d.store.create({
        id,
        storeId,
        cycleKey: cycle.key,
        cutoffAtMs: cycle.cutoffMs,
        amount: plan.payout,
        eligibleTotal: plan.eligibleTotal,
        nettedTotal: plan.nettedTotal,
        carryForward: plan.carryForward,
        accountToken: bank?.accountToken ?? null,
        ibanLast4: bank?.ibanLast4 ?? null,
        lines,
        nowMs,
        event: this.event("payout.scheduled", { id, storeId }, nowMs, {
          cycle_key: cycle.key,
          amount: plan.payout.toString(),
          netted: plan.nettedTotal.toString(),
          line_count: lines.length,
        }),
      });
      if (r.kind === "duplicate") {
        duplicates.push(r.payout.id);
        continue;
      }
      created.push(r.payout.id);
      const reason = await this.holdReasonFor(r.payout, bank);
      if (reason !== null) {
        const res = await this.holdWith(r.payout, reason, SYSTEM, `schedule-hold:${r.payout.id}`);
        if (res.kind === "ok") held.push({ payoutId: r.payout.id, reason });
      }
    }
    return { cycleKey: cycle.key, created, duplicates, held, skipped };
  }

  private async holdReasonFor(p: PayoutRecord, bank: BankDetails | null): Promise<HoldReason | null> {
    if (bank === null || p.accountToken === null) return "no_bank_details";
    const name = await this.d.nameMatch.check({ accountToken: bank.accountToken, expectedLegalName: bank.legalName });
    if (name === "mismatch") return "iban_name_mismatch";
    if (name === "unavailable") return "name_check_unavailable";
    return this.moneyHoldReason(p);
  }

  /**
   * Risk and ledger-balance checks, run at schedule, at approve-from-hold and again at send (the
   * frozen amount does not move, the balance does). HONEST LIMIT (R5): `payableBalance` is the
   * natural `seller_payable` balance, which includes orders that are not CLOSED yet, so it is a
   * floor against overpayment and not a proof that every unit is past its return window; the
   * CLOSED + 3 day rule is enforced by eligibility at schedule time only.
   */
  private async moneyHoldReason(p: PayoutRecord): Promise<HoldReason | null> {
    if ((await this.d.risk.assess({ storeId: p.storeId, amount: p.amount })).hold) return "risk_review";
    if ((await this.d.ledger.payableBalance(p.storeId)) < p.amount) return "exceeds_ledger_balance";
    return null;
  }

  // ---------------------------------------------------------------- hold, approve, cancel, reschedule

  private async holdWith(
    p: PayoutRecord,
    reason: HoldReason,
    who: { readonly actorType: "SYSTEM" | "FINANCE"; readonly actorId: string | null },
    key: string,
  ): Promise<CommandResult> {
    if (!(p.status === "SCHEDULED" || p.status === "APPROVED")) return { kind: "invalid_transition", status: p.status };
    const nowMs = this.d.clock.nowMs();
    const to = applyPayoutEvent(p.status, "RISK_HOLD", { approvalRequirementMet: true, noOpenDispute: true, ibanNameMatched: true });
    const r = await this.transition(p, {
      event: "RISK_HOLD",
      to,
      key,
      ...who,
      reason,
      patch: { holdReason: reason },
      events: [this.event("payout.held", p, nowMs, { reason })],
    });
    return this.result(r);
  }

  private result(r: Awaited<ReturnType<PayoutStore["apply"]>>): CommandResult {
    switch (r.kind) {
      case "applied":
        return { kind: "ok", payout: r.payout };
      case "replayed":
        return { kind: "replayed", payout: r.payout };
      case "conflict":
        return { kind: "conflict" };
      case "not_found":
        return { kind: "not_found" };
    }
  }

  async hold(input: { readonly payoutId: string; readonly actor: StaffActor; readonly key: string }): Promise<CommandResult> {
    const p = await this.d.store.get(input.payoutId, { kind: "system" });
    if (p === null) return { kind: "not_found" };
    const commandKey = `hold:${input.key}`;
    if (await this.d.store.hasCommand(p.id, commandKey)) return { kind: "replayed", payout: p };
    return this.holdWith(p, "manual_hold", { actorType: "FINANCE", actorId: input.actor.id }, commandKey);
  }

  async approve(input: { readonly payoutId: string; readonly actor: StaffActor; readonly key: string }): Promise<CommandResult> {
    const nowMs = this.d.clock.nowMs();
    const p = await this.d.store.get(input.payoutId, { kind: "system" });
    if (p === null) return { kind: "not_found" };
    const commandKey = `approve:${input.key}`;
    if (await this.d.store.hasCommand(p.id, commandKey)) return { kind: "replayed", payout: p };
    if (!(p.status === "SCHEDULED" || p.status === "ON_HOLD")) return { kind: "invalid_transition", status: p.status };

    const records = await this.d.approvals.forPayout(p.id);
    const approval = payoutApprovalStatus({
      payoutId: p.id,
      amountMinor: p.amount,
      records,
      nowMs,
      config: this.cfg.approval,
    });
    if (!approvalRequirementMet(approval)) {
      return { kind: "approval_required", approval: approval.kind === "missing" ? "missing" : "not_covering" };
    }
    // F-7: a hold set by the system for money reasons is lifted only by a fresh check that passes.
    // A manual hold or a bank-detail hold is a human or send-time decision and stays overridable
    // (send re-runs the bank and name checks before anything is posted).
    if (p.status === "ON_HOLD" && (p.holdReason === "exceeds_ledger_balance" || p.holdReason === "risk_review")) {
      const still = await this.moneyHoldReason(p);
      if (still !== null) return { kind: "hold_not_cleared", reason: still };
    }
    const sellerOrders = p.lines.filter((l) => l.sourceType === "seller_order").map((l) => l.sourceId);
    const disputed = await this.d.source.openDisputes(sellerOrders);
    if (disputed.size > 0) return { kind: "open_dispute" };

    const to = applyPayoutEvent(p.status, "APPROVE", { approvalRequirementMet: true, noOpenDispute: true, ibanNameMatched: true });
    const r = await this.transition(p, {
      event: "APPROVE",
      to,
      key: commandKey,
      actorType: "FINANCE",
      actorId: input.actor.id,
      patch: {
        holdReason: null,
        approvedBy: input.actor.id,
        approvedAtMs: nowMs,
        approvalId: approval.kind === "covered" ? approval.approvalId : null,
      },
      events: [
        this.event("payout.approved", p, nowMs, {
          approved_by: input.actor.id,
          dual_approval: approval.kind === "covered",
        }),
      ],
    });
    return this.result(r);
  }

  async cancel(input: { readonly payoutId: string; readonly actor: StaffActor; readonly key: string }): Promise<CommandResult> {
    const nowMs = this.d.clock.nowMs();
    const p = await this.d.store.get(input.payoutId, { kind: "system" });
    if (p === null) return { kind: "not_found" };
    const commandKey = `cancel:${input.key}`;
    if (await this.d.store.hasCommand(p.id, commandKey)) return { kind: "replayed", payout: p };
    if (!(["SCHEDULED", "ON_HOLD", "APPROVED", "FAILED"] as PayoutState[]).includes(p.status)) {
      return { kind: "invalid_transition", status: p.status };
    }
    const r = await this.transition(p, {
      event: "CANCEL",
      to: applyPayoutEvent(p.status, "CANCEL", { approvalRequirementMet: true, noOpenDispute: true, ibanNameMatched: true }),
      key: commandKey,
      actorType: "FINANCE",
      actorId: input.actor.id,
      release: true,
      events: [this.event("payout.cancelled", p, nowMs, { cancelled_by: input.actor.id })],
    });
    // R-5: an entry posted for the next attempt by a send that crashed before its SEND transition
    // must not outlive the cancel. Idempotent; the sweeper repeats it if we crash right here.
    if (r.kind === "applied" || r.kind === "replayed") await this.reverseOrphanEntry(r.payout);
    return this.result(r);
  }

  /** FAILED back to SCHEDULED so it can be approved and sent again. The lines stay with it. */
  async reschedule(input: { readonly payoutId: string; readonly actor: StaffActor; readonly key: string }): Promise<CommandResult> {
    const nowMs = this.d.clock.nowMs();
    const p = await this.d.store.get(input.payoutId, { kind: "system" });
    if (p === null) return { kind: "not_found" };
    const commandKey = `reschedule:${input.key}`;
    if (await this.d.store.hasCommand(p.id, commandKey)) return { kind: "replayed", payout: p };
    if (p.status !== "FAILED") return { kind: "invalid_transition", status: p.status };
    const r = await this.transition(p, {
      event: "RESCHEDULE",
      to: applyPayoutEvent("FAILED", "RESCHEDULE", { approvalRequirementMet: true, noOpenDispute: true, ibanNameMatched: true }),
      key: commandKey,
      actorType: "FINANCE",
      actorId: input.actor.id,
      patch: { failureCode: null, providerRef: null },
      events: [this.event("payout.rescheduled", p, nowMs, {})],
    });
    return this.result(r);
  }

  // ---------------------------------------------------------------- send

  /** Pays an APPROVED payout, or resumes a SENT one. Kill switch, name check, ledger, then provider. */
  async send(payoutId: string): Promise<SendResult> {
    if (!(await this.d.flags.payoutsEnabled())) return { kind: "kill_switch" };
    const p = await this.d.store.get(payoutId, { kind: "system" });
    if (p === null) return { kind: "not_found" };
    if (p.status === "SENT") return this.callProvider(p);
    if (p.status !== "APPROVED") return { kind: "invalid_transition", status: p.status };

    const bank = await this.d.bank.details(p.storeId);
    const reason = await this.sendHoldReason(p, bank);
    if (reason !== null) {
      const h = await this.holdWith(p, reason, SYSTEM, `send-hold:${p.id}:${p.version}`);
      if (h.kind === "ok" || h.kind === "replayed") return { kind: "held", reason, payout: h.payout };
      return { kind: "conflict" };
    }
    const attempt = p.attempts + 1;
    const ref = ledgerPayoutRef(p.id, attempt);
    await this.d.ledger.postPayout({ ref, storeId: p.storeId, amount: p.amount, bankAccount: this.cfg.bankAccount });
    const nowMs = this.d.clock.nowMs();
    const to = applyPayoutEvent("APPROVED", "SEND", { approvalRequirementMet: true, noOpenDispute: true, ibanNameMatched: true });
    const r = await this.transition(p, {
      event: "SEND",
      to,
      key: `send:${ref}`,
      ...SYSTEM,
      patch: { ledgerRef: ref, attempts: attempt, sentAtMs: nowMs, failureCode: null },
      events: [this.event("payout.sent", p, nowMs, { attempt, amount: p.amount.toString() })],
    });
    if (r.kind === "conflict" || r.kind === "not_found") {
      // ADV-W4-5: the version check was lost (cancel, hold or another send won). The entry posted
      // above must not stay live. If the winner is another send of the SAME attempt (it owns the
      // entry through ledgerRef), leave it alone; otherwise reverse it. Reversal is idempotent.
      const now = await this.d.store.get(p.id, { kind: "system" });
      if (now !== null && now.ledgerRef === ref && now.status !== "CANCELLED") return { kind: "conflict" };
      await this.d.ledger.reversePayout(ref);
      return { kind: "conflict" };
    }
    return this.callProvider(r.payout);
  }

  private async sendHoldReason(p: PayoutRecord, bank: BankDetails | null): Promise<HoldReason | null> {
    if (bank === null || p.accountToken === null) return "no_bank_details";
    // A bank account changed after the payout was frozen is a takeover signal: review, never pay.
    if (bank.accountToken !== p.accountToken) return "risk_review";
    const name = await this.d.nameMatch.check({ accountToken: bank.accountToken, expectedLegalName: bank.legalName });
    if (name === "mismatch") return "iban_name_mismatch";
    if (name === "unavailable") return "name_check_unavailable";
    // F-7: the balance can fall between approve and send (refund, chargeback, clawback posted).
    if ((await this.d.ledger.payableBalance(p.storeId)) < p.amount) return "exceeds_ledger_balance";
    return null;
  }

  private async callProvider(p: PayoutRecord): Promise<SendResult> {
    const ref = p.ledgerRef;
    if (ref === null || p.accountToken === null) return { kind: "conflict" };
    const nowMs = this.d.clock.nowMs();
    const outcome = await this.d.provider.send({
      idempotencyKey: ref,
      amount: p.amount,
      accountToken: p.accountToken,
      reference: p.id,
    });
    const log = (code: string | null, providerRef: string | null): AttemptLog => ({
      attemptNo: p.attempts,
      outcome: outcome.kind,
      code,
      providerRef,
      atMs: nowMs,
    });
    switch (outcome.kind) {
      case "unavailable":
        await this.d.store.recordAttempt(p.id, log("unavailable", null));
        return { kind: "pending", payout: p };
      case "accepted":
        await this.d.store.recordAttempt(p.id, log(null, outcome.providerRef));
        return { kind: "sent", payout: p };
      case "settled": {
        const to = applyPayoutEvent("SENT", eventForOutcome("settled") as PayoutEvent, {
          approvalRequirementMet: true,
          noOpenDispute: true,
          ibanNameMatched: true,
        });
        const r = await this.transition(p, {
          event: "BANK_CONFIRMED",
          to,
          key: `settled:${ref}`,
          ...SYSTEM,
          patch: { providerRef: outcome.providerRef, settledAtMs: nowMs },
          attempt: log(null, outcome.providerRef),
          events: [this.event("payout.settled", p, nowMs, { amount: p.amount.toString() })],
        });
        return r.kind === "applied" || r.kind === "replayed" ? { kind: "settled", payout: r.payout } : { kind: "conflict" };
      }
      case "rejected": {
        // Ledger first: undo the payout entry, then record the failure.
        await this.d.ledger.reversePayout(ref);
        const to = applyPayoutEvent("SENT", "BANK_REJECTED", {
          approvalRequirementMet: true,
          noOpenDispute: true,
          ibanNameMatched: true,
        });
        const r = await this.transition(p, {
          event: "BANK_REJECTED",
          to,
          key: `rejected:${ref}`,
          ...SYSTEM,
          reason: outcome.code,
          patch: { failureCode: outcome.code },
          attempt: log(outcome.code, null),
          events: [this.event("payout.failed", p, nowMs, { code: outcome.code })],
        });
        return r.kind === "applied" || r.kind === "replayed" ? { kind: "failed", payout: r.payout } : { kind: "conflict" };
      }
    }
  }

  /** R-5: reverses the entry of the NEXT attempt when the payout is not in a state that owns it. */
  private async reverseOrphanEntry(p: PayoutRecord): Promise<boolean> {
    const ref = ledgerPayoutRef(p.id, p.attempts + 1);
    if (!(await this.d.ledger.hasPayoutEntry(ref))) return false;
    await this.d.ledger.reversePayout(ref);
    return true;
  }

  /**
   * R-5 sweeper. Finds payouts with a posted-but-unowned payout entry (crash between postPayout
   * and the SEND transition). CANCELLED, ON_HOLD, SCHEDULED, FAILED: reverse. APPROVED older than
   * `staleMs`: resume through send (same key, so the entry is reused, never doubled). Idempotent.
   */
  async recoverOrphanEntries(staleMs = 10 * 60_000, limit = 100): Promise<{ reversed: number; resumed: number }> {
    let reversed = 0;
    let resumed = 0;
    const now = this.d.clock.nowMs();
    for (const status of ["CANCELLED", "ON_HOLD", "SCHEDULED", "FAILED"] as PayoutState[]) {
      for (const id of await this.d.store.listIdsByStatus(status, limit)) {
        const p = await this.d.store.get(id, { kind: "system" });
        if (p === null || p.status !== status) continue;
        if (await this.reverseOrphanEntry(p)) reversed += 1;
      }
    }
    for (const id of await this.d.store.listIdsByStatus("APPROVED", limit)) {
      const p = await this.d.store.get(id, { kind: "system" });
      if (p === null || p.status !== "APPROVED" || now - p.updatedAtMs < staleMs) continue;
      if (!(await this.d.ledger.hasPayoutEntry(ledgerPayoutRef(p.id, p.attempts + 1)))) continue;
      await this.send(p.id);
      resumed += 1;
    }
    return { reversed, resumed };
  }

  /** Job: re-asks the provider about every SENT payout (idempotent by key). */
  async advanceSent(limit = 100): Promise<readonly SendResult[]> {
    const out: SendResult[] = [];
    for (const id of await this.d.store.listIdsByStatus("SENT", limit)) out.push(await this.send(id));
    return out;
  }
}
