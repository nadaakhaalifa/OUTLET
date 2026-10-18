import { trace } from "@opentelemetry/api";
import { redactRecord } from "./redact";

/** Builds one structured JSON log line: redacted fields plus trace correlation when a span is active. */
export function formatLogLine(level: string, event: string, fields: Readonly<Record<string, unknown>>): string {
  const sc = trace.getActiveSpan()?.spanContext();
  return JSON.stringify({
    level,
    event,
    ...(sc === undefined ? {} : { trace_id: sc.traceId, span_id: sc.spanId }),
    ...redactRecord(fields),
  });
}
