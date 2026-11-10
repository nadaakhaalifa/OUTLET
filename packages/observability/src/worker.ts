import { metrics } from "@opentelemetry/api";
import type { Meter } from "@opentelemetry/api";

/** Instruments of the worker process (ADR-0016). Labels are job / event type / outcome / market only: never ids or payload fields. */
export interface WorkerMetrics {
  /** One handler run. outcome: processed | duplicate | failed | unhandled. */
  recordHandled(seconds: number, attrs: { readonly job: string; readonly event_type: string; readonly outcome: string; readonly market_id: string }): void;
  /** One relay poll result. */
  recordPoll(attrs: { readonly market_id: string; readonly claimed: number; readonly failed: number; readonly dead_lettered: number }): void;
  /** Scheduler tick emitted (or skipped). outcome: emitted | exists | not_leader | killed. */
  recordTick(attrs: { readonly market_id: string; readonly scope: string; readonly outcome: string }): void;
  /** Consumer lag: age in seconds of the oldest unpublished event of the job, and how many are pending. */
  setLag(job: string, marketId: string, lagSeconds: number, pending: number): void;
  /** Unpublished events of types no consumer of this process claims (never acked; they wait for a consumer to be composed). */
  setUnrouted(marketId: string, pending: number, lagSeconds: number): void;
  /** Search index staleness (SLO 60 s): worst lag in ms and an honest status label (fresh | stale | search_provider_unconfigured). */
  setSearchStaleness(marketId: string, stalenessMs: number, status: string): void;
}

const HANDLER_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

export const createWorkerMetrics = (meter: Meter = metrics.getMeter("@outlet/observability")): WorkerMetrics => {
  const handled = meter.createHistogram("worker_handler_seconds", { description: "Inbox consumer handler duration", unit: "s", advice: { explicitBucketBoundaries: HANDLER_BUCKETS } });
  const claimed = meter.createCounter("worker_relay_claimed_total", { description: "Outbox events claimed by the dispatch relay" });
  const failed = meter.createCounter("worker_relay_failed_total", { description: "Dispatches that failed and were scheduled for retry" });
  const dead = meter.createCounter("worker_relay_dead_lettered_total", { description: "Events dead-lettered after the last attempt" });
  const ticks = meter.createCounter("worker_scheduler_ticks_total", { description: "Scheduler tick decisions" });
  const lag = new Map<string, { job: string; market_id: string; seconds: number; pending: number }>();
  meter.createObservableGauge("worker_consumer_lag_seconds", { description: "Age of the oldest unpublished event per worker job" }).addCallback((r) => {
    for (const v of lag.values()) r.observe(v.seconds, { job: v.job, market_id: v.market_id });
  });
  meter.createObservableGauge("worker_consumer_pending", { description: "Unpublished events per worker job" }).addCallback((r) => {
    for (const v of lag.values()) r.observe(v.pending, { job: v.job, market_id: v.market_id });
  });
  const unrouted = new Map<string, { pending: number; seconds: number }>();
  meter.createObservableGauge("worker_unrouted_pending", { description: "Unpublished events with no consumer in the worker process" }).addCallback((r) => {
    for (const [market_id, v] of unrouted) r.observe(v.pending, { market_id });
  });
  meter.createObservableGauge("worker_unrouted_lag_seconds", { description: "Age of the oldest unpublished event with no consumer" }).addCallback((r) => {
    for (const [market_id, v] of unrouted) r.observe(v.seconds, { market_id });
  });
  const staleness = new Map<string, { ms: number; status: string }>();
  meter.createObservableGauge("search_index_staleness_ms", { description: "Search index lag behind the source in ms; status label tells fresh, stale or search_provider_unconfigured", unit: "ms" }).addCallback((r) => {
    for (const [market_id, v] of staleness) r.observe(v.ms, { market_id, status: v.status });
  });
  return {
    recordHandled: (s, a) => {
      handled.record(s, { ...a });
    },
    recordPoll: (a) => {
      const l = { market_id: a.market_id };
      claimed.add(a.claimed, l);
      failed.add(a.failed, l);
      dead.add(a.dead_lettered, l);
    },
    recordTick: (a) => {
      ticks.add(1, { ...a });
    },
    setLag: (job, marketId, seconds, pending) => {
      lag.set(`${marketId}|${job}`, { job, market_id: marketId, seconds, pending });
    },
    setUnrouted: (marketId, pending, seconds) => {
      unrouted.set(marketId, { pending, seconds });
    },
    setSearchStaleness: (marketId, ms, status) => {
      staleness.set(marketId, { ms, status });
    },
  };
};
