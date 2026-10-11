import { Inject, Injectable } from "@nestjs/common";
import { decide, type Actor, type Rule } from "@outlet/policy";
import { Problems } from "../../../platform/problem";
import type { AuditSink, Clock } from "../../../platform/ports";
import { AUDIT_SINK, CLOCK, POLICY_RULES } from "../../../platform/tokens";

/**
 * Stores the actor may READ orders of, decided by the central policy per store (role and token scope),
 * for collection routes that have no object id. No allowed store is 403 (missing role), never an
 * empty 200 that would hint at tenancy.
 */
@Injectable()
export class OrderStoreAccess {
  constructor(
    @Inject(POLICY_RULES) private readonly rules: readonly Rule[],
    @Inject(AUDIT_SINK) private readonly audit: AuditSink,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async readableStores(actor: Actor): Promise<string[]> {
    const staffed = [...new Set(actor.grants.flatMap((g) => (g.kind === "brand" ? [g.storeId] : [])))];
    const allowed: string[] = [];
    for (const storeId of staffed) {
      const decision = decide(
        {
          actor,
          action: "read",
          resourceType: "store_order",
          resource: { type: "store_order", id: "collection", storeId, state: "active" },
          nowMs: this.clock.nowMs(),
        },
        this.rules,
      );
      try {
        await this.audit.record(decision.audit);
      } catch {
        if (decision.effect === "allow") throw Problems.unavailable("audit_unavailable");
      }
      if (decision.effect === "allow") allowed.push(storeId);
    }
    if (allowed.length === 0) throw Problems.forbidden();
    return allowed;
  }
}
