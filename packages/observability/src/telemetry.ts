import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import type { MetricReader } from "@opentelemetry/sdk-metrics";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace";
import type { SpanProcessor } from "@opentelemetry/sdk-trace";
import { resourceFromAttributes } from "@opentelemetry/resources";

export interface TelemetryOptions {
  readonly serviceName: string;
  readonly env: string;
  readonly exporter: "otlp" | "none";
  /** OTLP base URL; defaults to OTEL_EXPORTER_OTLP_ENDPOINT or http://127.0.0.1:4318. */
  readonly otlpEndpoint?: string;
  /** Extra processors/readers (used by tests with in-memory exporters). */
  readonly spanProcessors?: readonly SpanProcessor[];
  readonly metricReaders?: readonly MetricReader[];
}

export interface Telemetry {
  shutdown(): Promise<void>;
}

/**
 * Starts the OpenTelemetry Node SDK once per process. With exporter "none" nothing leaves the
 * process (spans and metrics are still created, so code paths behave the same in dev and tests).
 * The SDK default propagators are W3C trace-context + baggage, so market_id baggage crosses services.
 */
export const initTelemetry = (opts: TelemetryOptions): Telemetry => {
  const base = (opts.otlpEndpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://127.0.0.1:4318").replace(/\/$/, "");
  const spanProcessors: SpanProcessor[] = [...(opts.spanProcessors ?? [])];
  const metricReaders: MetricReader[] = [...(opts.metricReaders ?? [])];
  if (opts.exporter === "otlp") {
    spanProcessors.push(new BatchSpanProcessor({ exporter: new OTLPTraceExporter({ url: `${base}/v1/traces` }) }));
    metricReaders.push(
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: `${base}/v1/metrics` }),
        exportIntervalMillis: 15_000,
      }),
    );
  }
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      "service.name": opts.serviceName,
      "deployment.environment.name": opts.env,
    }),
    spanProcessors,
    metricReaders,
  });
  sdk.start();
  return { shutdown: () => sdk.shutdown() };
};
