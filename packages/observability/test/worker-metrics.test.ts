import { describe, expect, it } from "vitest";
import { AggregationTemporality, InMemoryMetricExporter, MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { createWorkerMetrics } from "../src/index.js";

describe("worker metrics", () => {
  it("records handler durations, relay counters, ticks and per-job lag gauges", async () => {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 });
    const m = createWorkerMetrics(new MeterProvider({ readers: [reader] }).getMeter("t"));
    m.recordHandled(0.2, { job: "ops.attention", event_type: "refund.attention", outcome: "processed", market_id: "EG" });
    m.recordPoll({ market_id: "EG", claimed: 3, failed: 1, dead_lettered: 1 });
    m.recordTick({ market_id: "EG", scope: "sales", outcome: "emitted" });
    m.setLag("ops.attention", "EG", 12, 4);
    m.setLag("ops.attention", "EG", 5, 2);
    m.setUnrouted("EG", 7, 30);
    m.setSearchStaleness("EG", 1234, "search_provider_unconfigured");
    await reader.forceFlush();
    const all = exporter.getMetrics().flatMap((r) => r.scopeMetrics.flatMap((s) => s.metrics));
    const points = (n: string) => all.find((x) => x.descriptor.name === n)?.dataPoints ?? [];
    const sum = (n: string) => points(n).reduce((a, d) => a + (d.value as number), 0);
    expect(points("worker_handler_seconds")).toHaveLength(1);
    expect(sum("worker_relay_claimed_total")).toBe(3);
    expect(sum("worker_relay_failed_total")).toBe(1);
    expect(sum("worker_relay_dead_lettered_total")).toBe(1);
    expect(sum("worker_scheduler_ticks_total")).toBe(1);
    expect(points("worker_consumer_lag_seconds").map((p) => p.value)).toEqual([5]);
    expect(points("worker_consumer_pending").map((p) => p.value)).toEqual([2]);
    expect(points("worker_unrouted_pending").map((p) => p.value)).toEqual([7]);
    expect(points("worker_unrouted_lag_seconds").map((p) => p.value)).toEqual([30]);
    const st = points("search_index_staleness_ms");
    expect(st.map((p) => p.value)).toEqual([1234]);
    expect(st.map((p) => p.attributes)).toEqual([{ market_id: "EG", status: "search_provider_unconfigured" }]);
    expect(createWorkerMetrics()).toBeDefined();
  });
});
