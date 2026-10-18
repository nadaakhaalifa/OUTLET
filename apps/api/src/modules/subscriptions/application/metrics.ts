import type { Clock, MetricsCounts, SubscriptionStore } from "../domain/ports";

export interface SubscriptionMetrics {
  readonly windowDays: number;
  readonly counts: MetricsCounts;
  readonly active: number;
  readonly paused: number;
  readonly cancelledAtPeriodEnd: number;
  /** Churn in basis points of subscriptions live at window start; null when that base is zero (unmeasured). */
  readonly churnBps: number | null;
}

export class GetSubscriptionMetrics {
  constructor(
    private readonly store: SubscriptionStore,
    private readonly clock: Clock,
  ) {}

  async execute(windowDays: number): Promise<SubscriptionMetrics> {
    const counts = await this.store.metricsCounts(this.clock.nowMs() - windowDays * 86_400_000);
    const b = counts.byStatus;
    return {
      windowDays,
      counts,
      active: b.ACTIVE + b.TRIALING + b.PAST_DUE,
      paused: b.PAUSED,
      cancelledAtPeriodEnd: b.CANCELLED_AT_PERIOD_END,
      churnBps: counts.liveAtStart === 0 ? null : Math.floor((counts.endedSince * 10_000) / counts.liveAtStart),
    };
  }
}
