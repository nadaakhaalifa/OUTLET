import {
  cancel,
  cancelWithRefund,
  dunningAttemptKey,
  InvalidSubscriptionTransition,
  SubscriptionRuleError,
  money,
  pause,
  plusRevenueRecognised,
  prorationCredit,
  reactivate,
  refundEligibility,
  resume,
  reverseEntry,
  scheduleSwitch,
  subtract,
  planSwitch,
  switchKind,
  switchNow,
  upgradeCharge,
  validPauseMonths,
  vatIncluded,
  plusCharged,
  type PlusSubscription,
} from "../domain/bridge";
import type { ClientAction } from "../domain/ports";
import {
  applyTransition,
  buildInvoice,
  chargeLedgerKey,
  ledgerMeta,
  periodsFor,
  planFor,
  postCharge,
  queueReceipt,
  type PlusDeps,
} from "./shared";

const isStateError = (e: unknown): boolean =>
  e instanceof InvalidSubscriptionTransition || e instanceof SubscriptionRuleError;

export type ManageResult =
  | { readonly kind: "ok"; readonly subscription: PlusSubscription }
  | { readonly kind: "not_found" }
  | { readonly kind: "invalid_state" }
  | { readonly kind: "invalid_months" }
  | { readonly kind: "conflict" };

async function save(
  d: PlusDeps,
  prev: PlusSubscription,
  next: PlusSubscription,
  event: Parameters<typeof applyTransition>[4],
): Promise<ManageResult> {
  const r = await applyTransition(d, prev, next, d.clock.nowMs(), event);
  if (r !== "ok") return { kind: "conflict" };
  return { kind: "ok", subscription: (await d.store.getSubscription(next.id)) ?? next };
}

/** Cancel: at most two taps in the app, no confirm-shaming, benefits until period_end exactly. */
export class CancelPlus {
  constructor(private readonly d: PlusDeps) {}
  async execute(userId: string): Promise<ManageResult> {
    const sub = await this.d.store.getLiveByUser(userId);
    if (sub === null) return { kind: "not_found" };
    if (sub.status === "CANCELLED_AT_PERIOD_END") return { kind: "ok", subscription: sub };
    try {
      const next = cancel(sub, this.d.clock.nowMs());
      return await save(this.d, sub, next, [
        { type: "plus.cancel_requested", subscriptionId: sub.id, userId, effectiveAtMs: next.periodEndMs },
      ]);
    } catch (e) {
      if (isStateError(e)) return { kind: "invalid_state" };
      throw e;
    }
  }
}

export class ReactivatePlus {
  constructor(private readonly d: PlusDeps) {}
  async execute(userId: string): Promise<ManageResult> {
    const sub = await this.d.store.getLiveByUser(userId);
    if (sub === null) return { kind: "not_found" };
    try {
      return await save(this.d, sub, reactivate(sub, this.d.clock.nowMs()), [
        { type: "plus.reactivated", subscriptionId: sub.id, userId },
      ]);
    } catch (e) {
      if (isStateError(e)) return { kind: "invalid_state" };
      throw e;
    }
  }
}

export class PausePlus {
  constructor(private readonly d: PlusDeps) {}
  async execute(userId: string, months: number): Promise<ManageResult> {
    if (!validPauseMonths(months)) return { kind: "invalid_months" };
    const sub = await this.d.store.getLiveByUser(userId);
    if (sub === null) return { kind: "not_found" };
    if (sub.status === "PAUSED") return { kind: "ok", subscription: sub };
    try {
      const next = pause(sub, this.d.clock.nowMs(), months);
      return await save(this.d, sub, next, [
        { type: "plus.paused", subscriptionId: sub.id, userId, untilMs: next.pausedUntilMs ?? next.periodEndMs },
      ]);
    } catch (e) {
      if (isStateError(e)) return { kind: "invalid_state" };
      throw e;
    }
  }
}

export class ResumePlus {
  constructor(private readonly d: PlusDeps) {}
  async execute(userId: string): Promise<ManageResult> {
    const sub = await this.d.store.getLiveByUser(userId);
    if (sub === null) return { kind: "not_found" };
    try {
      return await save(this.d, sub, resume(sub, this.d.clock.nowMs()), [
        { type: "plus.resumed", subscriptionId: sub.id, userId },
      ]);
    } catch (e) {
      if (isStateError(e)) return { kind: "invalid_state" };
      throw e;
    }
  }
}

export type SwitchResult =
  | ManageResult
  | { readonly kind: "plan_not_found" }
  | { readonly kind: "same_plan" }
  | { readonly kind: "student_verification_required" }
  | { readonly kind: "payment_failed"; readonly reason: string }
  | { readonly kind: "requires_action"; readonly action: ClientAction };

/**
 * Monthly -> yearly: immediate, credit = unused full days of what the member actually paid for the
 * monthly period, charged 800 minus credit, the used share is recognised now and the unused share
 * stays deferred and rolls into the yearly invoice (so deferred revenue is conserved).
 * Yearly -> monthly: scheduled for period_end, no money moves.
 */
export class SwitchPlan {
  constructor(private readonly d: PlusDeps) {}

  async execute(userId: string, toCode: string): Promise<SwitchResult> {
    const d = this.d;
    const sub = await d.store.getLiveByUser(userId);
    if (sub === null) return { kind: "not_found" };
    if (sub.status !== "ACTIVE") return { kind: "invalid_state" };
    const now = d.clock.nowMs();
    const target = await planFor(d, toCode, now);
    if (target === null) return { kind: "plan_not_found" };
    if (target.code === sub.planCode) return { kind: "same_plan" };
    if ((target.kind ?? "individual") === "student") {
      if (d.students === undefined || !(await d.students.validAt(userId, now))) {
        return { kind: "student_verification_required" };
      }
    }
    // Phase 3: same interval plans compare by price (yearly -> family is an upgrade, family -> yearly
    // waits for period end). With no price on record the Phase 2 interval rule applies unchanged.
    const current = await d.store.getPlan(sub.planId);
    const kind =
      current === null
        ? switchKind(sub.interval, target.interval)
        : planSwitch(
            { code: sub.planCode, interval: sub.interval, priceMinor: current.priceMinor },
            { code: target.code, interval: target.interval, priceMinor: target.priceMinor },
          );
    if (kind === "same") return { kind: "same_plan" };

    if (kind === "downgrade_at_period_end") {
      if (sub.pendingPlanCode === target.code) return { kind: "ok", subscription: sub };
      return save(d, sub, scheduleSwitch(sub, target.code), [
        { type: "plus.plan_switched", subscriptionId: sub.id, userId, from: sub.planCode, to: target.code, immediate: false },
      ]);
    }

    const old = await d.store.latestPaidInvoice(sub.id);
    const paidMinor = old?.amountMinor ?? 0n;
    const credit = paidMinor === 0n
      ? 0n
      : prorationCredit({
          monthlyPriceMinor: paidMinor,
          periodStartMs: sub.periodStartMs,
          periodEndMs: sub.periodEndMs,
          nowMs: now,
        }).creditMinor;
    const charge = upgradeCharge(target.priceMinor, credit);
    const next = switchNow(sub, now, target);
    let pspRef: string | null = null;
    let provider = "none";
    if (charge.chargeMinor > 0n) {
      const out = await d.charges.charge({
        idempotencyKey: dunningAttemptKey(sub.id, next.cycle, 0),
        userId,
        pspTokenRef: sub.pspTokenRef,
        amountMinor: charge.chargeMinor,
        currency: "EGP",
        description: "plus",
      });
      if (out.kind === "failed") return { kind: "payment_failed", reason: out.reason };
      if (out.kind === "requires_action") return { kind: "requires_action", action: out.action };
      pspRef = out.pspRef;
      provider = out.provider;
    }
    const invoice = buildInvoice(
      d,
      {
        subscriptionId: sub.id,
        userId,
        cycle: next.cycle,
        attempt: 0,
        kind: "upgrade",
        amountMinor: charge.chargeMinor,
        creditAppliedMinor: charge.creditAppliedMinor,
        periodStartMs: now,
        periodsTotal: periodsFor(target.interval),
        status: "PAID",
        provider: charge.chargeMinor > 0n ? provider : null,
        pspRef,
      },
      now,
    );
    // Ledger first, idempotent: recognise the used share of the old invoice, then book the cash.
    const invoices = [invoice];
    if (old !== null && old.periodsRecognised < old.periodsTotal) {
      const creditNet = credit - (credit === 0n ? 0n : vatIncluded(money(credit), d.cfg.vatBps).amount);
      const usedNet = subtract(money(old.netRecognitionMinor), money(creditNet));
      if (usedNet.amount > 0n) {
        await d.ledger.post(
          plusRevenueRecognised({ amount: usedNet }, ledgerMeta(d, `plus:invoice:${old.id}:switch-recognised`, old.id)),
        );
      }
      invoices.push({ ...old, periodsRecognised: old.periodsTotal });
    }
    await postCharge(d, invoice);
    const r = await applyTransition(
      d,
      sub,
      next,
      now,
      [{ type: "plus.plan_switched", subscriptionId: sub.id, userId, from: sub.planCode, to: target.code, immediate: true }],
      { invoices },
    );
    if (r !== "ok") return { kind: "conflict" };
    await queueReceipt(d, invoice);
    return { kind: "ok", subscription: (await d.store.getSubscription(sub.id)) ?? next };
  }
}

export type RefundResult =
  | { readonly kind: "refunded"; readonly subscription: PlusSubscription; readonly amountMinor: bigint }
  | { readonly kind: "not_found" }
  | { readonly kind: "not_eligible"; readonly reason: "window_elapsed" | "benefit_used" | "already_refunded" | "state" }
  | { readonly kind: "refund_failed"; readonly reason: string }
  | { readonly kind: "conflict" };

/** Full refund within 14 days of the charge when no benefit was used since (VR-P2-01 default). */
export class RefundPlus {
  constructor(private readonly d: PlusDeps) {}

  async execute(userId: string): Promise<RefundResult> {
    const d = this.d;
    const sub = await d.store.getLiveByUser(userId);
    if (sub === null) return { kind: "not_found" };
    const latest = await d.store.latestPaidInvoice(sub.id);
    if (latest === null || latest.chargedAtMs === null) return { kind: "not_found" };
    // B-4: refund everything paid for this cycle. After monthly -> yearly the latest invoice is
    // the upgrade (yearly price minus credit); the superseded monthly invoice was paid in cash too.
    const all = await d.store.listInvoices(sub.id);
    const paid = all.filter((i) => i.status === "PAID" && i.id !== latest.id && i.cycle === latest.cycle);
    if (latest.kind === "upgrade") {
      const prior = all
        .filter((i) => i.status === "PAID" && i.kind !== "upgrade" && i.cycle < latest.cycle)
        .sort((a, b) => b.cycle - a.cycle || b.attempt - a.attempt)[0];
      if (prior !== undefined) paid.push(prior);
    }
    const invoices = [latest, ...paid];
    const total = invoices.reduce((a, i) => a + i.amountMinor, 0n);
    const now = d.clock.nowMs();
    const earliest = Math.min(...invoices.map((i) => i.chargedAtMs ?? latest.chargedAtMs ?? now));
    const used = await d.store.benefitUsedSince(userId, earliest);
    const e = refundEligibility({
      chargedAtMs: latest.chargedAtMs,
      nowMs: now,
      benefitUsedSinceCharge: used,
      alreadyRefunded: latest.status === "REFUNDED",
    });
    if (!e.eligible) return { kind: "not_eligible", reason: e.reason };
    if (sub.status !== "ACTIVE") return { kind: "not_eligible", reason: "state" };

    for (const invoice of invoices) {
      if (invoice.amountMinor === 0n) continue;
      const out = await d.refunds.refund({
        idempotencyKey: `plus:refund:${invoice.id}`,
        userId,
        invoiceId: invoice.id,
        pspRef: invoice.pspRef,
        amountMinor: invoice.amountMinor,
      });
      if (out.kind === "failed") return { kind: "refund_failed", reason: out.reason };
      if (invoice.provider === null || invoice.provider === "") {
        return { kind: "refund_failed", reason: "invoice_provider_missing" };
      }
      const original = plusCharged(
        { tender: { kind: "psp", psp: invoice.provider, amount: money(invoice.amountMinor) }, vatBps: d.cfg.vatBps },
        ledgerMeta(d, chargeLedgerKey(invoice), invoice.id),
      );
      await d.ledger.post(
        reverseEntry(original, {
          id: d.ids.uuidV7(),
          idempotencyKey: `plus:invoice:${invoice.id}:refunded`,
          occurredAt: new Date(now),
        }),
      );
      // The superseded monthly invoice had its used share recognised at the switch: undo it too.
      if (latest.kind === "upgrade" && invoice.id !== latest.id && invoice.kind !== "upgrade") {
        const credit = latest.creditAppliedMinor;
        const creditNet = credit - (credit === 0n ? 0n : vatIncluded(money(credit), d.cfg.vatBps).amount);
        const usedNet = subtract(money(invoice.netRecognitionMinor), money(creditNet));
        if (usedNet.amount > 0n) {
          const rec = plusRevenueRecognised({ amount: usedNet }, ledgerMeta(d, `plus:invoice:${invoice.id}:switch-recognised`, invoice.id));
          await d.ledger.post(
            reverseEntry(rec, { id: d.ids.uuidV7(), idempotencyKey: `plus:invoice:${invoice.id}:switch-recognised:refunded`, occurredAt: new Date(now) }),
          );
        }
      }
    }
    const next = cancelWithRefund(sub);
    const r = await applyTransition(
      d,
      sub,
      next,
      now,
      [
        { type: "plus.refunded", subscriptionId: sub.id, userId, invoiceId: latest.id, amountMinor: total.toString() },
        { type: "plus.expired", subscriptionId: sub.id, userId, reason: "refunded" },
      ],
      {
        invoices: invoices.map((i) => ({ ...i, status: "REFUNDED" as const, refundedAtMs: now, periodsRecognised: i.periodsTotal })),
      },
    );
    if (r !== "ok") return { kind: "conflict" };
    return { kind: "refunded", subscription: (await d.store.getSubscription(sub.id)) ?? next, amountMinor: total };
  }
}
