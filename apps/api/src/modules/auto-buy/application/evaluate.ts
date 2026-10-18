import { z } from "zod";
import {
  AUTO_BUY_LIMITS,
  evaluateTrigger,
  nextAttemptState,
  reservationTtlMs,
  type AutoBuyMode,
  type PriceSignal,
} from "../domain/bridge";
import type { AttemptRecord, MandateRecord } from "../domain/ports";
import { releaseHold, viewOf, type AutoBuyDeps } from "./shared";

const Piastres = z.string().regex(/^[0-9]{1,18}$/);

/** Wire shape of the `price.changed` outbox event. Validated at the boundary. */
export const PriceChangedSchema = z.object({
  event_id: z.string().min(1).max(128),
  sku_id: z.uuid(),
  price: z.object({ amount: Piastres, currency: z.literal("EGP") }),
  verified: z.boolean(),
  anomaly: z.boolean().default(false),
  occurred_at: z.iso.datetime({ offset: true }),
});

export type HandlePriceChangeResult =
  | { readonly kind: "invalid" }
  | { readonly kind: "paused" }
  | { readonly kind: "handled"; readonly matched: number; readonly notified: number; readonly skipped: number; readonly ignored: number };

type One = "ignored" | "duplicate" | "notified" | "skipped";

/**
 * The `auto-buy-evaluator` worker body. At-least-once and idempotent: the unique key
 * (mandate, price_event) is the claim, so a redelivered event creates no second attempt and no
 * second notice. With the rules switch off it does nothing at all (stored rules stay armed).
 */
export class HandlePriceChange {
  constructor(private readonly d: AutoBuyDeps) {}

  async execute(raw: unknown): Promise<HandlePriceChangeResult> {
    const parsed = PriceChangedSchema.safeParse(raw);
    if (!parsed.success) return { kind: "invalid" };
    if (!(await this.d.flags.rulesEnabled())) return { kind: "paused" };
    const chargeOn = await this.d.flags.chargeEnabled();
    const w = parsed.data;
    const signal: PriceSignal = {
      eventId: w.event_id,
      skuId: w.sku_id,
      price: BigInt(w.price.amount),
      verified: w.verified,
      anomaly: w.anomaly,
      occurredAtMs: Date.parse(w.occurred_at),
    };
    const rules = await this.d.store.armedForSku(signal.skuId, signal.price, 500);
    const tally = { matched: rules.length, notified: 0, skipped: 0, ignored: 0 };
    for (const rule of rules) {
      const r = await this.one(rule.id, signal, chargeOn);
      if (r === "notified") tally.notified += 1;
      else if (r === "skipped") tally.skipped += 1;
      else tally.ignored += 1;
    }
    return { kind: "handled", ...tally };
  }

  private async one(mandateId: string, signal: PriceSignal, chargeOn: boolean): Promise<One> {
    const d = this.d;
    const now = d.clock.nowMs();
    const claimed = await d.store.run(
      async (tx): Promise<{ mandate: MandateRecord; attempt: AttemptRecord } | "ignored" | "duplicate"> => {
        const m = await tx.getMandateForUpdate(mandateId);
        if (m === null) return "ignored";
        // A notify-and-confirm notice is informational and never charges, so it does not block a
        // later attempt (the cooldown covers it); everything else in flight does.
        const open = (await tx.openAttemptsOfMandate(m.id)).some((x) => !(x.state === "NOTIFIED" && x.mode === "notify_confirm"));
        const decision = evaluateTrigger(viewOf(m, await tx.lastAttemptAt(m.id), open), signal, now);
        if (decision.kind === "ignore") return "ignored";
        // Mode B only when the mandate is unattended, the price is verified and anomaly-free, and
        // the charge switch is on. Anything else still notifies (mode A) and can never charge.
        const mode: AutoBuyMode = m.mode === "unattended" && decision.unattendedEligible && chargeOn ? "unattended" : "notify_confirm";
        const attempt: AttemptRecord = {
          id: d.ids.uuidV7(),
          mandateId: m.id,
          userId: m.userId,
          priceEventId: signal.eventId,
          mode,
          state: "TRIGGERED",
          triggerPrice: signal.price,
          chargePrice: null,
          noticeSentAtMs: null,
          cancelDeadlineMs: null,
          chargeStartedAtMs: null,
          reservationRef: null,
          orderGroupId: null,
          failureReason: null,
          createdAtMs: now,
          updatedAtMs: now,
        };
        if ((await tx.insertAttempt(attempt)) === "exists") return "duplicate";
        return { mandate: m, attempt };
      },
    );
    if (claimed === "ignored" || claimed === "duplicate") return "ignored";
    return this.finish(claimed.mandate, claimed.attempt);
  }

  /** Checks, hold, notice. Every failure ends in SKIPPED with a reason and a released hold: fail closed. */
  private async finish(m: MandateRecord, a: AttemptRecord): Promise<One> {
    const d = this.d;
    let failure: string | null = null;
    let machine = { plusActive: true, withinBudget: true, eligiblePaymentMethod: true, otherChecksPassed: true };
    let held = false;
    try {
      const el = await d.eligibility.eligibility(m.userId);
      if (!el.plusActive) {
        failure = "plus_lapsed";
        machine = { ...machine, plusActive: false };
      } else if (!el.ageOk) {
        failure = "age_restricted";
        machine = { ...machine, otherChecksPassed: false };
      } else if (a.mode === "unattended") {
        const token = m.pspTokenRef === null ? "not_found" : await d.vault.inspect(m.userId, m.pspTokenRef);
        if (token !== "valid") {
          failure = "token_invalid";
          machine = { ...machine, eligiblePaymentMethod: false };
        } else if ((await d.budget.evaluate(m.userId, m.maxPrice)) !== "within") {
          failure = "budget_cap";
          machine = { ...machine, withinBudget: false };
        } else if ((await d.risk.decide({ userId: m.userId, stage: "charge", skuId: m.skuId, amount: a.triggerPrice })) !== "allow") {
          failure = "risk_not_allowed";
          machine = { ...machine, otherChecksPassed: false };
        } else if (
          (await d.inventory.reserve({ holdKey: a.id, skuId: m.skuId, sizeLabel: m.sizeLabel, ttlMs: reservationTtlMs() })) === "unavailable"
        ) {
          failure = "out_of_stock";
          machine = { ...machine, otherChecksPassed: false };
        } else {
          held = true;
        }
      }
    } catch {
      failure = "dependency_unavailable";
      machine = { ...machine, otherChecksPassed: false };
    }

    if (failure !== null) {
      await this.settle(a, nextAttemptState("TRIGGERED", "CHECKS_FAILED", machine), failure, m);
      if (held) await releaseHold(d, a.id);
      return "skipped";
    }

    const proposed = d.clock.nowMs() + AUTO_BUY_LIMITS.cancelWindowMs;
    const accepted = await d.notices
      .send({
        userId: m.userId,
        kind: a.mode === "unattended" ? "pre_charge" : "target_reached",
        attemptId: a.id,
        mandateId: m.id,
        cancelDeadlineMs: a.mode === "unattended" ? proposed : null,
      })
      .then((r) => r === "accepted")
      .catch(() => false);
    if (!accepted) {
      // A charge may never follow a notice that was not durably enqueued.
      await this.settle(a, nextAttemptState("TRIGGERED", "CHECKS_FAILED", { ...machine, otherChecksPassed: false }), "notice_failed", m);
      if (held) await releaseHold(d, a.id);
      return "skipped";
    }

    // B-8: the window is measured from AFTER the notice was durably enqueued. The shopper was told
    // `proposed`; the charge never runs before the later of the two, so a slow queue cannot eat the window.
    const noticeAt = d.clock.nowMs();
    const deadline = Math.max(proposed, noticeAt + AUTO_BUY_LIMITS.cancelWindowMs);
    const moved = await d.store.run(async (tx): Promise<boolean> => {
      const cur = await tx.getAttemptForUpdate(a.id);
      if (cur === null || cur.state !== "TRIGGERED") return false; // disarmed or cancelled meanwhile: cancel wins
      await tx.updateAttempt({
        ...cur,
        state: nextAttemptState("TRIGGERED", "CHECKS_PASSED", machine),
        noticeSentAtMs: noticeAt,
        cancelDeadlineMs: deadline,
        reservationRef: held ? a.id : null,
        updatedAtMs: noticeAt,
      });
      await tx.emit([
        { type: "auto_buy.notified", userId: m.userId, mandateId: m.id, attemptId: a.id, mode: a.mode, cancelDeadlineMs: a.mode === "unattended" ? deadline : null },
      ]);
      return true;
    });
    if (!moved) {
      if (held) await releaseHold(d, a.id);
      return "ignored";
    }
    return "notified";
  }

  private async settle(a: AttemptRecord, state: AttemptRecord["state"], reason: string, m: MandateRecord): Promise<void> {
    const now = this.d.clock.nowMs();
    await this.d.store.run(async (tx) => {
      const cur = await tx.getAttemptForUpdate(a.id);
      if (cur === null || cur.state !== "TRIGGERED") return;
      await tx.updateAttempt({ ...cur, state, failureReason: reason, updatedAtMs: now });
      await tx.emit([{ type: "auto_buy.failed", userId: m.userId, mandateId: m.id, attemptId: a.id, reason }]);
    });
  }
}
