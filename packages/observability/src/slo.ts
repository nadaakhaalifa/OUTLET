import { metrics } from "@opentelemetry/api";
import type { Attributes, Meter } from "@opentelemetry/api";

/** SLO instruments from BUILD-PROMPT section 8. Latency histograms are in seconds. */
export interface SloMetrics {
  checkoutAttempt(attrs?: Attributes): void;
  checkoutSuccess(attrs?: Attributes): void;
  recordWebhookToPaid(seconds: number, attrs?: Attributes): void;
  recordApiRead(seconds: number, attrs?: Attributes): void;
  recordReserve(seconds: number, attrs?: Attributes): void;
  setUnmatchedPspLines(count: number): void;
}

const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.15, 0.3, 0.5, 1, 2.5, 5, 10];

export const createSloMetrics = (meter: Meter = metrics.getMeter("@outlet/observability")): SloMetrics => {
  const attempts = meter.createCounter("checkout_attempts_total", { description: "Checkout placements attempted (excl. user-declined)" });
  const success = meter.createCounter("checkout_success_total", { description: "Checkout placements succeeded" });
  const hist = (name: string, description: string) =>
    meter.createHistogram(name, { description, unit: "s", advice: { explicitBucketBoundaries: LATENCY_BUCKETS } });
  const webhook = hist("webhook_to_paid_seconds", "PSP webhook receipt to order PAID");
  const apiRead = hist("api_read_latency_seconds", "API read latency");
  const reserve = hist("reserve_latency_seconds", "Inventory reserve transaction latency");
  let unmatched = 0;
  meter
    .createObservableGauge("unmatched_psp_lines", { description: "PSP settlement lines unmatched for more than 3 days" })
    .addCallback((r) => {
      r.observe(unmatched);
    });
  return {
    checkoutAttempt: (a) => { attempts.add(1, a); },
    checkoutSuccess: (a) => { success.add(1, a); },
    recordWebhookToPaid: (s, a) => { webhook.record(s, a); },
    recordApiRead: (s, a) => { apiRead.record(s, a); },
    recordReserve: (s, a) => { reserve.record(s, a); },
    setUnmatchedPspLines: (n) => {
      unmatched = n;
    },
  };
};
