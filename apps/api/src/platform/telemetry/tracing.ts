import { ROOT_CONTEXT, SpanKind, SpanStatusCode, context, trace, type Span, type TraceFlags } from "@opentelemetry/api";
import { sanitizeAttributes } from "./attributes";
import { fingerprintSql } from "./redact";
import { instruments } from "./metrics";

const TRACER = "outlet-api";
export const tracer = () => trace.getTracer(TRACER);

export type Outcome = "success" | "error";

/** Runs `fn` in a span. Marks the span for 100% sampling-export hint on error. Never swallows errors. */
export async function withSpan<T>(
  name: string,
  attrs: Readonly<Record<string, unknown>>,
  fn: (span: Span) => Promise<T>,
  kind: SpanKind = SpanKind.INTERNAL,
): Promise<T> {
  return tracer().startActiveSpan(name, { kind, attributes: sanitizeAttributes(attrs) }, async (span) => {
    try {
      const r = await fn(span);
      span.setAttribute("outlet.outcome", "success");
      return r;
    } catch (e) {
      markError(span, e);
      throw e;
    } finally {
      span.end();
    }
  });
}

export function markError(span: Span, e: unknown): void {
  span.setAttribute("outlet.outcome", "error");
  span.setAttribute("outlet.sample.force", true);
  span.setAttribute("outlet.error.class", e instanceof Error ? e.name : "unknown");
  span.setStatus({ code: SpanStatusCode.ERROR });
}

/** Provider call span plus counters. Attributes: provider name and outcome only. */
export async function traceProviderCall<T>(provider: string, operation: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  let outcome: Outcome = "success";
  try {
    return await withSpan(`provider ${provider}.${operation}`, { "outlet.provider": provider, "outlet.provider.operation": operation }, fn, SpanKind.CLIENT);
  } catch (e) {
    outcome = "error";
    throw e;
  } finally {
    const i = instruments();
    i.counter("outlet.provider.calls").add(1, { provider, outcome });
    i.histogram("outlet.provider.call.duration").record((performance.now() - start) / 1000, { provider, outcome });
  }
}

/** Worker job or outbox relay run span. */
export function traceJob<T>(job: string, fn: () => Promise<T>): Promise<T> {
  return withSpan(`job ${job}`, { "outlet.job": job }, fn);
}

/** Kysely `log` hook shape (structural, so this file does not import kysely). */
export interface QueryLogEvent {
  readonly level: "query" | "error";
  readonly queryDurationMillis: number;
  readonly query: { readonly sql: string };
}

/**
 * Pass as `new Kysely({ log: kyselyTelemetryLog(() => currentProcess) })`. Records a span (retroactive)
 * and a duration histogram with the statement fingerprint only: parameters are never read.
 */
export function kyselyTelemetryLog(processName: () => string | undefined = () => undefined): (e: QueryLogEvent) => void {
  return (e) => {
    const fp = fingerprintSql(e.query.sql);
    const proc = processName();
    const end = Date.now();
    const span = tracer().startSpan("db query", {
      kind: SpanKind.CLIENT,
      startTime: end - e.queryDurationMillis,
      attributes: sanitizeAttributes({
        "db.system": "postgresql",
        "db.statement.fingerprint": fp.text,
        "db.statement.hash": fp.hash,
        ...(proc === undefined ? {} : { "db.application_name": proc }),
      }),
    });
    if (e.level === "error") markError(span, new Error("db"));
    span.end(end);
    instruments().histogram("outlet.db.query.duration").record(e.queryDurationMillis / 1000, { application_name: proc ?? "unknown" });
  };
}

/** Wraps a DB business process (checkout.reserve ...) and records `application_name` on the span. */
export function traceDbProcess<T>(processName: string, fn: () => Promise<T>): Promise<T> {
  return withSpan(`db ${processName}`, { "db.system": "postgresql", "db.application_name": processName, "outlet.process": processName }, fn);
}

export function parentContextFrom(ctx: { traceId: string; parentSpanId: string | null; traceFlags: string }) {
  if (ctx.parentSpanId === null) return context.active();
  return trace.setSpanContext(ROOT_CONTEXT, {
    traceId: ctx.traceId,
    spanId: ctx.parentSpanId,
    traceFlags: (parseInt(ctx.traceFlags, 16) & 1) as TraceFlags,
    isRemote: true,
  });
}
