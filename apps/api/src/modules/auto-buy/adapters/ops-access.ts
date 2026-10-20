import { Inject, Injectable } from "@nestjs/common";
import { decide, type Actor } from "@outlet/policy";
import { Problems } from "../../../platform/problem";
import type { AuditSink, Clock } from "../../../platform/ports";
import { AUDIT_SINK, CLOCK, POLICY_RULES } from "../../../platform/tokens";
import type { Rule } from "@outlet/policy";

/**
 * Gate for the MANUAL_REVIEW ops routes. Order: the policy engine's `admin_console` decision (admin
 * audience, passkey, active actor) is recorded in the audit sink BEFORE anything else; then the live
 * `ops`, `finance` or `super_admin` grant is required (a support or marketing console user is a 403).
 */
@Injectable()
export class AutoBuyOpsAccess {
  constructor(
    @Inject(POLICY_RULES) private readonly rules: readonly Rule[],
    @Inject(AUDIT_SINK) private readonly audit: AuditSink,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async require(actor: Actor): Promise<void> {
    const now = this.clock.nowMs();
    const decision = decide(
      { actor, action: "read", resourceType: "admin_console", resource: { type: "admin_console", id: "collection", state: "active" }, nowMs: now },
      this.rules,
    );
    try {
      await this.audit.record(decision.audit);
    } catch {
      if (decision.effect === "allow") throw Problems.unavailable("audit_unavailable");
    }
    if (decision.effect !== "allow") throw Problems.forbidden();
    const ok = actor.grants.some(
      (g) => g.kind === "admin" && (g.role === "ops" || g.role === "finance" || g.role === "super_admin") && (g.expiresAtMs === undefined || g.expiresAtMs > now),
    );
    if (!ok) throw Problems.forbidden("ops_or_finance_role_required");
  }
}
