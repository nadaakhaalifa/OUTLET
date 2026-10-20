import {
  convertTrial,
  dunningAttemptKey,
  dunningFailed,
  dunningSucceeded,
  expireUnpaidTrial,
  graceElapsed,
  money,
  nextDunningAction,
  periodEnded,
  planPlusRecognition,
  plusCharged,
  plusRevenueRecognised,
  recognitionDue,
  renewFailed,
  renewSucceeded,
  resume,
  reverseEntry,
  selectPlanVersion,
  trialReminderSent,
  type PlusPlan,
  type PlusSubscription,
} from "../domain/bridge";
import type { InvoiceKind, InvoiceRecord, PlusEvent, RecurringWebhookEvent } from "../domain/ports";
import {
  applyTransition,
  buildInvoice,
  ledgerMeta,
  periodsFor,
  planFor,
  postCharge,
  queueReceipt,
  type PlusDeps,
} from "./shared";
import { completeSignup } from "./subscribe";

/** The cheapest active individual plan with the same interval, in force at `atMs`. */
async function individualFallback(d: PlusDeps, from: PlusPlan, atMs: number): Promise<PlusPlan | null> {
  const all = await d.store.listPlanVersions();
  const codes = [...new Set(all.filter((p) => (p.kind ?? "individual") === "individual" && p.interval === from.interval).map((p) => p.code))];
  const picked = codes
    .map((c) => selectPlanVersion(all.filter((p) => p.code === c), atMs))
    .filter((p): p is PlusPlan => p !== null)
    .sort((a, b) => (a.priceMinor < b.priceMinor ? -1 : a.priceMinor > b.priceMinor ? 1 : a.code.localeCompare(b.code)));
  return picked[0] ?? null;
}

export interface SweepSummary {
  readonly examined: number;
  readonly renewed: number;
  readonly failed: number;
  readonly expired: number;
  readonly other: number;
  readonly errors: number;
}

type Step = "renewed" | "failed" | "expired" | "other";

/**
 * Renewal sweeper (pg_cron or a worker tick). Idempotent per cycle: every charge carries
 * `sub:{id}:cycle:{n}:attempt:{k}`, invoices are unique on that triple, and every state change is
 * guarded by the subscription's version, so overlapping runs and replays cannot double charge.
 * The `plus_sales` kill switch does not stop renewals (spec Failure handling).
 */
export class RunRenewalSweep {
  constructor(private readonly d: PlusDeps) {}

  async execute(limit = 100): Promise<SweepSummary> {
    const now = this.d.clock.nowMs();
    const due = await this.d.store.listDue(now, limit);
    const t = { renewed: 0, failed: 0, expired: 0, other: 0, errors: 0 };
    for (const sub of due) {
      try {
        t[await this.one(sub, now)] += 1;
      } catch {
        t.errors += 1;
      }
    }
    return { examined: due.length, ...t };
  }

  private async one(sub: PlusSubscription, now: number): Promise<Step> {
    switch (sub.status) {
      case "TRIALING":
        return this.trial(sub, now);
      case "ACTIVE":
        return sub.periodEndMs <= now ? this.renew(sub, now) : "other";
      case "PAST_DUE":
        return this.dunning(sub, now);
      case "CANCELLED_AT_PERIOD_END":
        return sub.periodEndMs <= now ? this.endPeriod(sub, now) : "other";
      case "PAUSED":
        return this.resumeIfDue(sub, now);
      case "EXPIRED":
        return "other";
    }
  }

  private async targetPlan(sub: PlusSubscription, atMs: number): Promise<PlusPlan | null> {
    const plan = await planFor(this.d, sub.pendingPlanCode ?? sub.planCode, atMs);
    if (plan === null || plan.kind !== "student") return plan;
    // Student price needs a verified, unexpired status at the renewal instant; no evidence means the
    // individual plan of the same interval (never a silent discount, and never a silent increase:
    // `renewalPrice` only reverts once a 30 day notice is out).
    const price = this.d.students === undefined ? "individual" : await this.d.students.renewalPrice(sub.userId, atMs);
    if (price === "student") return plan;
    return individualFallback(this.d, plan, atMs);
  }

  private async charge(
    sub: PlusSubscription,
    plan: PlusPlan,
    cycle: number,
    attempt: number,
    kind: InvoiceKind,
    now: number,
  ): Promise<{ readonly ok: boolean; readonly invoice: InvoiceRecord }> {
    const out = await this.d.charges.charge({
      idempotencyKey: dunningAttemptKey(sub.id, cycle, attempt),
      userId: sub.userId,
      pspTokenRef: sub.pspTokenRef,
      amountMinor: plan.priceMinor,
      currency: "EGP",
      description: "plus",
    });
    const ok = out.kind === "succeeded";
    const invoice = buildInvoice(
      this.d,
      {
        subscriptionId: sub.id,
        userId: sub.userId,
        cycle,
        attempt,
        kind,
        amountMinor: plan.priceMinor,
        periodStartMs: now,
        periodsTotal: periodsFor(plan.interval),
        status: ok ? "PAID" : "FAILED",
        provider: out.provider,
        pspRef: out.kind === "succeeded" || out.kind === "requires_action" ? out.pspRef : null,
      },
      now,
    );
    // Off-session charges cannot satisfy a 3-DS challenge: treated as a failed attempt (retried by dunning).
    if (ok) await postCharge(this.d, invoice);
    return { ok, invoice };
  }

  private async trial(sub: PlusSubscription, now: number): Promise<Step> {
    const d = this.d;
    const end = sub.trialEndMs ?? sub.periodEndMs;
    if (now < end) {
      if (sub.trialReminderSentAtMs !== null) return "other";
      await d.notices.send({
        userId: sub.userId,
        template: "plus_trial_reminder",
        data: { charge_at_ms: end, plan_code: sub.planCode },
      });
      await applyTransition(d, sub, trialReminderSent(sub, now), now, []);
      return "other";
    }
    const plan = await this.targetPlan(sub, now);
    if (plan === null) return this.finishUnpaidTrial(sub, now);
    const { ok, invoice } = await this.charge(sub, plan, 1, 0, "first", now);
    if (!ok) return this.finishUnpaidTrial(sub, now, invoice);
    const r = await applyTransition(
      d,
      sub,
      convertTrial(sub, now, plan),
      now,
      [{ type: "plus.renewed", subscriptionId: sub.id, userId: sub.userId, cycle: 1, invoiceId: invoice.id }],
      { invoices: [invoice] },
    );
    if (r === "ok") await queueReceipt(d, invoice);
    return r === "ok" ? "renewed" : "other";
  }

  private async finishUnpaidTrial(sub: PlusSubscription, now: number, invoice?: InvoiceRecord): Promise<Step> {
    const d = this.d;
    const events: PlusEvent[] = [
      { type: "plus.payment_failed", subscriptionId: sub.id, userId: sub.userId, attempt: 0 },
      { type: "plus.expired", subscriptionId: sub.id, userId: sub.userId, reason: "trial_unpaid" },
    ];
    const r = await applyTransition(d, sub, expireUnpaidTrial(sub), now, events, invoice ? { invoices: [invoice] } : {});
    if (r === "ok") await d.notices.send({ userId: sub.userId, template: "plus_expired", data: {} });
    return r === "ok" ? "expired" : "other";
  }

  private async renew(sub: PlusSubscription, now: number): Promise<Step> {
    const d = this.d;
    const plan = await this.targetPlan(sub, sub.periodEndMs);
    if (plan === null) return "other";
    const cycle = sub.cycle + 1;
    const { ok, invoice } = await this.charge(sub, plan, cycle, 0, "renewal", now);
    if (ok) {
      const r = await applyTransition(
        d,
        sub,
        renewSucceeded(sub, now, plan),
        now,
        [{ type: "plus.renewed", subscriptionId: sub.id, userId: sub.userId, cycle, invoiceId: invoice.id }],
        { invoices: [invoice] },
      );
      if (r === "ok") {
        await queueReceipt(d, invoice);
        if (plan.code !== (sub.pendingPlanCode ?? sub.planCode)) {
          await d.notices.send({ userId: sub.userId, template: "student_price_ended", data: { plan_code: plan.code } });
        }
      }
      return r === "ok" ? "renewed" : "other";
    }
    const r = await applyTransition(
      d,
      sub,
      renewFailed(sub, now),
      now,
      [{ type: "plus.payment_failed", subscriptionId: sub.id, userId: sub.userId, attempt: 0 }],
      { invoices: [invoice] },
    );
    if (r === "ok") {
      await d.notices.send({ userId: sub.userId, template: "plus_payment_failed", data: { attempt: 0 } });
    }
    return r === "ok" ? "failed" : "other";
  }

  private async dunning(sub: PlusSubscription, now: number): Promise<Step> {
    const d = this.d;
    if (sub.failedAtMs === null) return "other";
    const action = nextDunningAction(sub.failedAtMs, sub.dunningAttempts, now);
    if (action.kind === "wait") return "other";
    if (action.kind === "expire") {
      const r = await applyTransition(d, sub, graceElapsed(sub), now, [
        { type: "plus.expired", subscriptionId: sub.id, userId: sub.userId, reason: "grace_elapsed" },
      ]);
      if (r === "ok") await d.notices.send({ userId: sub.userId, template: "plus_expired", data: {} });
      return r === "ok" ? "expired" : "other";
    }
    const plan = await this.targetPlan(sub, now);
    if (plan === null) return "other";
    const { ok, invoice } = await this.charge(sub, plan, sub.cycle, action.attempt, "dunning", now);
    if (ok) {
      const r = await applyTransition(
        d,
        sub,
        dunningSucceeded(sub, now, plan),
        now,
        [{ type: "plus.renewed", subscriptionId: sub.id, userId: sub.userId, cycle: sub.cycle, invoiceId: invoice.id }],
        { invoices: [invoice] },
      );
      if (r === "ok") await queueReceipt(d, invoice);
      return r === "ok" ? "renewed" : "other";
    }
    const r = await applyTransition(
      d,
      sub,
      dunningFailed(sub, action.attempt, now),
      now,
      [{ type: "plus.payment_failed", subscriptionId: sub.id, userId: sub.userId, attempt: action.attempt }],
      { invoices: [invoice] },
    );
    if (r === "ok") {
      await d.notices.send({ userId: sub.userId, template: "plus_payment_failed", data: { attempt: action.attempt } });
    }
    return r === "ok" ? "failed" : "other";
  }

  private async endPeriod(sub: PlusSubscription, now: number): Promise<Step> {
    const r = await applyTransition(this.d, sub, periodEnded(sub), now, [
      { type: "plus.expired", subscriptionId: sub.id, userId: sub.userId, reason: "period_ended" },
    ]);
    return r === "ok" ? "expired" : "other";
  }

  private async resumeIfDue(sub: PlusSubscription, now: number): Promise<Step> {
    if (sub.pausedUntilMs === null || sub.pausedUntilMs > now) return "other";
    await applyTransition(this.d, sub, resume(sub, now), now, [
      { type: "plus.resumed", subscriptionId: sub.id, userId: sub.userId },
    ]);
    return "other";
  }
}

/** Monthly deferred -> recognised revenue (spec Revenue). One idempotent entry per invoice month. */
export class RecognizeDeferredRevenue {
  constructor(private readonly d: PlusDeps) {}

  async execute(limit = 200): Promise<{ readonly entries: number }> {
    const d = this.d;
    const now = d.clock.nowMs();
    let entries = 0;
    for (const inv of await d.store.listForRecognition(limit)) {
      const due = recognitionDue({
        periodStartMs: inv.periodStartMs,
        periodsTotal: inv.periodsTotal,
        periodsRecognised: inv.periodsRecognised,
        nowMs: now,
      });
      if (due === 0) continue;
      const parts = planPlusRecognition(money(inv.netRecognitionMinor), inv.periodsTotal);
      for (let k = inv.periodsRecognised; k < inv.periodsRecognised + due; k += 1) {
        const part = parts[k];
        if (part === undefined || part.amount === 0n) continue;
        await d.ledger.post(
          plusRevenueRecognised({ amount: part }, ledgerMeta(d, `plus:invoice:${inv.id}:recognise:${k + 1}`, inv.id)),
        );
        entries += 1;
      }
      await d.store.commit({ invoices: [{ ...inv, periodsRecognised: inv.periodsRecognised + due }], events: [] });
    }
    return { entries };
  }
}

export type WebhookResult = "applied" | "duplicate" | "ignored";

/** Verified, normalized PSP recurring events. The server is the source of truth; replays are no-ops. */
export class HandleRecurringWebhook {
  constructor(private readonly d: PlusDeps) {}

  async execute(e: RecurringWebhookEvent): Promise<WebhookResult> {
    const d = this.d;
    const now = d.clock.nowMs();
    if (e.kind === "signup.charge_failed") {
      const s = await d.store.getSignup(e.signupId);
      if (s === null || s.status !== "PENDING") return "ignored";
      const r = await d.store.commit({
        signup: { ...s, status: "FAILED", updatedAtMs: now },
        webhookEvent: { provider: e.provider, eventId: e.eventId },
        events: [],
      });
      return r === "duplicate_event" ? "duplicate" : "applied";
    }
    if (e.kind === "signup.charge_succeeded") {
      const s = await d.store.getSignup(e.signupId);
      if (s === null || s.status === "COMPLETED") return "ignored";
      const done = await completeSignup(d, s, e.provider, e.pspRef, { provider: e.provider, eventId: e.eventId });
      return done.kind === "subscribed" || done.kind === "existing" ? "applied" : "ignored";
    }
    // renewal.charge_succeeded: a late confirmation for a charge we recorded as failed (B-4).
    const sub = await d.store.getSubscription(e.subscriptionId);
    if (sub === null || sub.cycle !== e.cycle) return "ignored";
    const cycleInvoices = (await d.store.listInvoices(sub.id)).filter((i) => i.cycle === e.cycle);
    const alreadyPaid = cycleInvoices.find((i) => i.status === "PAID" && i.kind !== "upgrade");
    if (alreadyPaid !== undefined && alreadyPaid.pspRef === e.pspRef) return "duplicate";
    const plan = await planFor(d, sub.pendingPlanCode ?? sub.planCode, now);
    if (plan === null) return "ignored";
    const failed = cycleInvoices.filter((i) => i.status === "FAILED").sort((a, b) => b.attempt - a.attempt)[0];

    if (sub.status !== "PAST_DUE" || alreadyPaid !== undefined) {
      // The member is not waiting for this money (expired after the retry budget, or already paid
      // another way): the cash must not stay with us unposted. Book it and refund it, idempotently.
      const key = `plus:${sub.id}:cycle:${e.cycle}:late:${e.provider}:${e.eventId}`;
      const charged = plusCharged(
        { tender: { kind: "psp", psp: e.provider, amount: money(plan.priceMinor) }, vatBps: d.cfg.vatBps },
        ledgerMeta(d, `${key}:charged`, failed?.id ?? sub.id),
      );
      await d.ledger.post(charged);
      const out = await d.refunds.refund({
        idempotencyKey: `${key}:refund`,
        userId: sub.userId,
        invoiceId: failed?.id ?? sub.id,
        pspRef: e.pspRef,
        amountMinor: plan.priceMinor,
      });
      // Not recorded as handled on failure, so the PSP redelivers and the refund is retried.
      if (out.kind === "failed") return "ignored";
      await d.ledger.post(
        reverseEntry(charged, { id: d.ids.uuidV7(), idempotencyKey: `${key}:refunded`, occurredAt: new Date(now) }),
      );
      const r = await d.store.commit({ webhookEvent: { provider: e.provider, eventId: e.eventId }, events: [] });
      return r === "duplicate_event" ? "duplicate" : "applied";
    }

    // PAST_DUE: reuse the FAILED invoice row of the attempt (same id, same attempt slot) so the
    // charge post and the invoice update are one idempotent unit: no UNIQUE(sub, cycle, attempt) clash.
    const attempt = failed?.attempt ?? Math.min(sub.dunningAttempts + 1, 3);
    const base = buildInvoice(
      d,
      {
        subscriptionId: sub.id,
        userId: sub.userId,
        cycle: sub.cycle,
        attempt,
        kind: "dunning",
        amountMinor: plan.priceMinor,
        periodStartMs: now,
        periodsTotal: periodsFor(plan.interval),
        status: "PAID",
        provider: e.provider,
        pspRef: e.pspRef,
      },
      now,
    );
    const invoice: InvoiceRecord = failed === undefined ? base : { ...base, id: failed.id, issuedAtMs: failed.issuedAtMs };
    await postCharge(d, invoice);
    const r = await applyTransition(
      d,
      sub,
      dunningSucceeded(sub, now, plan),
      now,
      [{ type: "plus.renewed", subscriptionId: sub.id, userId: sub.userId, cycle: sub.cycle, invoiceId: invoice.id }],
      { invoices: [invoice], webhookEvent: { provider: e.provider, eventId: e.eventId } },
    );
    if (r === "duplicate_event") return "duplicate";
    if (r !== "ok") return "ignored";
    await queueReceipt(d, invoice);
    return "applied";
  }
}
