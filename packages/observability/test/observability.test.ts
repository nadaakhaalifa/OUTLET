import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { context, propagation, SpanStatusCode } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace";
import { InMemoryMetricExporter, AggregationTemporality, MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { createSloMetrics, getMarketId, initTelemetry, pgConnectionTag, withMarket, withSpan } from "../src/index.js";
import type { Telemetry } from "../src/index.js";

const spans = new InMemorySpanExporter();
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 150));
let tel: Telemetry;
beforeAll(() => {
  tel = initTelemetry({ serviceName: "test-svc", env: "test", exporter: "none", spanProcessors: [new SimpleSpanProcessor({ exporter: spans })] });
});
afterAll(async () => {
  await tel.shutdown();
});

describe("withSpan", () => {
  it("creates a span with attributes and OK status", async () => {
    const out = await withSpan("op.ok", { a: 1 }, () => 42);
    expect(out).toBe(42);
    await settle();
    const s = spans.getFinishedSpans().find((x) => x.name === "op.ok");
    expect(s?.attributes.a).toBe(1);
    expect(s?.status.code).toBe(SpanStatusCode.OK);
    expect(s?.resource.attributes["service.name"]).toBe("test-svc");
  });
  it("records exceptions, sets ERROR and rethrows", async () => {
    await expect(withSpan("op.fail", {}, () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await settle();
    const s = spans.getFinishedSpans().find((x) => x.name === "op.fail");
    expect(s?.status.code).toBe(SpanStatusCode.ERROR);
    expect(s?.events.some((e) => e.name === "exception")).toBe(true);
  });
  it("wraps non-Error throws", async () => {
    await expect(
      withSpan("op.str", {}, () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- exercising the non-Error branch
        throw "x";
      }),
    ).rejects.toBe("x");
    await settle();
    expect(spans.getFinishedSpans().find((x) => x.name === "op.str")?.status.message).toBe("x");
  });
});

describe("market baggage", () => {
  it("is visible inside the callback, absent outside, and stamped on spans", async () => {
    expect(getMarketId()).toBeUndefined();
    await withMarket("eg", async () => {
      expect(getMarketId()).toBe("eg");
      await withSpan("op.market", {}, () => undefined);
    });
    expect(getMarketId()).toBeUndefined();
    await settle();
    expect(spans.getFinishedSpans().find((x) => x.name === "op.market")?.attributes.market_id).toBe("eg");
  });
  it("propagates through W3C baggage headers", () => {
    withMarket("eg", () => {
      const carrier: Record<string, string> = {};
      propagation.inject(context.active(), carrier);
      expect(carrier.baggage).toContain("market_id=eg");
      const extracted = propagation.extract(context.active(), carrier);
      expect(propagation.getBaggage(extracted)?.getEntry("market_id")?.value).toBe("eg");
    });
  });
});

describe("SLO metrics", () => {
  it("records counters, histograms and the gauge", async () => {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 });
    const mp = new MeterProvider({ readers: [reader] });
    const m = createSloMetrics(mp.getMeter("t"));
    m.checkoutAttempt();
    m.checkoutAttempt({ market_id: "eg" });
    m.checkoutSuccess();
    m.recordWebhookToPaid(1.2);
    m.recordApiRead(0.1);
    m.recordReserve(0.05);
    m.setUnmatchedPspLines(3);
    await reader.forceFlush();
    const all = exporter.getMetrics().flatMap((r) => r.scopeMetrics.flatMap((s) => s.metrics));
    const byName = (n: string) => all.find((x) => x.descriptor.name === n);
    const sum = (n: string) => byName(n)?.dataPoints.reduce((a, d) => a + (d.value as number), 0);
    expect(sum("checkout_attempts_total")).toBe(2);
    expect(sum("checkout_success_total")).toBe(1);
    for (const n of ["webhook_to_paid_seconds", "api_read_latency_seconds", "reserve_latency_seconds"]) {
      expect((byName(n)?.dataPoints[0]?.value as { count: number }).count).toBe(1);
    }
    expect(sum("unmatched_psp_lines")).toBe(3);
    await mp.shutdown();
  });
  it("works with the global meter by default", () => {
    expect(() => { createSloMetrics().checkoutAttempt(); }).not.toThrow();
  });
});

describe("initTelemetry otlp", () => {
  it("starts and shuts down with the OTLP exporters configured", async () => {
    const t = initTelemetry({ serviceName: "x", env: "test", exporter: "otlp", otlpEndpoint: "http://127.0.0.1:1/" });
    await t.shutdown().catch(() => undefined);
  });
});

describe("pgConnectionTag", () => {
  it("returns known names and rejects unknown", () => {
    expect(pgConnectionTag("checkout.reserve")).toBe("checkout.reserve");
    expect(() => pgConnectionTag("evil" as never)).toThrow();
  });
});
