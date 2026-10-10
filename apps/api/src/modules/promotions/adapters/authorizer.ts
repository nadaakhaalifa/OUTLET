import { Inject, Injectable } from "@nestjs/common";
import { decide, type Action, type Resource, type ResourceType, type Rule } from "@outlet/policy";
import type { ApiRequest } from "../../../platform/http-types";
import type { AuditSink, Clock } from "../../../platform/ports";
import { ProblemError, Problems } from "../../../platform/problem";
import { AUDIT_SINK, CLOCK } from "../../../platform/tokens";

/**
 * Promotion authorization rules (spec 17, data-model API table). They use the central `decide()`
 * and the central rule vocabulary; only the rule data is local because the shared rule set has no
 * promotion resource type yet. NEED (integrator): add a `promotion` ResourceType and move these
 * rules into `createDefaultRules` in packages/policy.
 *
 * Seller: a brand owner or manager of the target store, with the seller read/write token scope.
 * Admin: marketing or ops (super_admin is not enough alone for routine work), passkey, admin access.
 * Platform-wide dual approval above a threshold is NOT modelled here: the threshold is an open
 * business decision (see docs/specs/promotions.md, gaps).
 */
export function promotionRules(): readonly Rule[] {
  return [
    {
      id: "promotions.seller.read",
      resource: "store_settings",
      actions: ["read"],
      grant: { kind: "brand", roles: ["owner", "manager"] },
      scope: "store",
      requiresTokenScope: "seller:read",
    },
    {
      id: "promotions.seller.write",
      resource: "store_settings",
      actions: ["create", "update", "delete"],
      grant: { kind: "brand", roles: ["owner", "manager"] },
      scope: "store",
      requiresTokenScope: "seller:write",
    },
    {
      id: "promotions.admin.manage",
      resource: "admin_console",
      actions: ["read", "create", "update", "delete"],
      grant: { kind: "admin", roles: ["marketing", "ops"] },
      scope: "platform",
      requiresPasskey: true,
      requiresTokenScope: "admin:access",
    },
  ];
}

export interface AuthorizeInput {
  readonly action: Action;
  readonly resourceType: ResourceType;
  /** Null when the object is missing or belongs to a different owner class (answers 404). */
  readonly resource: Resource | null;
}

@Injectable()
export class PromotionAuthorizer {
  private readonly rules = promotionRules();

  constructor(
    @Inject(AUDIT_SINK) private readonly audit: AuditSink,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Throws the problem for a deny. The route must already have authenticated (principal on the request). */
  async authorize(req: ApiRequest, input: AuthorizeInput): Promise<void> {
    const actor = req.principal?.actor ?? null;
    if (actor === null) throw Problems.unauthenticated();
    const decision = decide(
      {
        actor,
        action: input.action,
        resourceType: input.resourceType,
        resource: input.resource,
        nowMs: this.clock.nowMs(),
      },
      this.rules,
    );
    try {
      await this.audit.record(decision.audit);
    } catch {
      if (decision.effect === "allow") throw Problems.unavailable("audit_unavailable");
    }
    if (decision.effect === "allow") return;
    if (decision.httpStatus === 404) throw Problems.notFound();
    if (decision.httpStatus === 401) throw Problems.unauthenticated();
    throw new ProblemError(403, "forbidden", "You are not allowed to do this", { code: "forbidden" });
  }
}
