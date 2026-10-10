import { AsyncLocalStorage } from "node:async_hooks";
import { headerValue, type ApiRequest, type ApiResponse, type RequestContext } from "./http-types";
import type { IdGenerator } from "./ports";

const storage = new AsyncLocalStorage<RequestContext>();

export function currentRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;
const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.*)?$/;

export interface ParsedTraceparent {
  readonly traceId: string;
  readonly parentSpanId: string;
  readonly flags: string;
}

/** Strict W3C Trace Context parser. Returns null for anything invalid so a new trace is started. */
export function parseTraceparent(header: string | undefined): ParsedTraceparent | null {
  if (header === undefined) return null;
  const m = TRACEPARENT.exec(header.trim().toLowerCase());
  if (!m) return null;
  const [, version, traceId, parentId, flags, rest] = m;
  if (version === undefined || traceId === undefined || parentId === undefined || flags === undefined) return null;
  if (version === "ff") return null;
  if (version === "00" && rest !== undefined) return null;
  if (/^0+$/.test(traceId) || /^0+$/.test(parentId)) return null;
  return { traceId, parentSpanId: parentId, flags };
}

export function formatTraceparent(ctx: Pick<RequestContext, "traceId" | "spanId" | "traceFlags">): string {
  return `00-${ctx.traceId}-${ctx.spanId}-${ctx.traceFlags}`;
}

export function buildRequestContext(
  incoming: { requestId: string | undefined; traceparent: string | undefined },
  ids: IdGenerator,
): RequestContext {
  const requestId =
    incoming.requestId !== undefined && SAFE_REQUEST_ID.test(incoming.requestId) ? incoming.requestId : ids.uuidV7();
  const parent = parseTraceparent(incoming.traceparent);
  return {
    requestId,
    traceId: parent?.traceId ?? ids.hex(16),
    spanId: ids.hex(8),
    parentSpanId: parent?.parentSpanId ?? null,
    traceFlags: parent?.flags ?? "00",
  };
}

/**
 * Express level middleware (installed in `configureApp`, so it also covers 404s and parser
 * errors). Sets X-Request-Id and traceparent on the response and runs the rest of the request
 * inside an AsyncLocalStorage scope.
 */
export function createRequestContextMiddleware(ids: IdGenerator) {
  return (req: ApiRequest, res: ApiResponse, next: () => void): void => {
    const ctx = buildRequestContext(
      { requestId: headerValue(req, "x-request-id"), traceparent: headerValue(req, "traceparent") },
      ids,
    );
    req.ctx = ctx;
    res.setHeader("X-Request-Id", ctx.requestId);
    res.setHeader("traceparent", formatTraceparent(ctx));
    storage.run(ctx, next);
  };
}

export type { RequestContext };
