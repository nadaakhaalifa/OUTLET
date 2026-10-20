import type { EntitlementView, MyPlusView } from "../application/member";
import type { PaywallView } from "../application/plans";
import type { PlusPlan, PlusSubscription } from "../domain/bridge";
import type { InvoiceRecord } from "../domain/ports";

const iso = (ms: number): string => new Date(ms).toISOString();
const isoOrNull = (ms: number | null): string | null => (ms === null ? null : iso(ms));

/** Money is integer piastres as a decimal string (bigint never goes through JSON numbers). */
export const moneyWire = (minor: bigint) => ({ amount_minor: minor.toString(), currency: "EGP" as const });

export function planWire(p: PlusPlan) {
  return {
    id: p.id,
    code: p.code,
    interval: p.interval,
    price: moneyWire(p.priceMinor),
    trial_days: p.trialDays,
    version: p.version,
    kind: p.kind ?? "individual",
    seat_limit: p.seatLimit ?? null,
  };
}

export function adminPlanWire(p: PlusPlan) {
  return {
    ...planWire(p),
    active: p.active,
    effective_from: iso(p.effectiveFromMs),
    members_notified_at: isoOrNull(p.notifiedAtMs),
  };
}

export function paywallWire(v: PaywallView) {
  return {
    plans: v.plans.map((p) => ({ ...planWire(p), default: p.code === v.defaultCode })),
    yearly_offer:
      v.marketing === null
        ? null
        : {
            pay_months: v.marketing.payMonths,
            free_months: v.marketing.freeMonths,
            saving: moneyWire(v.marketing.savingMinor),
          },
    family_offer:
      v.familyOffer === null
        ? null
        : { plan_code: v.familyOffer.planCode, seats: v.familyOffer.seats, saving: moneyWire(v.familyOffer.savingMinor) },
    auto_renew: true,
    cancel_path: "me/plus",
  };
}

export function subscriptionWire(s: PlusSubscription) {
  return {
    id: s.id,
    plan_code: s.planCode,
    plan_version: s.planVersion,
    interval: s.interval,
    status: s.status,
    period_start: iso(s.periodStartMs),
    period_end: iso(s.periodEndMs),
    trial_end: isoOrNull(s.trialEndMs),
    cancel_at: isoOrNull(s.cancelAtMs),
    paused_until: isoOrNull(s.pausedUntilMs),
    grace_ends_at: isoOrNull(s.graceEndsAtMs),
    pending_plan_code: s.pendingPlanCode,
  };
}

export function entitlementsWire(e: EntitlementView) {
  return { active: e.entitled, ends_at: isoOrNull(e.endsAtMs), groups: e.groups };
}

export function mePlusWire(v: MyPlusView) {
  return {
    subscription: v.subscription === null ? null : subscriptionWire(v.subscription),
    entitlements: entitlementsWire(v.entitlements),
    savings: {
      total: moneyWire(v.savings.totalMinor),
      recent: v.savings.recent.map((r) => ({
        benefit: r.benefit,
        saved: moneyWire(r.amountSavedMinor),
        at: iso(r.createdAtMs),
        reversed: r.reversedAtMs !== null,
      })),
    },
  };
}

export function invoiceWire(i: InvoiceRecord) {
  return {
    id: i.id,
    cycle: i.cycle,
    kind: i.kind,
    status: i.status,
    amount: moneyWire(i.amountMinor),
    vat: moneyWire(i.vatMinor),
    issued_at: iso(i.issuedAtMs),
  };
}
