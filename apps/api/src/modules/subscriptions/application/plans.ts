import {
  familyMarketing,
  priceChangeNoticeOk,
  seatLimitOf,
  selectPlanVersion,
  yearlyMarketing,
  type PlanKind,
  type PlusInterval,
  type PlusPlan,
  type YearlyMarketing,
} from "../domain/bridge";
import type { Clock, IdPort, MemberNoticePort, PlanPriceApprovalPort, SubscriptionStore } from "../domain/ports";

export interface FamilyOffer {
  readonly planCode: string;
  readonly seats: number;
  readonly savingMinor: bigint;
}

export interface PaywallView {
  readonly plans: readonly PlusPlan[];
  /** Pay-4-get-8 arithmetic from the individual monthly and yearly plans only. */
  readonly marketing: YearlyMarketing | null;
  /** N seats vs N individual yearly plans, derived from real prices; null when not cheaper or not on sale. */
  readonly familyOffer: FamilyOffer | null;
  readonly defaultCode: string | null;
}

const isIndividual = (p: PlusPlan): boolean => (p.kind ?? "individual") === "individual";

/** The paywall: the plan version in force now per code, with marketing derived from the real prices. */
export class ListPlans {
  constructor(
    private readonly store: SubscriptionStore,
    private readonly clock: Clock,
  ) {}

  async execute(): Promise<PaywallView> {
    const now = this.clock.nowMs();
    const all = await this.store.listPlanVersions();
    const codes = [...new Set(all.map((p) => p.code))].sort();
    const plans: PlusPlan[] = [];
    for (const code of codes) {
      const p = selectPlanVersion(
        all.filter((x) => x.code === code),
        now,
      );
      if (p !== null) plans.push(p);
    }
    // Marketing copy applies only where the arithmetic is true: individual plans, never family or student.
    const monthly = plans.find((p) => isIndividual(p) && p.interval === "month");
    const yearly = plans.find((p) => isIndividual(p) && p.interval === "year");
    const marketing =
      monthly !== undefined && yearly !== undefined ? yearlyMarketing(monthly.priceMinor, yearly.priceMinor) : null;
    const family = plans.find((p) => p.kind === "family" && p.interval === "year");
    const seats = family === undefined ? null : seatLimitOf(family);
    let familyOffer: FamilyOffer | null = null;
    if (family !== undefined && yearly !== undefined && seats !== null && seats > 1) {
      const m = familyMarketing({ individualYearlyMinor: yearly.priceMinor, familyYearlyMinor: family.priceMinor, seatLimit: seats });
      if (m.savingMinor > 0n) familyOffer = { planCode: family.code, seats: m.seats, savingMinor: m.savingMinor };
    }
    return { plans, marketing, familyOffer, defaultCode: yearly?.code ?? plans[0]?.code ?? null };
  }
}

export interface PublishPlanInput {
  readonly actorId: string;
  readonly code: string;
  readonly interval: PlusInterval;
  readonly priceMinor: bigint;
  readonly trialDays: number;
  readonly effectiveFromMs: number;
  readonly approvalId: string;
  /** New code: defaults to individual. Existing code: must match (a kind never changes under a code). */
  readonly kind?: PlanKind;
  /** Family only, owner included. Absent keeps the latest version's limit. */
  readonly seatLimit?: number;
}

export type PublishPlanResult =
  | { readonly kind: "published"; readonly plan: PlusPlan; readonly notified: number }
  | { readonly kind: "notice_too_short"; readonly minEffectiveFromMs: number }
  | { readonly kind: "interval_mismatch" }
  | { readonly kind: "kind_mismatch" }
  | { readonly kind: "seat_limit_invalid" }
  | { readonly kind: "approval_required" };

/**
 * Admin-versioned plans. A new version is a new row; members keep their price until the first
 * period starting at or after `effective_from`, and effective_from is at least 30 days away
 * whenever the code already exists. Members are notified at publish time (transactional notice).
 */
export class PublishPlanVersion {
  constructor(
    private readonly store: SubscriptionStore,
    private readonly clock: Clock,
    private readonly ids: IdPort,
    private readonly approvals: PlanPriceApprovalPort,
    private readonly notices: MemberNoticePort,
  ) {}

  async execute(i: PublishPlanInput): Promise<PublishPlanResult> {
    const now = this.clock.nowMs();
    const existing = await this.store.listPlanVersions(i.code);
    const latest = existing.reduce<PlusPlan | null>((a, p) => (a === null || p.version > a.version ? p : a), null);
    if (latest !== null && latest.interval !== i.interval) return { kind: "interval_mismatch" };
    const kind: PlanKind = latest === null ? (i.kind ?? "individual") : (latest.kind ?? "individual");
    if (latest !== null && i.kind !== undefined && i.kind !== kind) return { kind: "kind_mismatch" };
    let seatLimit: number | null = null;
    if (kind === "family") {
      seatLimit = i.seatLimit ?? latest?.seatLimit ?? 4;
      if (!Number.isInteger(seatLimit) || seatLimit < 2 || seatLimit > 8) return { kind: "seat_limit_invalid" };
    } else if (i.seatLimit !== undefined) {
      return { kind: "seat_limit_invalid" };
    }
    if (latest !== null && !priceChangeNoticeOk(now, i.effectiveFromMs)) {
      return { kind: "notice_too_short", minEffectiveFromMs: now + 30 * 86_400_000 };
    }
    const ok = await this.approvals.consume({
      approvalId: i.approvalId,
      planCode: i.code,
      priceMinor: i.priceMinor,
      actorId: i.actorId,
    });
    if (!ok) return { kind: "approval_required" };

    const plan: PlusPlan = {
      id: this.ids.uuidV7(),
      code: i.code,
      kind,
      seatLimit,
      interval: i.interval,
      priceMinor: i.priceMinor,
      version: (latest?.version ?? 0) + 1,
      active: true,
      trialDays: i.trialDays,
      effectiveFromMs: latest === null ? Math.min(i.effectiveFromMs, now) : i.effectiveFromMs,
      notifiedAtMs: null,
    };
    await this.store.savePlan(plan, [
      { type: "plus.plan_published", planId: plan.id, code: plan.code, version: plan.version, effectiveFromMs: plan.effectiveFromMs },
    ]);

    let notified = 0;
    if (latest !== null && latest.priceMinor !== plan.priceMinor) {
      for (const sub of await this.store.listLiveByPlanCode(i.code)) {
        await this.notices.send({
          userId: sub.userId,
          template: "plus_price_change",
          data: { plan_code: i.code, new_price_minor: plan.priceMinor.toString(), effective_from_ms: plan.effectiveFromMs },
        });
        notified += 1;
      }
    }
    const done = { ...plan, notifiedAtMs: now };
    await this.store.savePlan(done, []);
    return { kind: "published", plan: done, notified };
  }
}

export class SetPlanActive {
  constructor(private readonly store: SubscriptionStore) {}
  async execute(planId: string, active: boolean): Promise<PlusPlan | null> {
    const p = await this.store.getPlan(planId);
    if (p === null) return null;
    const next = { ...p, active };
    await this.store.savePlan(next, []);
    return next;
  }
}

export class ListPlanVersions {
  constructor(private readonly store: SubscriptionStore) {}
  execute(): Promise<readonly PlusPlan[]> {
    return this.store.listPlanVersions();
  }
}

