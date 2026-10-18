import { type CallHandler, type ExecutionContext, Inject, Injectable, type NestInterceptor } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import {
  hashRequest,
  type CanonicalValue,
  type IdempotencyService,
  type JsonValue,
  type StoredResponse,
} from "@outlet/idempotency";
import { type Observable, from, lastValueFrom, map } from "rxjs";
import { IDEMPOTENT_META, type IdempotentOptions } from "./decorators";
import { headerValue, type ApiRequest, type ApiResponse } from "./http-types";
import { Problems } from "./problem";
import { IDEMPOTENCY_SERVICE } from "./tokens";

/**
 * Wraps `@Idempotent()` handlers with @outlet/idempotency (spec T5):
 * - same key and same request: stored response replayed with `Idempotent-Replayed: true`
 * - same key, different request: 422; same key still in flight: 409
 * - handler error: nothing stored, key released, so a retry runs again
 * The key is scoped to the authenticated actor (or the client IP before login).
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(IDEMPOTENCY_SERVICE) private readonly service: IdempotencyService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const options = this.reflector.getAllAndOverride<IdempotentOptions | undefined>(IDEMPOTENT_META, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (options === undefined) return next.handle();

    const http = context.switchToHttp();
    const req = http.getRequest<ApiRequest>();
    const res = http.getResponse<ApiResponse>();
    const key = headerValue(req, "idempotency-key");
    if (key === undefined) {
      if (options.required) throw Problems.invalidIdempotencyKey();
      return next.handle();
    }

    const routePath = req.route?.path ?? req.path ?? "";
    const route = `${req.method.toUpperCase()} ${routePath}`;
    const actor = req.principal?.actor.id ?? `anonymous:ip:${req.ip ?? "unknown"}`;
    const body = req.body === undefined || req.body === null ? null : (req.body as CanonicalValue);
    const requestHash = hashRequest({
      method: req.method,
      route: routePath,
      query: withPath(queryFingerprint(req.query), req.path ?? routePath),
      body,
    });

    return from(
      this.service.execute({
        key,
        route,
        actor,
        requestHash,
        handler: async (): Promise<StoredResponse> => {
          const result = await lastValueFrom(next.handle(), { defaultValue: undefined });
          return {
            status: res.statusCode,
            headers: {},
            body: result === undefined ? null : (result as JsonValue),
          };
        },
      }),
    ).pipe(
      map((r) => {
        if (r.replayed) {
          res.setHeader("Idempotent-Replayed", "true");
          res.status(r.response.status);
          // Replays carry the same private response as the original; authenticated bodies must never be cached.
          if (req.principal !== undefined) res.setHeader("Cache-Control", "private, no-store");
        }
        return r.response.status === 204 ? undefined : r.response.body;
      }),
    );
  }
}

function queryFingerprint(query: unknown): CanonicalValue {
  if (typeof query !== "object" || query === null) return null;
  const entries: Array<[string, CanonicalValue]> = [];
  for (const [k, v] of Object.entries(query)) {
    if (typeof v === "string") entries.push([k, v]);
    else if (Array.isArray(v) && v.every((x) => typeof x === "string")) entries.push([k, v as string[]]);
  }
  return Object.fromEntries(entries);
}


/** Binds the concrete path (so path params such as an order line id) into the request hash. */
function withPath(query: CanonicalValue, path: string): CanonicalValue {
  const base = typeof query === "object" && query !== null && !Array.isArray(query) ? query : {};
  return { ...base, "@path": path };
}
