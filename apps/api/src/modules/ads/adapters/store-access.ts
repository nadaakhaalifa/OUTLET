import { Inject, Injectable } from "@nestjs/common";
import { decide, type Action, type Actor, type ResourceType, type Rule } from "@outlet/policy";
import { Problems } from "../../../platform/problem";
import type { AuditSink, Clock } from "../../../platform/ports";
import { AUDIT_SINK, CLOCK, POLICY_RULES } from "../../../platform/tokens";

/**
 * Routes that address a store by a body or query value (no object id). The central policy decides
 * per store: a store the actor has no grant on is 404, a missing role on their own store is 403.
 */
@Injectable()
export class AdStoreAccess {
  constructor(
    @Inject(POLICY_RULES) private readonly rules: readonly Rule[],
    @Inject(AUDIT_SINK) private readonly audit: AuditSink,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async require(actor: Actor, storeId: string, action: Action, resourceType: ResourceType): Promise<void> {
    const decision = decide(
      {
        actor,
        action,
        resourceType,
        resource: { type: resourceType, id: storeId, storeId, state: "active" },
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
    throw decision.httpStatus === 401 ? Problems.unauthenticated() : Problems.forbidden();
  }
}
