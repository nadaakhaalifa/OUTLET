import { subscriptionMachine, type SubscriptionEvent } from "../state-machine";
import { addMonthsUtc, graceEndsAt, nextDunningAction, periodEndFor } from "./billing";
import { SubscriptionRuleError } from "./errors";
import { DAY_MS, TRIAL_REMINDER_DAYS, type PlusPlan, type PlusSubscription } from "./types";

/**
 * Pure subscription transitions. Every status change goes through the shared, table-driven
 * `subscriptionMachine`, so an invalid move throws the machine's typed InvalidTransitionError.
 */
const move = (sub: PlusSubscription, event: SubscriptionEvent): PlusSubscription["status"] =>
  subscriptionMachine.transition(sub.status, event);

const planFields = (plan: PlusPlan) => ({
  planId: plan.id,
  planCode: plan.code,
  planVersion: plan.version,
  interval: plan.interval,
});

export interface NewSubscription {
  readonly id: string;
  readonly userId: string;
  readonly plan: PlusPlan;
  readonly pspTokenRef: string;
  readonly nowMs: number;
}

function base(n: NewSubscription): PlusSubscription {
  return {
    id: n.id,
    userId: n.userId,
    ...planFields(n.plan),
    status: subscriptionMachine.initial,
    periodStartMs: n.nowMs,
    periodEndMs: n.nowMs,
    trialEndMs: null,
    cancelAtMs: null,
    pausedAtMs: null,
    pausedUntilMs: null,
    graceEndsAtMs: null,
    failedAtMs: null,
    dunningAttempts: 0,
    cycle: 0,
    nextActionAtMs: null,
    pendingPlanCode: null,
    trialReminderSentAtMs: null,
    pspTokenRef: n.pspTokenRef,
    createdAtMs: n.nowMs,
    version: 0,
  };
}

/** Free trial: no charge, entitlements until the trial ends, reminder two days before the first charge. */
export function startTrial(n: NewSubscription): PlusSubscription {
  if (n.plan.trialDays < 1) throw new SubscriptionRuleError("plan has no trial");
  const trialEnd = n.nowMs + n.plan.trialDays * DAY_MS;
  const reminderAt = trialEnd - TRIAL_REMINDER_DAYS * DAY_MS;
  return {
    ...base(n),
    periodEndMs: trialEnd,
    trialEndMs: trialEnd,
    nextActionAtMs: reminderAt > n.nowMs ? reminderAt : trialEnd,
  };
}

/** First charge succeeded: modelled as a zero-length trial converted at once (single machine). */
export function startPaid(n: NewSubscription): PlusSubscription {
  return convertTrial(base(n), n.nowMs, n.plan);
}

export function convertTrial(sub: PlusSubscription, nowMs: number, plan: PlusPlan): PlusSubscription {
  const status = move(sub, "TRIAL_CONVERTED");
  return {
    ...sub,
    ...planFields(plan),
    status,
    cycle: 1,
    periodStartMs: nowMs,
    periodEndMs: periodEndFor(nowMs, plan.interval),
    nextActionAtMs: periodEndFor(nowMs, plan.interval),
  };
}

export function expireUnpaidTrial(sub: PlusSubscription): PlusSubscription {
  return { ...sub, status: move(sub, "TRIAL_ENDED_UNPAID"), nextActionAtMs: null };
}

/** Which plan bills the next period: a scheduled downgrade wins, then the version in force at that time. */
export function renewSucceeded(sub: PlusSubscription, nowMs: number, plan: PlusPlan): PlusSubscription {
  if (sub.status !== "ACTIVE") throw new SubscriptionRuleError("only an ACTIVE subscription renews in place");
  const start = sub.periodEndMs <= nowMs ? nowMs : sub.periodEndMs;
  const end = periodEndFor(start, plan.interval);
  return {
    ...sub,
    ...planFields(plan),
    cycle: sub.cycle + 1,
    periodStartMs: start,
    periodEndMs: end,
    nextActionAtMs: end,
    pendingPlanCode: null,
  };
}

/** The renewal charge failed. `cycle` now names the cycle being recovered. */
export function renewFailed(sub: PlusSubscription, nowMs: number): PlusSubscription {
  const status = move(sub, "CHARGE_FAILED");
  const firstRetry = nextDunningAction(nowMs, 0, nowMs);
  return {
    ...sub,
    status,
    cycle: sub.cycle + 1,
    failedAtMs: nowMs,
    dunningAttempts: 0,
    graceEndsAtMs: graceEndsAt(nowMs),
    nextActionAtMs: firstRetry.kind === "wait" ? firstRetry.untilMs : nowMs,
  };
}

export function dunningFailed(sub: PlusSubscription, attempt: number, nowMs: number): PlusSubscription {
  if (sub.status !== "PAST_DUE" || sub.failedAtMs === null) throw new SubscriptionRuleError("not in dunning");
  const next = nextDunningAction(sub.failedAtMs, attempt, nowMs);
  const at = next.kind === "retry" ? next.dueAtMs : next.kind === "wait" ? next.untilMs : nowMs;
  return { ...sub, dunningAttempts: attempt, nextActionAtMs: at };
}

export function dunningSucceeded(sub: PlusSubscription, nowMs: number, plan: PlusPlan): PlusSubscription {
  const status = move(sub, "CHARGE_SUCCEEDED");
  const end = periodEndFor(nowMs, plan.interval);
  return {
    ...sub,
    ...planFields(plan),
    status,
    periodStartMs: nowMs,
    periodEndMs: end,
    failedAtMs: null,
    graceEndsAtMs: null,
    dunningAttempts: 0,
    pendingPlanCode: null,
    nextActionAtMs: end,
  };
}

export function graceElapsed(sub: PlusSubscription): PlusSubscription {
  return { ...sub, status: move(sub, "GRACE_ELAPSED"), nextActionAtMs: null };
}

export function periodEnded(sub: PlusSubscription): PlusSubscription {
  return { ...sub, status: move(sub, "PERIOD_ENDED"), nextActionAtMs: null };
}

export function pause(sub: PlusSubscription, nowMs: number, months: number): PlusSubscription {
  const status = move(sub, "PAUSE");
  const until = addMonthsUtc(nowMs, months);
  return { ...sub, status, pausedAtMs: nowMs, pausedUntilMs: until, nextActionAtMs: until };
}

/** Resume keeps the paid days: the period is shifted by the time spent paused. */
export function resume(sub: PlusSubscription, nowMs: number): PlusSubscription {
  const status = move(sub, "RESUME");
  const shift = sub.pausedAtMs === null ? 0 : Math.max(nowMs - sub.pausedAtMs, 0);
  const end = sub.periodEndMs + shift;
  return {
    ...sub,
    status,
    periodStartMs: sub.periodStartMs + shift,
    periodEndMs: end,
    pausedAtMs: null,
    pausedUntilMs: null,
    nextActionAtMs: end,
  };
}

/**
 * Cancel keeps benefits until the paid-through instant. The machine has no PAUSED -> CANCEL edge,
 * so a paused member is resumed (no charge) and cancelled in one step. A PAST_DUE member is paid
 * through the grace end, never less.
 */
export function cancel(sub: PlusSubscription, nowMs: number): PlusSubscription {
  const current = sub.status === "PAUSED" ? resume(sub, nowMs) : sub;
  const status = move(current, "CANCEL");
  const paidThrough =
    current.status === "PAST_DUE" && current.graceEndsAtMs !== null
      ? Math.max(current.periodEndMs, current.graceEndsAtMs)
      : current.periodEndMs;
  return {
    ...current,
    status,
    periodEndMs: paidThrough,
    cancelAtMs: paidThrough,
    graceEndsAtMs: null,
    failedAtMs: null,
    dunningAttempts: 0,
    nextActionAtMs: paidThrough,
  };
}

export function reactivate(sub: PlusSubscription, nowMs: number): PlusSubscription {
  if (nowMs >= sub.periodEndMs) throw new SubscriptionRuleError("the paid period has ended");
  const status = move(sub, "REACTIVATE");
  return { ...sub, status, cancelAtMs: null, nextActionAtMs: sub.periodEndMs };
}

/** Immediate monthly -> yearly: a new yearly period starts now, the credit has paid for part of it. */
export function switchNow(sub: PlusSubscription, nowMs: number, plan: PlusPlan): PlusSubscription {
  if (sub.status !== "ACTIVE") throw new SubscriptionRuleError("only an ACTIVE subscription can switch plan");
  const end = periodEndFor(nowMs, plan.interval);
  return {
    ...sub,
    ...planFields(plan),
    cycle: sub.cycle + 1,
    periodStartMs: nowMs,
    periodEndMs: end,
    nextActionAtMs: end,
    pendingPlanCode: null,
  };
}

export function scheduleSwitch(sub: PlusSubscription, planCode: string): PlusSubscription {
  if (sub.status !== "ACTIVE") throw new SubscriptionRuleError("only an ACTIVE subscription can switch plan");
  return { ...sub, pendingPlanCode: planCode };
}

/** Full refund inside the window: ends the subscription at once. */
export function cancelWithRefund(sub: PlusSubscription): PlusSubscription {
  return { ...sub, status: move(sub, "CANCEL_WITH_REFUND"), nextActionAtMs: null };
}

export function trialReminderSent(sub: PlusSubscription, nowMs: number): PlusSubscription {
  const end = sub.trialEndMs ?? sub.periodEndMs;
  return { ...sub, trialReminderSentAtMs: nowMs, nextActionAtMs: end };
}
