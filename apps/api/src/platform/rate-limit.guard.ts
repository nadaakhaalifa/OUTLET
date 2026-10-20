import { type CanActivate, type ExecutionContext, Inject, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { sha256Hex } from "@outlet/idempotency";
import { RATE_LIMIT_META, type RateLimitDimension, type RateLimitMeta, type RateLimitSpec } from "./decorators";
import { headerValue, type ApiRequest, type ApiResponse } from "./http-types";
import type { Authenticator, Clock, RateLimitOutcome, RateLimiter } from "./ports";
import { resolvePrincipal } from "./principal";
import { ProblemError, Problems } from "./problem";
import { AUTHENTICATOR, CLOCK, RATE_LIMITER } from "./tokens";

/** Applied when a route declares nothing: bounded by client IP. Value is a proposal, tune from traffic. */
export const DEFAULT_RATE_LIMIT: RateLimitMeta = {
  rules: [{ dimension: "ip", limit: 120, windowSeconds: 60 }],
  onLimiterError: "open",
};

function bodyString(body: unknown, path: readonly string[]): string | undefined {
  let cur: unknown = body;
  for (const key of path) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Readonly<Record<string, unknown>>)[key];
  }
  return typeof cur === "string" && cur.length > 0 && cur.length <= 256 ? cur : undefined;
}

/**
 * Global guard, runs before the policy guard so unauthenticated floods are counted. The key
 * material is hashed before it reaches the limiter port.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(AUTHENTICATOR) private readonly authenticator: Authenticator,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const meta =
      this.reflector.getAllAndOverride<RateLimitMeta | undefined>(RATE_LIMIT_META, [
        context.getHandler(),
        context.getClass(),
      ]) ?? DEFAULT_RATE_LIMIT;
    if (meta.rules.length === 0) return true;

    const http = context.switchToHttp();
    const req = http.getRequest<ApiRequest>();
    const res = http.getResponse<ApiResponse>();
    const routeId = `${req.method} ${req.route?.path ?? req.path ?? "?"}`;
    const nowMs = this.clock.nowMs();

    const outcomes: RateLimitOutcome[] = [];
    try {
      for (const rule of meta.rules) {
        const subject = await this.subject(rule.dimension, req);
        // A dimension whose value is absent cannot be counted; the schema validation that follows
        // rejects such requests, and the IP rule (if declared) still applies.
        if (subject === undefined) continue;
        const key = `rl:v1:${sha256Hex(`${routeId}|${rule.dimension}|${subject}`)}`;
        outcomes.push(await this.limiter.consume(key, { limit: rule.limit, windowMs: rule.windowSeconds * 1000 }, nowMs));
      }
    } catch (e) {
      if (e instanceof ProblemError) throw e;
      if (meta.onLimiterError === "closed") throw Problems.unavailable("rate_limiter_unavailable");
      return true;
    }
    if (outcomes.length === 0) return true;

    const tightest = outcomes.reduce((a, b) => (b.remaining < a.remaining ? b : a));
    res.setHeader("RateLimit-Limit", tightest.limit);
    res.setHeader("RateLimit-Remaining", tightest.remaining);
    res.setHeader("RateLimit-Reset", Math.max(0, Math.ceil((tightest.resetAtMs - nowMs) / 1000)));
    const blocked = outcomes.filter((o) => !o.allowed);
    if (blocked.length > 0) {
      const resetAt = Math.max(...blocked.map((o) => o.resetAtMs));
      throw Problems.rateLimited((resetAt - nowMs) / 1000);
    }
    return true;
  }

  private async subject(dimension: RateLimitDimension, req: ApiRequest): Promise<string | undefined> {
    switch (dimension) {
      case "ip":
        return req.ip ?? "unknown";
      case "user": {
        const p = await resolvePrincipal(req, this.authenticator, this.clock);
        return p?.actor.id;
      }
      case "session": {
        // The verified token's session id (never the unattested client install id).
        const p = await resolvePrincipal(req, this.authenticator, this.clock);
        return p === null ? undefined : `${p.actor.id}:${p.claims.sid}`;
      }
      case "device":
        return (
          headerValue(req, "x-device-id") ??
          bodyString(req.body, ["device", "install_id"]) ??
          // Pre-login routes: the attestation token identifies the device (hashed before use).
          headerValue(req, "x-app-attest")
        );
      case "phone":
        return bodyString(req.body, ["phone_e164"]);
      case "challenge":
        return bodyString(req.body, ["challenge_id"]);
    }
  }
}

export type { RateLimitSpec };
