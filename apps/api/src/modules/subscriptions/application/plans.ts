import {
  priceChangeNoticeOk,
  selectPlanVersion,
  yearlyMarketing,
  type PlusInterval,
  type PlusPlan,
  type YearlyMarketing,
} from "../domain/bridge";
import type { Clock, IdPort, MemberNoticePort, PlanPriceApprovalPort, SubscriptionStore } from "../domain/ports";

export interface PaywallView {
  readonly plans: readonly PlusPlan[];
  readonly marketing: YearlyMarketing | null;
  readonly defaultCode: string | null;
}

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
    const monthly = plans.find((p) => p.interval === "month");
    const yearly = plans.find((p) => p.interval === "year");
    const marketing =
      monthly !== undefined && yearly !== undefined ? yearlyMarketing(monthly.priceMinor, yearly.priceMinor) : null;
    return { plans, marketing, defaultCode: yearly?.code ?? plans[0]?.code ?? null };
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
}

export type PublishPlanResult =
  | { readonly kind: "published"; readonly plan: PlusPlan; readonly notified: number }
  | { readonly kind: "notice_too_short"; readonly minEffectiveFromMs: number }
  | { readonly kind: "interval_mismatch" }
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

