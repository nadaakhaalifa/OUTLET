import { type CanActivate, type ExecutionContext, Inject, Injectable, Logger } from "@nestjs/common";
import { ModuleRef, Reflector } from "@nestjs/core";
import { decide, type Rule } from "@outlet/policy";
import { AUTHZ_META, ENROL_META, type AuthzMeta } from "./decorators";
import { headerValue, type ApiRequest } from "./http-types";
import type { AuditSink, Authenticator, Clock, ResourceResolver } from "./ports";
import { resolvePrincipal } from "./principal";
import { ProblemError, Problems } from "./problem";
import { AUDIT_SINK, AUTHENTICATOR, CLOCK, POLICY_RULES } from "./tokens";

/**
 * Global guard. Deny by default: a handler that declares neither `@Public()` nor an
 * authorization mode is refused with 403, so a forgotten decorator can never expose a route.
 */
@Injectable()
export class PolicyGuard implements CanActivate {
  private readonly logger = new Logger("PolicyGuard");

  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(ModuleRef) private readonly moduleRef: ModuleRef,
    @Inject(AUTHENTICATOR) private readonly authenticator: Authenticator,
    @Inject(POLICY_RULES) private readonly rules: readonly Rule[],
    @Inject(AUDIT_SINK) private readonly audit: AuditSink,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const meta = this.reflector.getAllAndOverride<AuthzMeta | undefined>(AUTHZ_META, [
      context.getHandler(),
      context.getClass(),
    ]);
    const req = context.switchToHttp().getRequest<ApiRequest>();

    if (meta === undefined) {
      this.logger.error(`route without authorization declaration denied request_id=${req.ctx?.requestId ?? "-"}`);
      throw Problems.forbidden("no_policy_declared");
    }
    if (meta.kind === "public") return true;

    const principal = await resolvePrincipal(req, this.authenticator, this.clock);
    if (principal === null) throw Problems.unauthenticated();
    if (principal.claims.aud !== meta.audience) throw Problems.unauthenticated("invalid_credentials");
    if (principal.actor.status !== "active") throw Problems.forbidden("account_not_active");
    if (principal.claims.scope === "seller:enrol") {
      const allowed = this.reflector.getAllAndOverride<boolean | undefined>(ENROL_META, [context.getHandler(), context.getClass()]) === true;
      // A restricted enrol token (identity already has a strong factor) reaches nothing.
      if (!allowed || principal.actor.tokenScopes.includes("seller:enrol_restricted")) throw Problems.forbidden("strong_factor_required");
    }

    if (meta.kind === "self") return true;

    const resolver = this.moduleRef.get<ResourceResolver>(meta.resolver, { strict: false });
    const resource = await resolver.resolve({ id: req.params[meta.idParam], actor: principal.actor });
    const reason = headerValue(req, "x-access-reason");
    const decision = decide(
      {
        actor: principal.actor,
        action: meta.action,
        resourceType: meta.resourceType,
        resource,
        nowMs: this.clock.nowMs(),
        ...(reason !== undefined ? { reason } : {}),
      },
      this.rules,
    );
    try {
      await this.audit.record(decision.audit);
    } catch {
      // An unwritable audit log must not turn a deny into an allow; allow decisions fail closed.
      if (decision.effect === "allow") throw Problems.unavailable("audit_unavailable");
    }
    if (decision.effect === "allow") return true;
    // 404 for not-found and not-owned alike; 401/403 carry no object information.
    throw decision.httpStatus === 404
      ? Problems.notFound()
      : decision.httpStatus === 401
        ? Problems.unauthenticated()
        : new ProblemError(403, "forbidden", "You are not allowed to do this", { code: "forbidden" });
  }
}
