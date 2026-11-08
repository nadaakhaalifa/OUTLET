import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { Attributes, Span } from "@opentelemetry/api";
import { getMarketId } from "./baggage.js";

const TRACER = "@outlet/observability";

/** Runs fn inside a span; records exceptions, sets ERROR status and rethrows. Adds market_id from baggage. */
export const withSpan = async <T>(name: string, attrs: Attributes, fn: (span: Span) => Promise<T> | T): Promise<T> => {
  const marketId = getMarketId();
  return trace.getTracer(TRACER).startActiveSpan(name, { attributes: marketId ? { market_id: marketId, ...attrs } : attrs }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
      throw err;
    } finally {
      span.end();
    }
  });
};
