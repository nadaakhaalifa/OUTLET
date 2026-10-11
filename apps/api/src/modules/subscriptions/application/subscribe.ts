import {
  meetsMinAge,
  startPaid,
  startTrial,
  trialDenied,
  trialKeys,
  type PlusSubscription,
} from "../domain/bridge";
import { PLUS_FLAGS, type ClientAction, type PlusPaymentMethod, type SignupRecord } from "../domain/ports";
import {
  applyTransition,
  buildInvoice,
  periodsFor,
  planFor,
  postCharge,
  queueReceipt,
  type PlusDeps,
} from "./shared";

export interface SubscribeInput {
  readonly userId: string;
  readonly planCode: string;
  readonly tokenRef: string;
  readonly deviceId: string | null;
  readonly method: PlusPaymentMethod;
  /** The Idempotency-Key header: the charge key derives from it so a replay never double charges. */
  readonly requestKey: string;
}

export type SubscribeResult =
  | { readonly kind: "subscribed"; readonly subscription: PlusSubscription; readonly trial: boolean }
  | { readonly kind: "existing"; readonly subscription: PlusSubscription }
  | { readonly kind: "requires_action"; readonly signupId: string; readonly action: ClientAction }
  | { readonly kind: "unavailable" }
  | { readonly kind: "method_unavailable" }
  | { readonly kind: "age_gate"; readonly minAge: number }
  | { readonly kind: "plan_not_found" }
  | { readonly kind: "invalid_payment_method" }
  | { readonly kind: "payment_failed"; readonly reason: string };

/** Creates the paid subscription once a first charge is confirmed. Idempotent on the signup. */
export async function completeSignup(
  d: PlusDeps,
  signup: SignupRecord,
  provider: string,
  pspRef: string,
  webhookEvent?: { readonly provider: string; readonly eventId: string },
): Promise<SubscribeResult> {
  const now = d.clock.nowMs();
  if (signup.status === "COMPLETED" && signup.subscriptionId !== null) {
    const s = await d.store.getSubscription(signup.subscriptionId);
    if (s !== null) return { kind: "existing", subscription: s };
  }
  const plan = await d.store.getPlan(signup.planId);
  if (plan === null) return { kind: "plan_not_found" };
  const sub = startPaid({ id: d.ids.uuidV7(), userId: signup.userId, plan, pspTokenRef: signup.tokenRef, nowMs: now });
  const invoice = buildInvoice(
    d,
    {
      subscriptionId: sub.id,
      userId: sub.userId,
      cycle: 1,
      attempt: 0,
      kind: "first",
      amountMinor: signup.amountMinor,
      periodStartMs: sub.periodStartMs,
      periodsTotal: periodsFor(plan.interval),
      status: "PAID",
      provider,
      pspRef,
    },
    now,
  );
  await postCharge(d, invoice);
  const r = await applyTransition(
    d,
    null,
    sub,
    now,
    [{ type: "plus.subscribed", subscriptionId: sub.id, userId: sub.userId, planCode: sub.planCode, trial: false }],
    {
      invoices: [invoice],
      signup: { ...signup, status: "COMPLETED", pspRef, subscriptionId: sub.id, updatedAtMs: now },
      ...(webhookEvent !== undefined ? { webhookEvent } : {}),
    },
  );
  if (r === "already_subscribed") {
    // A second live subscription cannot exist: give the money back and return the existing one.
    await d.refunds.refund({
      idempotencyKey: `plus:signup-refund:${signup.id}`,
      userId: signup.userId,
      invoiceId: invoice.id,
      pspRef,
      amountMinor: signup.amountMinor,
    });
    await d.store.commit({ signup: { ...signup, status: "FAILED", pspRef, updatedAtMs: now }, events: [] });
    const live = await d.store.getLiveByUser(signup.userId);
    if (live !== null) return { kind: "existing", subscription: live };
    return { kind: "payment_failed", reason: "duplicate_subscription" };
  }
  if (r !== "ok") {
    const again = await d.store.getSignup(signup.id);
    if (again !== null && again.subscriptionId !== null) {
      const s = await d.store.getSubscription(again.subscriptionId);
      if (s !== null) return { kind: "existing", subscription: s };
    }
    return { kind: "payment_failed", reason: "conflict" };
  }
  await queueReceipt(d, invoice);
  const saved = await d.store.getSubscription(sub.id);
  return { kind: "subscribed", subscription: saved ?? sub, trial: false };
}

export class Subscribe {
  constructor(private readonly d: PlusDeps) {}

  async execute(i: SubscribeInput): Promise<SubscribeResult> {
    const d = this.d;
    if (!(await d.flags.enabled(PLUS_FLAGS.sales))) return { kind: "unavailable" };
    if (!(await d.flags.enabled(PLUS_FLAGS.recurring(i.method)))) return { kind: "method_unavailable" };

    const minAge = await d.ages.plusMinAge();
    if (!meetsMinAge(await d.ages.ageYears(i.userId), minAge)) return { kind: "age_gate", minAge };

    const live = await d.store.getLiveByUser(i.userId);
    if (live !== null) return { kind: "existing", subscription: live };

    const now = d.clock.nowMs();
    const plan = await planFor(d, i.planCode, now);
    if (plan === null) return { kind: "plan_not_found" };
    const card = await d.vault.describe(i.userId, i.tokenRef);
    if (card === null) return { kind: "invalid_payment_method" };

    const chargeKey = `plus:signup:${i.userId}:${i.requestKey}`;
    const prior = await d.store.getSignupByChargeKey(chargeKey);
    if (prior !== null) return this.resume(prior);

    const keyHashes = trialKeys({
      phoneHash: await d.persons.phoneHash(i.userId),
      deviceId: i.deviceId,
      cardFingerprint: card.fingerprint,
    }).map((k) => d.hasher.hash(k));
    const claimed = await d.store.claimedTrialKeys(keyHashes);
    if (plan.trialDays > 0 && !trialDenied(keyHashes, claimed)) {
      const sub = startTrial({ id: d.ids.uuidV7(), userId: i.userId, plan, pspTokenRef: i.tokenRef, nowMs: now });
      const r = await applyTransition(
        d,
        null,
        sub,
        now,
        [{ type: "plus.subscribed", subscriptionId: sub.id, userId: sub.userId, planCode: sub.planCode, trial: true }],
        { trialClaims: { keyHashes, subscriptionId: sub.id, atMs: now } },
      );
      if (r === "ok") {
        const saved = await d.store.getSubscription(sub.id);
        return { kind: "subscribed", subscription: saved ?? sub, trial: true };
      }
      if (r === "already_subscribed") {
        const existing = await d.store.getLiveByUser(i.userId);
        if (existing !== null) return { kind: "existing", subscription: existing };
      }
      // trial_taken (a concurrent claim): fall through to the paid path.
    }

    const signup: SignupRecord = {
      id: d.ids.uuidV7(),
      userId: i.userId,
      planId: plan.id,
      chargeKey,
      tokenRef: i.tokenRef,
      deviceId: i.deviceId,
      amountMinor: plan.priceMinor,
      status: "PENDING",
      pspRef: null,
      clientAction: null,
      subscriptionId: null,
      createdAtMs: now,
      updatedAtMs: now,
    };
    await d.store.commit({ signup, events: [] });
    return this.charge(signup);
  }

  private async charge(signup: SignupRecord): Promise<SubscribeResult> {
    const d = this.d;
    const out = await d.charges.charge({
      idempotencyKey: signup.chargeKey,
      userId: signup.userId,
      pspTokenRef: signup.tokenRef,
      amountMinor: signup.amountMinor,
      currency: "EGP",
      description: "plus",
    });
    const now = d.clock.nowMs();
    switch (out.kind) {
      case "succeeded":
        return completeSignup(d, signup, out.provider, out.pspRef);
      case "failed":
        await d.store.commit({ signup: { ...signup, status: "FAILED", updatedAtMs: now }, events: [] });
        return { kind: "payment_failed", reason: out.reason };
      case "requires_action":
        await d.store.commit({
          signup: { ...signup, pspRef: out.pspRef, clientAction: out.action, updatedAtMs: now },
          events: [],
        });
        return { kind: "requires_action", signupId: signup.id, action: out.action };
    }
  }

  /** A replayed request: report the signup's current truth without charging again. */
  private async resume(signup: SignupRecord): Promise<SubscribeResult> {
    const d = this.d;
    if (signup.status === "COMPLETED" && signup.subscriptionId !== null) {
      const s = await d.store.getSubscription(signup.subscriptionId);
      if (s !== null) return { kind: "existing", subscription: s };
    }
    if (signup.status === "FAILED") return { kind: "payment_failed", reason: "declined" };
    if (signup.clientAction !== null) {
      return { kind: "requires_action", signupId: signup.id, action: signup.clientAction };
    }
    // PENDING without a recorded action: the charge key makes this re-issue safe (same key, same outcome).
    return this.charge(signup);
  }
}

