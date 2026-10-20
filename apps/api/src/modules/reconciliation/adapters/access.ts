import { Inject, Injectable } from "@nestjs/common";
import { decide, type Actor, type Rule } from "@outlet/policy";
import { Problems } from "../../../platform/problem";
import type { AuditSink, Clock } from "../../../platform/ports";
import { AUDIT_SINK, CLOCK, POLICY_RULES } from "../../../platform/tokens";

/**
 * Finance console gate for reconciliation reads: the central `payout.read` rule (finance and ops,
 * passkey, admin scope). Reconciliation has no resource type of its own yet (integrator: add one);
 * the decision and its audit record are the policy engine's, nothing is decided here.
 */
@Injectable()
export class ReconAccess {
  constructor(
    @Inject(POLICY_RULES) private readonly rules: readonly Rule[],
    @Inject(AUDIT_SINK) private readonly audit: AuditSink,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async require(actor: Actor): Promise<void> {
    const decision = reconReadDecision(actor, this.rules, this.clock.nowMs());
    try {
      await this.audit.record(decision.audit);
    } catch {
      if (decision.effect === "allow") throw Problems.unavailable("audit_unavailable");
    }
    if (decision.effect !== "allow") throw Problems.forbidden();
  }
}

/** The central policy decision for reading reconciliation (rule `payout.read`). Shared by the gate and the capability map. */
function reconReadDecision(actor: Actor, rules: readonly Rule[], nowMs: number) {
  return decide(
    {
      actor,
      action: "read",
      resourceType: "payout",
      resource: { type: "payout", id: "reconciliation", state: "active" },
      nowMs,
    },
    rules,
  );
}

/** Pure predicate behind `ReconAccess.require` (spec capability `recon.read`). */
export function canReadReconciliation(actor: Actor, rules: readonly Rule[], nowMs: number): boolean {
  return reconReadDecision(actor, rules, nowMs).effect === "allow";
}
