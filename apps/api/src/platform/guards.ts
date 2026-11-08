import { createHmac } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { CanActivate, ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { KillSwitchName } from "@outlet/flags";
import { authorize } from "@outlet/policy";
import type { Principal } from "@outlet/policy";
import { z } from "zod";
import { META } from "./decorators.js";
import type { AuthzMeta, RateLimitMeta } from "./decorators.js";
import { API_DEPS } from "./deps.js";
import type { ApiDeps } from "./deps.js";
import { headerValue } from "./http.js";
import type { ApiRequest, RequestState } from "./http.js";
import { ProblemError, Problems } from "./problem.js";
import { KEY_MULTIPLIER } from "./rate-limit/budgets.js";
import type { RateKey } from "./rate-limit/budgets.js";
import type { RateDecision } from "./rate-limit/port.js";

const BEARER = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;
const UUID = z.uuid();
const REASON = /^[a-z_]{3,40}(:[A-Za-z0-9-]{1,40})?$/;
/** Seller routes need a phishing-resistant factor in the session (DM-09). auth-core says "passkey"; the contract says "hwk". */
const STRONG_AMR = new Set(["passkey", "hwk"]);

const meta = (reflector: Reflector, key: string, ctx: ExecutionContext): unknown => reflector.get<unknown>(key, ctx.getHandler());

const reqOf = (ctx: ExecutionContext): ApiRequest => ctx.switchToHttp().getRequest<ApiRequest>();

/** Authenticated routes need a market (the token is bound to it); missing or unknown → 404 like any unknown path. */
const marketOf = (s: RequestState): string => {
  if (s.marketId === undefined) throw Problems.notFound("unknown-market");
  return s.marketId;
};

/**
 * 1st guard. Deny by default: a route without @Public()/@Authorize() is refused (the bootstrap audit already refuses
 * to start such an app; this is the second line). Public routes ignore credentials, so caches never mix principals.
 */
@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(API_DEPS) private readonly deps: ApiDeps,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const authz = (meta(this.reflector, META.authz, ctx) as AuthzMeta | undefined);
    if (authz === undefined) throw Problems.forbidden("no-policy-declared");
    if (authz.kind === "public") return true;
    const req = reqOf(ctx);
    const marketId = marketOf(req.ctx);
    const header = headerValue(req, "authorization");
    if (header === undefined) throw Problems.unauthenticated();
    const m = BEARER.exec(header);
    if (m?.[1] === undefined || m[1].length > 4096) throw Problems.unauthenticated("invalid-token");
    req.ctx.user = await this.deps.tokens.verify(m[1], marketId, this.deps.clock.now());
    return true;
  }
}

/**
 * 2nd guard: @outlet/policy decision, tenant scoping and the per-request database context.
 * Store tenant: X-Store-Id must be a store the caller is an active member of (else 404), the session needs a passkey
 * (else 403 passkey-required), and the principal carries only that store and that store's roles (ADR draft H6).
 */
@Injectable()
export class PolicyGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(API_DEPS) private readonly deps: ApiDeps,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const authz = (meta(this.reflector, META.authz, ctx) as AuthzMeta | undefined);
    const req = reqOf(ctx);
    const s = req.ctx;
    if (authz === undefined) throw Problems.forbidden("no-policy-declared");
    if (authz.kind === "public") {
      if (s.marketId !== undefined) s.db = { kind: "user", marketId: s.marketId };
      return true;
    }
    const user = s.user;
    if (user === undefined) throw Problems.unauthenticated();
    const marketId = marketOf(s);
    let principal: Principal = { kind: "shopper", userId: user.userId, marketId, roles: [], scopes: [] };
    let storeId: string | undefined;
    if (authz.tenant === "store") {
      const raw = headerValue(req, "x-store-id");
      if (raw === undefined || !UUID.safeParse(raw).success) throw Problems.badRequest("store-scope-required");
      storeId = raw.toLowerCase();
      const membership = await this.deps.memberships.find(marketId, user.userId, storeId);
      if (membership === null) throw Problems.notFound();
      if (!user.amr.some((a) => STRONG_AMR.has(a))) throw Problems.forbidden("passkey-required");
      principal = { kind: "seller_staff", userId: user.userId, marketId, storeIds: [storeId], roles: [...membership.roles], scopes: [] };
    }
    if ((meta(this.reflector, META.reasonCode, ctx) as boolean | undefined) === true) {
      const reason = headerValue(req, "x-reason-code");
      if (reason === undefined || !REASON.test(reason)) throw Problems.forbidden("reason-code-required");
      s.reasonCode = reason;
    }
    const resource = await authz.resolver({ req, marketId, userId: user.userId, storeId });
    if (resource === null) throw Problems.notFound();
    const decision = authorize(principal, authz.action, resource);
    if (decision.effect === "deny") {
      s.log.info("authz denied", { action: authz.action, reason: decision.reason, tenant: authz.tenant });
      throw decision.reason === "not_found" ? Problems.notFound() : Problems.forbidden();
    }
    s.principal = principal;
    s.storeId = storeId;
    s.db = storeId === undefined ? { kind: "user", marketId, userId: user.userId } : { kind: "store", marketId, storeId, userId: user.userId };
    return true;
  }
}

/**
 * 3rd guard (after policy, so a forged X-Store-Id cannot drain another store's budget). One GCRA bucket per declared
 * key; any exhausted bucket answers 429 + Retry-After. Key values are HMAC-hashed before they reach the limiter.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(API_DEPS) private readonly deps: ApiDeps,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const rl = (meta(this.reflector, META.rateLimit, ctx) as RateLimitMeta | undefined);
    if (rl === undefined) throw Problems.internal("rate-limit-undeclared");
    if ("exempt" in rl) return true;
    const req = reqOf(ctx);
    const values = rl.keys.map((k) => [k, this.keyValue(k, req)] as const).filter((x): x is readonly [RateKey, string] => x[1] !== undefined);
    if (!values.some(([k]) => k !== "ip" && k !== "asn")) throw Problems.badRequest("rate-limit-key-missing");
    let decisions: RateDecision[];
    try {
      decisions = await Promise.all(
        values.map(([k, v]) =>
          this.deps.rateLimiter.hit(`${rl.budget.name}:${k}:${this.hash(v)}`, { limit: rl.budget.limit * KEY_MULTIPLIER[k], periodMs: rl.budget.periodMs }),
        ),
      );
    } catch (e) {
      req.ctx.log.warn("rate limiter unavailable", { budget: rl.budget.name, failMode: rl.budget.failMode, error: e instanceof Error ? e.name : "unknown" });
      if (rl.budget.failMode === "closed") throw Problems.unavailable("rate-limiter-unavailable");
      return true;
    }
    const denied = decisions.filter((d) => !d.allowed);
    if (denied.length > 0) throw Problems.rateLimited(Math.max(...denied.map((d) => d.retryAfterMs)) / 1000);
    return true;
  }

  private keyValue(k: RateKey, req: ApiRequest): string | undefined {
    switch (k) {
      case "user":
        return req.ctx.user?.userId;
      case "store":
        return req.ctx.storeId;
      case "ip":
        return req.ip;
      case "asn": {
        if (!this.deps.http.trustAsnHeader) return undefined;
        const asn = headerValue(req, "x-client-asn");
        return asn !== undefined && /^\d{1,10}$/.test(asn) ? asn : undefined;
      }
      case "device": {
        const d = headerValue(req, "x-device-id");
        if (d === undefined || !UUID.safeParse(d).success) throw Problems.badRequest("device-id-required");
        return d.toLowerCase();
      }
    }
  }

  private hash(v: string): string {
    return createHmac("sha256", this.deps.http.rateLimitKeySecret).update(v).digest("base64url").slice(0, 22);
  }
}

/** 4th guard: 503 `feature-disabled` while the route's kill switch is off. Money switches fail closed in @outlet/flags. */
@Injectable()
export class KillSwitchGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(API_DEPS) private readonly deps: ApiDeps,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const name = (meta(this.reflector, META.killSwitch, ctx) as KillSwitchName | undefined);
    if (name === undefined) return true;
    const s = reqOf(ctx).ctx;
    let killed: boolean;
    try {
      killed = await this.deps.killSwitches.isKilled(name, {
        marketId: s.marketId ?? "",
        ...(s.user === undefined ? {} : { userId: s.user.userId }),
        ...(s.storeId === undefined ? {} : { storeId: s.storeId }),
      });
    } catch {
      killed = true;
    }
    if (killed) throw new ProblemError(503, "feature-disabled", "This feature is temporarily unavailable");
    return true;
  }
}
