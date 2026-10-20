import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from "@nestjs/common";
import { SpanKind, context, trace } from "@opentelemetry/api";
import { Observable } from "rxjs";
import { sanitizeAttributes } from "./attributes";
import { instruments } from "./metrics";
import { hashId } from "./redact";
import { markError, parentContextFrom, tracer } from "./tracing";
import type { ApiRequest } from "../http-types";

interface RoutedRequest extends ApiRequest {
  route?: { path?: string };
}
interface StatusResponse {
  statusCode: number;
}

/**
 * Server span per handled request, continued from the request context's traceparent (the context
 * middleware already parsed it; this does not parse headers again). Route is the TEMPLATE
 * (`/v1/orders/:id`), never the raw URL. User ids are hashed.
 */
@Injectable()
export class HttpTelemetryInterceptor implements NestInterceptor {
  intercept(ec: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ec.getType() !== "http") return next.handle();
    const http = ec.switchToHttp();
    const req = http.getRequest<RoutedRequest>();
    const res = http.getResponse<StatusResponse>();
    const method = req.method;
    const route = req.route?.path ?? "unmatched";
    const ctx = req.ctx;
    const parent = ctx === undefined ? context.active() : parentContextFrom(ctx);
    const userId = (req as { principal?: { userId?: string } | null }).principal?.userId;
    const span = tracer().startSpan(
      `${method} ${route}`,
      {
        kind: SpanKind.SERVER,
        attributes: sanitizeAttributes({
          "http.request.method": method,
          "http.route": route,
          ...(ctx === undefined ? {} : { "outlet.request_id": ctx.requestId }),
          ...(userId === undefined ? {} : { "outlet.user_hash": hashId(userId) }),
        }),
      },
      parent,
    );
    const start = performance.now();
    const finish = (error: unknown): void => {
      const status = error === undefined ? res.statusCode : statusOf(error, res.statusCode);
      span.setAttribute("http.response.status_code", status);
      if (error !== undefined || status >= 500) markError(span, error);
      span.end();
      instruments()
        .histogram("http.server.request.duration")
        .record((performance.now() - start) / 1000, {
          "http.request.method": method,
          "http.route": route,
          "http.response.status_code": status,
        });
    };
    return new Observable((subscriber) =>
      context.with(trace.setSpan(parent, span), () =>
        next.handle().subscribe({
          next: (v) => subscriber.next(v),
          error: (e: unknown) => {
            finish(e);
            subscriber.error(e);
          },
          complete: () => {
            finish(undefined);
            subscriber.complete();
          },
        }),
      ),
    );
  }
}

function statusOf(e: unknown, fallback: number): number {
  if (typeof e === "object" && e !== null && "getStatus" in e && typeof (e as { getStatus: unknown }).getStatus === "function") {
    return (e as { getStatus(): number }).getStatus();
  }
  return fallback >= 400 ? fallback : 500;
}
