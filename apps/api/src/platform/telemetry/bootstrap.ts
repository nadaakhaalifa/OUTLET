import type { SpanKind, Attributes, Context, Link } from "@opentelemetry/api";
import { NodeSDK, metrics as sdkMetrics, tracing } from "@opentelemetry/sdk-node";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

export interface TelemetryHandle {
  readonly enabled: boolean;
  shutdown(): Promise<void>;
}

const NOOP: TelemetryHandle = { enabled: false, shutdown: async () => undefined };

/**
 * Head sampler: parent-based; roots use a trace-id ratio (default 10%). A span created with
 * `outlet.sample.force=true` (error hint) is always sampled when it is a root. Errors that appear
 * after the sampling decision are only exported if the trace was sampled: full tail sampling needs
 * a collector `tail_sampling` processor keyed on `outlet.sample.force` (see docs/engineering/observability.md).
 */
export function createSampler(ratio: number): tracing.Sampler {
  const root = new tracing.TraceIdRatioBasedSampler(ratio);
  const inner = new tracing.ParentBasedSampler({ root });
  return {
    shouldSample(ctx: Context, traceId: string, name: string, kind: SpanKind, attrs: Attributes, links: Link[]) {
      return attrs["outlet.sample.force"] === true
        ? { decision: tracing.SamplingDecision.RECORD_AND_SAMPLED }
        : inner.shouldSample(ctx, traceId, name, kind, attrs, links);
    },
    toString: () => `OutletSampler(${ratio})`,
  };
}

export function sampleRatioFrom(env: Readonly<Record<string, string | undefined>>): number {
  const raw = env["OTEL_TRACES_SAMPLER_ARG"];
  const n = raw === undefined ? 0.1 : Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.1;
}

/**
 * NO-OP unless OTEL_EXPORTER_OTLP_ENDPOINT is set. Never throws: a bad config or a down collector
 * must not stop the API. Queues are bounded; exporters drop on overflow and time out quickly.
 */
export function startTelemetry(env: Readonly<Record<string, string | undefined>> = process.env, serviceName = "outlet-api"): TelemetryHandle {
  const endpoint = env["OTEL_EXPORTER_OTLP_ENDPOINT"];
  if (endpoint === undefined || endpoint.trim() === "") return NOOP;
  try {
    const base = endpoint.replace(/\/+$/, "");
    const sdk = new NodeSDK({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: env["OTEL_SERVICE_NAME"] ?? serviceName,
        "deployment.environment.name": env["NODE_ENV"] ?? "development",
      }),
      sampler: createSampler(sampleRatioFrom(env)),
      spanProcessors: [
        new tracing.BatchSpanProcessor(new OTLPTraceExporter({ url: `${base}/v1/traces`, timeoutMillis: 5_000 }), {
          maxQueueSize: 2048,
          maxExportBatchSize: 512,
          scheduledDelayMillis: 5_000,
          exportTimeoutMillis: 5_000,
        }),
      ],
      metricReaders: [
        new sdkMetrics.PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter({ url: `${base}/v1/metrics`, timeoutMillis: 5_000 }),
          exportIntervalMillis: 15_000,
          exportTimeoutMillis: 5_000,
        }),
      ],
    });
    sdk.start();
    return {
      enabled: true,
      shutdown: async () => {
        try {
          await sdk.shutdown();
        } catch {
          // collector unreachable at shutdown: telemetry loss is acceptable.
        }
      },
    };
  } catch {
    return NOOP;
  }
}
