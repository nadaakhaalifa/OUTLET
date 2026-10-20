import { ApiError, dataOf, type schemas } from "../../services/api-client";
import { guard, ms, msOrNull, toPortError, unsupported, type AdapterContext } from "../../services/wire";
import type { Membership, PlusPlan, PlusPort, PlusSnapshot, SubscribeOutcome, SubscriptionStatus } from "./model";

const STATUSES: readonly SubscriptionStatus[] = ["TRIALING", "ACTIVE", "PAST_DUE", "PAUSED", "CANCELLED_AT_PERIOD_END", "EXPIRED"];
/** Default capability gate (master prompt B6: HAUL Plus is 21+). The wire has no age policy field (gap). */
const DEFAULT_MIN_AGE = 21;

function plan(p: schemas.PlusPlan): PlusPlan {
  // The app addresses plans by their code (the wire `plan_code`); `id` stays internal to the server.
  return { id: p.code, interval: p.interval, price: BigInt(p.price.amount_minor), trialDays: p.trial_days, version: p.version };
}

function membership(s: schemas.PlusSubscription): Membership | null {
  const status = STATUSES.find((x) => x === s.status.toUpperCase());
  if (status === undefined) return null;
  return {
    status,
    planId: s.plan_code,
    periodEnd: ms(s.period_end),
    trialEnd: msOrNull(s.trial_end),
    pausedUntil: msOrNull(s.paused_until),
    graceEndsAt: msOrNull(s.grace_ends_at),
  };
}

/** /v1/plus/*. Subscribing needs a PSP payment token the port does not carry (gap), so subscribe is unsupported. */
export class ApiPlusPort implements PlusPort {
  constructor(private readonly ctx: AdapterContext) {}

  load(): Promise<PlusSnapshot> {
    return guard(async () => {
      const [paywall, me, profile] = await Promise.all([
        this.ctx.client.getPlusPaywall().then(dataOf),
        this.ctx.client.getMyPlus().then(dataOf),
        this.ctx.client.getMe().then(dataOf),
      ]);
      const sub = me.subscription !== null ? membership(me.subscription) : null;
      return {
        // Family and student plans have their own section (features/family); the individual paywall lists only individual plans.
        plans: paywall.plans.filter((p) => p.kind === "individual").map(plan),
        membership: sub,
        minAge: DEFAULT_MIN_AGE,
        ageEligible: profile.age_band === "21_plus",
        salesEnabled: true,
        trialEligible: sub === null && paywall.plans.some((p) => p.trial_days > 0),
        savings: { total: BigInt(me.savings.total.amount_minor), orders: me.savings.recent.filter((r) => !r.reversed).length },
      };
    });
  }

  async subscribe(_planId: string, _idempotencyKey: string): Promise<SubscribeOutcome> {
    throw unsupported("plus subscribe needs payment_token_ref from the PSP SDK (PlusPort.subscribe has no token)");
  }

  cancel(idempotencyKey: string): Promise<void> {
    return guard(async () => {
      dataOf(await this.ctx.client.cancelPlus(undefined, { idempotencyKey }));
    });
  }

  pause(months: number, idempotencyKey: string): Promise<void> {
    return guard(async () => {
      dataOf(await this.ctx.client.pausePlus({ body: { months } }, { idempotencyKey }));
    });
  }

  switchPlan(planId: string, idempotencyKey: string): Promise<void> {
    return guard(async () => {
      dataOf(await this.ctx.client.switchPlusPlan({ body: { plan_code: planId } }, { idempotencyKey }));
    });
  }
}

export function plusSubscribeOutcomeFromError(e: unknown): SubscribeOutcome {
  if (e instanceof ApiError && e.status === 403) {
    if (e.code?.includes("age") === true) return { kind: "ageGate", minAge: DEFAULT_MIN_AGE };
    if (e.code?.includes("disabled") === true) return { kind: "salesDisabled" };
  }
  throw toPortError(e);
}
