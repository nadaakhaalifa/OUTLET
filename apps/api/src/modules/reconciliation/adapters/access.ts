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
    const decision = decide(
      {
        actor,
        action: "read",
        resourceType: "payout",
        resource: { type: "payout", id: "reconciliation", state: "active" },
        nowMs: this.clock.nowMs(),
      },
      this.rules,
    );
    try {
      await this.audit.record(decision.audit);
    } catch {
      if (decision.effect === "allow") throw Problems.unavailable("audit_unavailable");
    }
    if (decision.effect !== "allow") throw Problems.forbidden();
  }
}
