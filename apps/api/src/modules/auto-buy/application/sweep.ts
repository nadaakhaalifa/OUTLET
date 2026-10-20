import { AUTO_BUY_LIMITS, decideCharge, idempotencyKeyFor, nextAttemptState, type ChargeDecision } from "../domain/bridge";
import type { AttemptRecord, AutoBuyTx, MandateRecord, MitLookup, MitResult } from "../domain/ports";
import { disarmMandate, releaseHold, type AutoBuyDeps } from "./shared";

export interface SweepResult {
  readonly chargePaused: boolean;
  readonly charged: number;
  readonly skipped: number;
  readonly failed: number;
  readonly awaitingSca: number;
  readonly reconciled: number;
  readonly escalated: number;
  readonly retired: number;
  readonly expired: number;
}

export type ScaCompletionResult =
  | { readonly kind: "purchased"; readonly orderGroupId: string | null }
  | { readonly kind: "processing" | "under_review" | "failed" | "not_found" | "not_confirmed" | "unavailable" }
  | { readonly kind: "not_awaiting_sca"; readonly state: AttemptRecord["state"] };

type ChargeOutcome = "charged" | "skipped" | "failed" | "sca" | "pending" | "raced";

/**
 * Periodic worker body: closes what time closes, reconciles what is unresolved by idempotency
 * key (never by guessing), and, only with `kill.auto_buy.charge` allowed, runs due charges.
 * With that switch off no code path below reaches the merchant-initiated charge port.
 */
export class RunAutoBuySweep {
  constructor(private readonly d: AutoBuyDeps) {}

  async execute(limit = 100): Promise<SweepResult> {
    const d = this.d;
    const now = d.clock.nowMs();
    const t = { charged: 0, skipped: 0, failed: 0, awaitingSca: 0, reconciled: 0, escalated: 0, retired: 0, expired: 0 };

    for (const m of await d.store.expiredMandates(now, limit)) {
      if (await this.expire(m, now)) t.expired += 1;
    }
    for (const a of await d.store.stuckTriggered(now - 5 * 60_000, limit)) {
      if (await this.retire(a, "TRIGGERED", "interrupted")) t.retired += 1;
    }
    for (const a of await d.store.staleNotices(now - AUTO_BUY_LIMITS.noticeGraceMs, limit)) {
      if (await this.retire(a, "NOTIFIED", "notice_stale")) t.retired += 1;
    }
    for (const a of await d.store.unresolvedCharges(now - AUTO_BUY_LIMITS.chargeUnresolvedMs, limit)) {
      const r = await this.reconcile(a);
      if (r === "resolved") t.reconciled += 1;
      else if (r === "escalated") t.escalated += 1;
    }
    // A late success must be recorded before anything else can charge again: re-look-up every parked attempt.
    for (const a of await d.store.manualReview(limit)) {
      if ((await this.reconcile(a)) === "resolved") t.reconciled += 1;
    }
    for (const a of await d.store.abandonedSca(now - AUTO_BUY_LIMITS.scaAbandonMs, limit)) {
      const r = await this.abandonSca(a);
      if (r === "failed") t.failed += 1;
      else if (r === "resolved") t.reconciled += 1;
      else if (r === "escalated") t.escalated += 1;
    }

    const chargeOn = await d.flags.chargeEnabled();
    if (chargeOn) {
      for (const a of await d.store.dueAttempts(now, limit)) {
        const r = await this.charge(a.id);
        if (r === "charged") t.charged += 1;
        else if (r === "skipped") t.skipped += 1;
        else if (r === "failed") t.failed += 1;
        else if (r === "sca") t.awaitingSca += 1;
      }
    }
    return { chargePaused: !chargeOn, ...t };
  }

  private async expire(m: MandateRecord, now: number): Promise<boolean> {
    const holds = await this.d.store.run(async (tx) => {
      const cur = await tx.getMandateForUpdate(m.id);
      if (cur === null || cur.status !== "ARMED" || now < cur.expiresAtMs) return null;
      return disarmMandate(tx, cur, "EXPIRED", "expired", "system", now);
    });
    if (holds === null) return false;
    for (const k of holds) await releaseHold(this.d, k);
    return true;
  }

  /** Retires a TRIGGERED or NOTIFIED attempt that can no longer be acted on; nothing is charged. */
  private async retire(a: AttemptRecord, from: "TRIGGERED" | "NOTIFIED", reason: string): Promise<boolean> {
    const now = this.d.clock.nowMs();
    const done = await this.d.store.run(async (tx) => {
      const cur = await tx.getAttemptForUpdate(a.id);
      if (cur === null || cur.state !== from) return false;
      await tx.updateAttempt({
        ...cur,
        state: nextAttemptState(from, "CHECKS_FAILED", { otherChecksPassed: false }),
        failureReason: reason,
        updatedAtMs: now,
      });
      await tx.emit([{ type: "auto_buy.failed", userId: cur.userId, mandateId: cur.mandateId, attemptId: cur.id, reason }]);
      return true;
    });
    if (done) await releaseHold(this.d, a.id);
    return done;
  }

  /**
   * Reconciles an unresolved charge (CHARGING or MANUAL_REVIEW) by idempotency key. Fail closed:
   * FAILED only on `failed` (terminal saga failure). Unknown, throwing, not-found, or in progress
   * too long escalates to MANUAL_REVIEW and keeps the rule from triggering again.
   */
  private async reconcile(a: AttemptRecord): Promise<"resolved" | "escalated" | "waiting"> {
    const d = this.d;
    let found: MitLookup;
    try {
      found = await d.mit.lookup(idempotencyKeyFor(a.mandateId, a.priceEventId));
    } catch {
      found = { kind: "pending" }; // unknown: never assume an outcome
    }
    const startedAt = a.chargeStartedAtMs ?? a.updatedAtMs;
    return this.settleLookup(a, found, d.clock.nowMs() - startedAt >= AUTO_BUY_LIMITS.chargeEscalateMs);
  }

  private async settleLookup(a: AttemptRecord, found: MitLookup, escalateDue: boolean): Promise<"resolved" | "escalated" | "waiting"> {
    const d = this.d;
    const now = d.clock.nowMs();
    const outcome = await d.store.run(async (tx): Promise<"resolved" | "escalated" | "waiting" | "gone"> => {
      const cur = await tx.getAttemptForUpdate(a.id);
      if (cur === null || (cur.state !== "CHARGING" && cur.state !== "REQUIRES_USER_ACTION" && cur.state !== "MANUAL_REVIEW")) return "gone";
      if (found.kind === "placed") {
        // From REQUIRES_USER_ACTION the order still passes through the machine (SCA done, then success).
        const from: AttemptRecord["state"] = cur.state === "REQUIRES_USER_ACTION" ? nextAttemptState(cur.state, "SCA_COMPLETED") : cur.state;
        await this.markPurchased(tx, { ...cur, state: from }, found.orderGroupId, now);
        return "resolved";
      }
      if (found.kind === "failed") {
        const to = cur.state === "REQUIRES_USER_ACTION" ? nextAttemptState(cur.state, "SCA_ABANDONED") : nextAttemptState(cur.state, "CHARGE_FAILED");
        await tx.updateAttempt({ ...cur, state: to, failureReason: "psp_confirmed_not_charged", updatedAtMs: now });
        await tx.emit([{ type: "auto_buy.failed", userId: cur.userId, mandateId: cur.mandateId, attemptId: cur.id, reason: "psp_confirmed_not_charged" }]);
        return "resolved";
      }
      if (cur.state === "MANUAL_REVIEW") return "waiting";
      if (found.kind === "pending" && !escalateDue) return "waiting";
      const reason = found.kind === "pending" ? "unresolved_in_progress" : "unresolved_not_found";
      await tx.updateAttempt({ ...cur, state: nextAttemptState(cur.state, "CHARGE_UNRESOLVED"), failureReason: reason, updatedAtMs: now });
      await tx.emit([{ type: "auto_buy.manual_review", userId: cur.userId, mandateId: cur.mandateId, attemptId: cur.id, reason }]);
      return "escalated";
    });
    if (outcome === "gone") return "waiting";
    // The hold is released on a confirmed non-charge and on escalation; kept while still in progress.
    if (outcome === "escalated" || (outcome === "resolved" && found.kind === "failed")) await releaseHold(d, a.id);
    if (outcome === "resolved" && found.kind === "failed") await this.tell(a, "not_charged");
    if (outcome === "resolved" && found.kind === "placed") await this.tell(a, "charged");
    return outcome;
  }

  private async abandonSca(a: AttemptRecord): Promise<"failed" | "resolved" | "escalated" | "waiting"> {
    const d = this.d;
    let found: MitLookup;
    try {
      found = await d.mit.lookup(idempotencyKeyFor(a.mandateId, a.priceEventId));
    } catch {
      found = { kind: "pending" };
    }
    // Lookup first (B-1): SCA may have been completed at the PSP. No order and no terminal failure is
    // never "abandoned": only a PSP-confirmed non-charge fails the attempt; the rest is a ceiling escalation.
    const escalateDue = d.clock.nowMs() - a.updatedAtMs >= AUTO_BUY_LIMITS.chargeEscalateMs;
    const r = await this.settleLookup(a, found, escalateDue);
    return r === "resolved" && found.kind === "failed" ? "failed" : r;
  }

  private async markPurchased(tx: AutoBuyTx, a: AttemptRecord, orderGroupId: string, now: number): Promise<void> {
    await tx.updateAttempt({ ...a, state: nextAttemptState(a.state, "CHARGE_SUCCEEDED"), orderGroupId, updatedAtMs: now });
    const m = await tx.getMandateForUpdate(a.mandateId);
    if (m !== null && m.status === "ARMED") await tx.closeMandate(m.id, "PURCHASED", "purchased", now);
    await tx.emit([{ type: "auto_buy.charged", userId: a.userId, mandateId: a.mandateId, attemptId: a.id, orderGroupId }]);
  }

  /**
   * The shopper says the 3-DS / SCA challenge is done. The claim is NEVER trusted: the outcome is
   * established by looking the saga up by its idempotency key, exactly as the sweep does.
   *   placed  -> SCA_COMPLETED then CHARGE_SUCCEEDED (PURCHASED, rule closed, shopper told)
   *   failed  -> SCA_ABANDONED (FAILED, hold released, shopper told nothing was charged)
   *   pending -> SCA_COMPLETED (CHARGING): the sweep reconciles and escalates after the ceiling
   *   not_found / lookup error -> no state change; the shopper may retry
   * Owner only: another shopper's attempt is indistinguishable from a missing one.
   */
  async completeSca(userId: string, attemptId: string): Promise<ScaCompletionResult> {
    const d = this.d;
    const a = await d.store.run((tx) => tx.getOwnedAttemptForUpdate(userId, attemptId));
    if (a === null) return { kind: "not_found" };
    switch (a.state) {
      case "PURCHASED":
        return { kind: "purchased", orderGroupId: a.orderGroupId };
      case "CHARGING":
        return { kind: "processing" };
      case "MANUAL_REVIEW":
        return { kind: "under_review" };
      case "FAILED":
        return { kind: "failed" };
      case "REQUIRES_USER_ACTION":
        break;
      default:
        return { kind: "not_awaiting_sca", state: a.state };
    }
    let found: MitLookup;
    try {
      found = await d.mit.lookup(idempotencyKeyFor(a.mandateId, a.priceEventId));
    } catch {
      return { kind: "unavailable" };
    }
    if (found.kind === "not_found") return { kind: "not_confirmed" };
    if (found.kind === "pending") {
      const now = d.clock.nowMs();
      const moved = await d.store.run(async (tx) => {
        const cur = await tx.getOwnedAttemptForUpdate(userId, attemptId);
        if (cur === null || cur.state !== "REQUIRES_USER_ACTION") return false;
        await tx.updateAttempt({ ...cur, state: nextAttemptState(cur.state, "SCA_COMPLETED"), chargeStartedAtMs: now, updatedAtMs: now });
        return true;
      });
      return moved ? { kind: "processing" } : this.completeSca(userId, attemptId);
    }
    await this.settleLookup(a, found, false);
    if (found.kind === "placed") return { kind: "purchased", orderGroupId: found.orderGroupId };
    return { kind: "failed" };
  }

  /** One due attempt: recheck everything, claim, call the PSP port once, record the outcome. */
  async charge(attemptId: string): Promise<ChargeOutcome> {
    const d = this.d;
    const first = await d.store.run(async (tx) => {
      const a = await tx.getAttemptForUpdate(attemptId);
      if (a === null) return null;
      const m = await tx.getMandateForUpdate(a.mandateId);
      return m === null ? null : { a, m };
    });
    if (first === null || first.a.state !== "NOTIFIED" || first.a.mode !== "unattended") return "raced";
    const { m } = first;
    const a0 = first.a;
    if (a0.cancelDeadlineMs === null || d.clock.nowMs() < a0.cancelDeadlineMs) return "raced";
    // A notice that went stale is retired by the sweep, never charged on a late worker.
    if (d.clock.nowMs() > a0.cancelDeadlineMs + AUTO_BUY_LIMITS.noticeGraceMs) return "raced";

    const decision = await this.recheck(m, a0.triggerPrice);
    const now = d.clock.nowMs();
    const claimed = await d.store.run(async (tx): Promise<"raced" | "skipped" | "claimed"> => {
      const a = await tx.getAttemptForUpdate(attemptId);
      // Cancel wins if it committed before this claim: the state is no longer NOTIFIED.
      if (a === null || a.state !== "NOTIFIED") return "raced";
      if (a.cancelDeadlineMs === null || now < a.cancelDeadlineMs) return "raced";
      if (decision.kind === "skip") {
        await tx.updateAttempt({
          ...a,
          state: nextAttemptState("NOTIFIED", "CHECKS_FAILED", { otherChecksPassed: false }),
          failureReason: decision.reason,
          updatedAtMs: now,
        });
        await tx.emit([{ type: "auto_buy.failed", userId: a.userId, mandateId: a.mandateId, attemptId: a.id, reason: decision.reason }]);
        return "skipped";
      }
      await tx.updateAttempt({
        ...a,
        state: nextAttemptState("NOTIFIED", "CANCEL_WINDOW_ELAPSED", { cancelWindowElapsed: true }),
        chargePrice: decision.amount,
        chargeStartedAtMs: now,
        updatedAtMs: now,
      });
      return "claimed";
    });
    if (claimed === "raced") return "raced";
    if (claimed === "skipped") {
      await releaseHold(d, attemptId);
      await this.tell(a0, "not_charged");
      return "skipped";
    }
    if (decision.kind !== "charge") return "raced"; // unreachable: claimed implies charge

    // The switch may have been turned off between the sweep start and now: fail closed.
    if (!(await d.flags.chargeEnabled())) return this.fail(a0, "charge_disabled", decision.amount);

    let result: MitResult;
    try {
      result = await d.mit.placeOrder({
        idempotencyKey: idempotencyKeyFor(m.id, a0.priceEventId),
        userId: m.userId,
        skuId: m.skuId,
        sizeLabel: m.sizeLabel,
        amount: decision.amount,
        tokenRef: m.pspTokenRef ?? "",
        holdKey: attemptId,
      });
    } catch {
      // B-1: a thrown call (socket timeout after the PSP accepted the authorisation) is UNKNOWN, never
      // a failure. The attempt stays CHARGING and the sweep reconciles by idempotency key; no second
      // charge can be sent because the claim is spent and the rule has an attempt in flight.
      return "pending";
    }
    return this.record(a0, result, decision.amount);
  }

  private async record(a0: AttemptRecord, r: MitResult, amount: bigint): Promise<ChargeOutcome> {
    const d = this.d;
    const now = d.clock.nowMs();
    if (r.kind === "declined") return this.fail(a0, `declined:${r.code.slice(0, 32)}`, amount);
    if (r.kind === "pending") return "pending";
    if (r.kind === "sca_required") {
      const ok = await d.store.run(async (tx) => {
        const a = await tx.getAttemptForUpdate(a0.id);
        if (a === null || a.state !== "CHARGING") return false;
        await tx.updateAttempt({ ...a, state: nextAttemptState("CHARGING", "SCA_REQUIRED"), updatedAtMs: now });
        return true;
      });
      if (ok) await this.tell(a0, "sca_required");
      return "sca";
    }
    await d.store.run(async (tx) => {
      const a = await tx.getAttemptForUpdate(a0.id);
      if (a === null || a.state !== "CHARGING") return;
      await this.markPurchased(tx, a, r.orderGroupId, now);
    });
    await this.tell(a0, "charged");
    return "charged";
  }

  private async fail(a0: AttemptRecord, reason: string, amount: bigint): Promise<ChargeOutcome> {
    const d = this.d;
    const now = d.clock.nowMs();
    await d.store.run(async (tx) => {
      const a = await tx.getAttemptForUpdate(a0.id);
      if (a === null || a.state !== "CHARGING") return;
      await tx.updateAttempt({ ...a, state: nextAttemptState("CHARGING", "CHARGE_FAILED"), chargePrice: amount, failureReason: reason, updatedAtMs: now });
      await tx.emit([{ type: "auto_buy.failed", userId: a.userId, mandateId: a.mandateId, attemptId: a.id, reason }]);
    });
    await releaseHold(d, a0.id);
    await this.tell(a0, "not_charged");
    return "failed";
  }

  private async tell(a: AttemptRecord, kind: "charged" | "not_charged" | "sca_required"): Promise<void> {
    try {
      await this.d.notices.send({ userId: a.userId, kind, attemptId: a.id, mandateId: a.mandateId, cancelDeadlineMs: null });
    } catch {
      // The outcome is already recorded and emitted; a missed courtesy notice is retried by the outbox consumer.
    }
  }

  /** Re-reads every fact the decision depends on. Any dependency error is a refusal, never a charge. */
  private async recheck(m: MandateRecord, triggerPrice: bigint): Promise<ChargeDecision | { readonly kind: "skip"; readonly reason: "dependency_unavailable" }> {
    const d = this.d;
    try {
      const [quote, el, token, deliverable] = await Promise.all([
        d.catalog.quote(m.skuId, m.sizeLabel),
        d.eligibility.eligibility(m.userId),
        m.pspTokenRef === null ? Promise.resolve("not_found" as const) : d.vault.inspect(m.userId, m.pspTokenRef),
        d.deliverability.deliverable(m.userId, m.skuId),
      ]);
      const price = quote?.price ?? 0n;
      const [budget, risk] = await Promise.all([
        d.budget.evaluate(m.userId, price),
        d.risk.decide({ userId: m.userId, stage: "charge", skuId: m.skuId, amount: price }),
      ]);
      return decideCharge({
        nowMs: d.clock.nowMs(),
        mandateExpiresAtMs: m.expiresAtMs,
        mandateArmed: m.status === "ARMED",
        maxPrice: m.maxPrice,
        triggerPrice,
        price,
        priceVerified: quote?.priceVerified ?? false,
        priceAnomaly: quote?.priceAnomaly ?? false,
        listed: quote?.listed ?? false,
        sizeInStock: quote?.sizeInStock ?? false,
        deliverable,
        budget,
        risk,
        token,
        plusActive: el.plusActive,
        ageOk: el.ageOk,
        units: 1,
      });
    } catch {
      return { kind: "skip", reason: "dependency_unavailable" };
    }
  }
}
