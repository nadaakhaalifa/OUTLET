/**
 * Z-OUTLET Plus paywall and membership management (spec §14, phase2/01, ADR-0004 Plan A).
 * Pure model, port and in-memory fake. Money is integer piastres (bigint). Every price, saving and
 * eligibility decision comes from the server; nothing numeric is hard-coded here.
 */
import { PortError, type PortFailure } from "../worlds/model";

export { PortError };
export type { PortFailure };

const DAY_MS = 86_400_000;
const MONTHS_PER_YEAR = 12;

export type DisplayLocale = "ar" | "en";
export type PlanInterval = "month" | "year";

export interface PlusPlan {
  readonly id: string;
  readonly interval: PlanInterval;
  /** Server price in piastres for one interval. */
  readonly price: bigint;
  /** 0 when the plan has no trial. Eligibility for the trial is separate (`trialEligible`). */
  readonly trialDays: number;
  readonly version: number;
}

export type SubscriptionStatus = "TRIALING" | "ACTIVE" | "PAST_DUE" | "PAUSED" | "CANCELLED_AT_PERIOD_END" | "EXPIRED";

export interface Membership {
  readonly status: SubscriptionStatus;
  readonly planId: string;
  /** Epoch ms. Benefits end exactly here for CANCELLED_AT_PERIOD_END. */
  readonly periodEnd: number;
  readonly trialEnd: number | null;
  readonly pausedUntil: number | null;
  readonly graceEndsAt: number | null;
}

export interface PlusSnapshot {
  readonly plans: readonly PlusPlan[];
  readonly membership: Membership | null;
  /** From `age_policy.plus_min_age` (default 21), decided by the server. */
  readonly minAge: number;
  readonly ageEligible: boolean;
  /** Kill switch `plus_sales`: stops new subscriptions, renewals continue. */
  readonly salesEnabled: boolean;
  readonly trialEligible: boolean;
  /** Totals from the server `plus_savings_ledger`, net of reversed rows. */
  readonly savings: { readonly total: bigint; readonly orders: number };
}

export type SubscribeOutcome =
  | { readonly kind: "subscribed" }
  | { readonly kind: "ageGate"; readonly minAge: number }
  | { readonly kind: "salesDisabled" };

export interface PlusPort {
  load(): Promise<PlusSnapshot>;
  subscribe(planId: string, idempotencyKey: string): Promise<SubscribeOutcome>;
  cancel(idempotencyKey: string): Promise<void>;
  pause(months: number, idempotencyKey: string): Promise<void>;
  switchPlan(planId: string, idempotencyKey: string): Promise<void>;
}

/* ---- pricing copy, computed from server prices only ---- */

export interface YearlyPitch {
  readonly payMonths: number;
  readonly freeMonths: number;
  /** Twelve monthly payments minus the yearly price. */
  readonly saving: bigint;
  /** Integer percent, floored. */
  readonly savingPct: number;
}

/**
 * "Pay N, get M free" only when the yearly price is an exact whole number of monthly prices below
 * twelve. Otherwise no pitch is shown at all (honest by default, never rounded into a claim).
 */
export function yearlyPitch(plans: readonly PlusPlan[]): YearlyPitch | null {
  const monthly = plans.find((p) => p.interval === "month");
  const yearly = plans.find((p) => p.interval === "year");
  if (monthly === undefined || yearly === undefined || monthly.price <= 0n) return null;
  const twelve = monthly.price * BigInt(MONTHS_PER_YEAR);
  if (yearly.price <= 0n || yearly.price >= twelve) return null;
  if (yearly.price % monthly.price !== 0n) return null;
  const payMonths = Number(yearly.price / monthly.price);
  const saving = twelve - yearly.price;
  return {
    payMonths,
    freeMonths: MONTHS_PER_YEAR - payMonths,
    saving,
    savingPct: Number((saving * 100n) / twelve),
  };
}

export interface PlanOption {
  readonly plan: PlusPlan;
  readonly isDefault: boolean;
  readonly pitch: YearlyPitch | null;
}

/** Yearly is the default selection when it exists (spec §14). */
export function planOptions(plans: readonly PlusPlan[]): readonly PlanOption[] {
  const pitch = yearlyPitch(plans);
  const defaultId = (plans.find((p) => p.interval === "year") ?? plans[0])?.id;
  return [...plans]
    .sort((a, b) => (a.interval === b.interval ? 0 : a.interval === "month" ? -1 : 1))
    .map((plan) => ({ plan, isDefault: plan.id === defaultId, pitch: plan.interval === "year" ? pitch : null }));
}

export function defaultPlanId(plans: readonly PlusPlan[]): string | null {
  return planOptions(plans).find((o) => o.isDefault)?.plan.id ?? null;
}

/* ---- view model ---- */

export type PurchaseBlocker = "ageGate" | "salesDisabled" | "noPlans" | null;
export type ManageAction = "pause" | "switchPlan" | "cancel";

/** Cancel is reachable in 2 taps: Me -> Plus (tap 1) -> Cancel on the first manage view (tap 2). */
export const CANCEL_TAPS_FROM_ME = 2;
export const PAUSE_MONTH_OPTIONS: readonly number[] = [1, 2, 3];
export const TRIAL_REMINDER_DAYS_BEFORE = 2;

export interface ManageActionView {
  readonly action: ManageAction;
  /** Cancel runs on one tap: no confirm-shaming and no second confirmation screen. */
  readonly requiresConfirmation: false;
}

export interface MemberView {
  readonly status: SubscriptionStatus;
  readonly plan: PlusPlan | null;
  readonly actions: readonly ManageActionView[];
  readonly benefitsEndAt: number | null;
  readonly benefitsActive: boolean;
  readonly trialReminderAt: number | null;
  readonly firstChargeAt: number | null;
  readonly pausedUntil: number | null;
  readonly switchTarget: PlusPlan | null;
  readonly graceEndsAt: number | null;
}

export interface PlusView {
  readonly mode: "paywall" | "manage";
  readonly options: readonly PlanOption[];
  readonly purchaseBlocker: PurchaseBlocker;
  readonly minAge: number;
  readonly trialDays: number;
  readonly showTrial: boolean;
  readonly member: MemberView | null;
  readonly savings: { readonly total: bigint; readonly orders: number; readonly hasSavings: boolean };
}

export function buildPlus(s: PlusSnapshot): PlusView {
  const options = planOptions(s.plans);
  const m = s.membership;
  const isMember = m !== null && m.status !== "EXPIRED";
  const maxTrial = s.plans.reduce((n, p) => Math.max(n, p.trialDays), 0);
  let purchaseBlocker: PurchaseBlocker = null;
  if (s.plans.length === 0) purchaseBlocker = "noPlans";
  else if (!s.salesEnabled) purchaseBlocker = "salesDisabled";
  else if (!s.ageEligible) purchaseBlocker = "ageGate";
  return {
    mode: isMember ? "manage" : "paywall",
    options,
    purchaseBlocker,
    minAge: s.minAge,
    trialDays: maxTrial,
    showTrial: s.trialEligible && maxTrial > 0 && !isMember,
    member: isMember && m !== null ? memberView(m, s.plans) : null,
    savings: { total: s.savings.total, orders: s.savings.orders, hasSavings: s.savings.total > 0n },
  };
}

function memberView(m: Membership, plans: readonly PlusPlan[]): MemberView {
  const plan = plans.find((p) => p.id === m.planId) ?? null;
  const other = plan === null ? null : (plans.find((p) => p.interval !== plan.interval && p.interval === "year") ?? null);
  let actions: ManageAction[];
  switch (m.status) {
    case "ACTIVE":
      actions = ["pause", ...(other !== null && plan?.interval === "month" ? (["switchPlan"] as const) : []), "cancel"];
      break;
    case "TRIALING":
    case "PAST_DUE":
      actions = ["cancel"];
      break;
    default:
      actions = [];
  }
  const inGrace = m.status === "PAST_DUE" && m.graceEndsAt !== null;
  return {
    status: m.status,
    plan,
    actions: actions.map((action) => ({ action, requiresConfirmation: false })),
    benefitsEndAt: m.status === "CANCELLED_AT_PERIOD_END" ? m.periodEnd : inGrace ? m.graceEndsAt : null,
    benefitsActive: m.status !== "PAUSED" && m.status !== "EXPIRED",
    trialReminderAt: m.status === "TRIALING" && m.trialEnd !== null ? m.trialEnd - TRIAL_REMINDER_DAYS_BEFORE * DAY_MS : null,
    firstChargeAt: m.status === "TRIALING" ? m.trialEnd : null,
    pausedUntil: m.status === "PAUSED" ? m.pausedUntil : null,
    switchTarget: actions.includes("switchPlan") ? other : null,
    graceEndsAt: m.graceEndsAt,
  };
}

/** Instant of the first charge: now, or the end of the free trial when one applies. */
export function firstChargeAt(plan: PlusPlan, trial: boolean, nowMs: number): number {
  return nowMs + (trial ? plan.trialDays * DAY_MS : 0);
}

/** Africa/Cairo calendar date for any instant (spec §14: periods are stored UTC, shown in Cairo). */
export function formatCairoDate(ms: number, locale: DisplayLocale): string {
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-EG" : "en-GB", {
    timeZone: "Africa/Cairo", day: "numeric", month: "long", year: "numeric",
  }).format(new Date(ms));
}

export type PlusScreenState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly offline: boolean }
  | { readonly status: "ready"; readonly snapshot: PlusSnapshot };

export function plusFailureState(e: unknown): PlusScreenState {
  return { status: "error", offline: e instanceof PortError && e.kind === "offline" };
}

/* ---- in-memory fake (development and tests only; synthetic data) ---- */

export const FIXTURE_PLUS: PlusSnapshot = {
  plans: [
    { id: "plan-m", interval: "month", price: 20_000n, trialDays: 14, version: 1 },
    { id: "plan-y", interval: "year", price: 80_000n, trialDays: 14, version: 1 },
  ],
  membership: null,
  minAge: 21,
  ageEligible: true,
  salesEnabled: true,
  trialEligible: true,
  savings: { total: 0n, orders: 0 },
};

export class InMemoryPlusPort implements PlusPort {
  private snapshot: PlusSnapshot;
  private readonly seen = new Map<string, SubscribeOutcome>();
  constructor(initial: PlusSnapshot = FIXTURE_PLUS, private failure: PortFailure | null = null, private readonly clock: () => number = Date.now) {
    this.snapshot = initial;
  }
  setFailure(f: PortFailure | null): void {
    this.failure = f;
  }
  private check(): void {
    if (this.failure !== null) throw new PortError(this.failure);
  }
  async load(): Promise<PlusSnapshot> {
    this.check();
    return this.snapshot;
  }
  async subscribe(planId: string, key: string): Promise<SubscribeOutcome> {
    this.check();
    const prior = this.seen.get(key);
    if (prior !== undefined) return prior;
    let out: SubscribeOutcome;
    if (!this.snapshot.salesEnabled) out = { kind: "salesDisabled" };
    else if (!this.snapshot.ageEligible) out = { kind: "ageGate", minAge: this.snapshot.minAge };
    else {
      const plan = this.snapshot.plans.find((p) => p.id === planId);
      if (plan === undefined) throw new PortError("failed");
      const trial = this.snapshot.trialEligible && plan.trialDays > 0;
      const now = this.clock();
      const periodEnd = now + (plan.interval === "year" ? 365 : 30) * DAY_MS;
      this.snapshot = {
        ...this.snapshot,
        membership: {
          status: trial ? "TRIALING" : "ACTIVE", planId, periodEnd: trial ? now + plan.trialDays * DAY_MS : periodEnd,
          trialEnd: trial ? now + plan.trialDays * DAY_MS : null, pausedUntil: null, graceEndsAt: null,
        },
      };
      out = { kind: "subscribed" };
    }
    this.seen.set(key, out);
    return out;
  }
  private patch(f: (m: Membership) => Membership): void {
    const m = this.snapshot.membership;
    if (m === null) throw new PortError("failed");
    this.snapshot = { ...this.snapshot, membership: f(m) };
  }
  async cancel(): Promise<void> {
    this.check();
    this.patch((m) => ({ ...m, status: "CANCELLED_AT_PERIOD_END" }));
  }
  async pause(months: number): Promise<void> {
    this.check();
    this.patch((m) => ({ ...m, status: "PAUSED", pausedUntil: this.clock() + months * 30 * DAY_MS }));
  }
  async switchPlan(planId: string): Promise<void> {
    this.check();
    this.patch((m) => ({ ...m, planId }));
  }
}
