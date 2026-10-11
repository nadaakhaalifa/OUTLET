import { Inject, Injectable } from "@nestjs/common";
import { decide, type Action, type Actor, type Rule } from "@outlet/policy";
import { Problems, ProblemError } from "../../../platform/problem";
import type { AuditSink, Clock } from "../../../platform/ports";
import { AUDIT_SINK, CLOCK, POLICY_RULES } from "../../../platform/tokens";

/**
 * Chooses the store a collection route (list, create, import) operates on. The store comes only from
 * the actor's own brand grants, never from the body. An optional `X-Store-Id` header selects among
 * several stores the actor staffs; naming a store the actor does not staff is a 403, not a lookup.
 * Each candidate is authorised through the same `decide()` rules the guard uses.
 */
@Injectable()
export class StoreAccess {
  constructor(
    @Inject(POLICY_RULES) private readonly rules: readonly Rule[],
    @Inject(AUDIT_SINK) private readonly audit: AuditSink,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async resolve(actor: Actor, action: Action, header: string | undefined): Promise<string> {
    const staffed = [...new Set(actor.grants.flatMap((g) => (g.kind === "brand" ? [g.storeId] : [])))];
    if (header !== undefined && !staffed.includes(header)) throw Problems.forbidden();
    const candidates = header !== undefined ? [header] : staffed;
    const allowed: string[] = [];
    for (const storeId of candidates) {
      const decision = decide(
        {
          actor,
          action,
          resourceType: "store_product",
          resource: { type: "store_product", id: "collection", storeId, state: "active" },
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
    const only = allowed[0];
    if (allowed.length === 0 || only === undefined) throw Problems.forbidden();
    if (allowed.length > 1) {
      throw new ProblemError(422, "store-selection-required", "Select a store with X-Store-Id", { code: "store_selection_required" });
    }
    return only;
  }
}
