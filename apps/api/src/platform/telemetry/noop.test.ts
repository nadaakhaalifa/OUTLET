import { describe, expect, it } from "vitest";
import { sampleRatioFrom, startTelemetry } from "./bootstrap";
import { instruments } from "./metrics";
import { withSpan } from "./tracing";

describe("telemetry bootstrap", () => {
  it("is a no-op without OTEL_EXPORTER_OTLP_ENDPOINT", async () => {
    const h = startTelemetry({});
    expect(h.enabled).toBe(false);
    await expect(h.shutdown()).resolves.toBeUndefined();
    expect(startTelemetry({ OTEL_EXPORTER_OTLP_ENDPOINT: "  " }).enabled).toBe(false);
  });
  it("instruments and spans work (as no-ops) with no provider", async () => {
    instruments().counter("outlet.checkout.attempts").add(1, { outcome: "placed" });
    instruments().setGauge("outlet.outbox.lag", 3);
    await expect(withSpan("x", {}, async () => 7)).resolves.toBe(7);
  });
  it("rejects unregistered instruments", () => {
    expect(() => instruments().counter("nope")).toThrow();
  });
  it("defaults sampling to 10% and ignores bad values", () => {
    expect(sampleRatioFrom({})).toBe(0.1);
    expect(sampleRatioFrom({ OTEL_TRACES_SAMPLER_ARG: "2" })).toBe(0.1);
    expect(sampleRatioFrom({ OTEL_TRACES_SAMPLER_ARG: "0.5" })).toBe(0.5);
  });
  it("does not throw when the collector is unreachable", async () => {
    const h = startTelemetry({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:1" });
    expect(h.enabled).toBe(true);
    await withSpan("probe", {}, async () => 1);
    await h.shutdown();
  });
});
