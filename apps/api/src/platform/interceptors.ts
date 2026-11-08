import { Inject, Injectable } from "@nestjs/common";
import type { CallHandler, ExecutionContext, NestInterceptor } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { requestHash } from "@outlet/idempotency";
import { uuidV7Schema, uuidV7Timestamp } from "@outlet/ids";
import { withMarket, withSpan } from "@outlet/observability";
import { from, lastValueFrom, throwError, timeout } from "rxjs";
import type { Observable } from "rxjs";
import { META } from "./decorators.js";
import type { AuthzMeta, ContractDef, DeprecationMeta } from "./decorators.js";
import { API_DEPS } from "./deps.js";
import type { ApiDeps } from "./deps.js";
import { MUTATING_METHODS, headerValue } from "./http.js";
import type { ApiReply, ApiRequest } from "./http.js";
import { ProblemError, Problems } from "./problem.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const routeTemplate = (req: ApiRequest): string => req.routeOptions.url ?? "unknown";

/**
 * Outermost: response headers that must also be on replays and errors' happy siblings (Cache-Control, deprecation),
 * OTel span + market baggage, and the 10 s handler timeout (503 `timeout`).
 *
 * LIMITATION: the timeout only stops waiting; it does NOT cancel the handler. A handler's database work keeps running
 * until the 10 s pool `statement_timeout` ends it, and a started write may still commit after the client got 503
 * (idempotent writes make the retry safe). TODO(abort-signal): create an AbortController per request here, expose its
 * signal on `req.ctx`, abort it on timeout, and pass it to pg queries and outbound calls (platform/outbound withTimeout).
 */
@Injectable()
export class TelemetryInterceptor implements NestInterceptor {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(API_DEPS) private readonly deps: ApiDeps,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<ApiRequest>();
    const reply = ctx.switchToHttp().getResponse<ApiReply>();
    const contract = this.reflector.get<ContractDef | undefined>(META.contract, ctx.getHandler());
    const authz = this.reflector.get<AuthzMeta | undefined>(META.authz, ctx.getHandler());
    const dep = this.reflector.get<DeprecationMeta | undefined>(META.deprecated, ctx.getHandler());
    void reply.header("cache-control", authz?.kind === "public" && contract?.cacheControl !== undefined ? contract.cacheControl : "private, no-store");
    if (dep !== undefined) {
      void reply.header("deprecation", `@${String(Math.floor(dep.deprecatedAt.getTime() / 1000))}`);
      void reply.header("sunset", dep.sunset.toUTCString());
      if (dep.link !== undefined) void reply.header("link", `<${dep.link}>; rel="deprecation"`);
    }
    const route = routeTemplate(req);
    const run = (): Promise<unknown> =>
      withSpan(`${req.method} ${route}`, { "http.request.method": req.method, "http.route": route, "outlex.request_id": req.ctx.requestId }, () =>
        lastValueFrom(
          next.handle().pipe(timeout({ first: this.deps.http.requestTimeoutMs, with: () => throwError(() => Problems.unavailable("timeout")) })),
          { defaultValue: undefined },
        ),
      );
    const market = req.ctx.market?.id;
    return from(market === undefined ? run() : withMarket(market, run));
  }
}

/**
 * Every POST/PUT/PATCH/DELETE (unless @NoIdempotency): `Idempotency-Key` must be a UUIDv7 minted within ±24 h.
 * Fresh → run and store; same key + same request → replay (`Idempotent-Replayed: true`); different request → 422;
 * still running → 409. Any failure abandons the key so a retry runs again. Guards ran first, so authz is re-checked.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(API_DEPS) private readonly deps: ApiDeps,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<ApiRequest>();
    if (!MUTATING_METHODS.includes(req.method)) return next.handle();
    if (this.reflector.get<string | undefined>(META.noIdempotency, ctx.getHandler()) !== undefined) return next.handle();
    return from(this.run(req, ctx.switchToHttp().getResponse<ApiReply>(), next));
  }

  private async run(req: ApiRequest, reply: ApiReply, next: CallHandler): Promise<unknown> {
    const key = this.validKey(headerValue(req, "idempotency-key"));
    const actorId = req.ctx.user?.userId ?? this.deviceActor(req);
    const id = { key, actorId, route: `${req.method} ${routeTemplate(req)}` };
    const hash = requestHash({ params: req.params ?? {}, query: req.query ?? {}, body: req.body ?? null, store: req.ctx.storeId ?? null });
    const begun = await this.deps.idempotency.begin({ ...id, requestHash: hash });
    switch (begun.kind) {
      case "conflict":
        throw Problems.idempotencyKeyReuse();
      case "in_progress":
        throw Problems.idempotencyInFlight();
      case "replay":
        void reply.header("idempotent-replayed", "true").header("cache-control", "private, no-store").status(begun.response.status);
        return begun.response.body;
      case "fresh":
        break;
    }
    let body: unknown;
    try {
      body = await lastValueFrom(next.handle(), { defaultValue: undefined });
    } catch (e) {
      await this.deps.idempotency.abandon(id).catch(() => {
        req.ctx.log.error("idempotency abandon failed", { route: id.route });
      });
      throw e;
    }
    try {
      await this.deps.idempotency.complete(id, { status: reply.statusCode, body: (body ?? null) as never });
    } catch {
      // The side effect happened: answer it. The key stays in progress until it expires (retries get 409).
      req.ctx.log.error("idempotency complete failed", { route: id.route });
    }
    return body;
  }

  private validKey(raw: string | undefined): string {
    if (raw === undefined || !uuidV7Schema.safeParse(raw).success) throw Problems.idempotencyKeyInvalid();
    const skew = Math.abs(uuidV7Timestamp(raw) - this.deps.clock.now().getTime());
    if (skew > DAY_MS) throw Problems.idempotencyKeyInvalid();
    return raw;
  }

  private deviceActor(req: ApiRequest): string {
    const d = headerValue(req, "x-device-id");
    if (d === undefined || !UUID.test(d)) throw Problems.badRequest("device-id-required");
    return d.toLowerCase();
  }
}

/** Innermost: the handler result is parsed through the contract's response schema (explicit allow-list serializer). */
@Injectable()
export class SerializeInterceptor implements NestInterceptor {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const contract = this.reflector.get<ContractDef | undefined>(META.contract, ctx.getHandler());
    const req = ctx.switchToHttp().getRequest<ApiRequest>();
    return from(
      lastValueFrom(next.handle(), { defaultValue: undefined }).then((body) => {
        if (contract === undefined) throw Problems.internal("contract-undeclared");
        const r = contract.response.safeParse(body);
        if (r.success) return r.data;
        req.ctx.log.error("response violates its contract", { route: routeTemplate(req), issues: r.error.issues.length });
        throw new ProblemError(500, "response-contract-violation", "Internal server error");
      }),
    );
  }
}
