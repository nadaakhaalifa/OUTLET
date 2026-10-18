import { Inject, Injectable } from "@nestjs/common";
import { decide, type Actor, type ResourceType, type Rule } from "@outlet/policy";
import { Problems } from "../../../platform/problem";
import type { AuditSink, Clock } from "../../../platform/ports";
import { AUDIT_SINK, CLOCK, POLICY_RULES } from "../../../platform/tokens";

/**
 * Admin console gate for creator routes (no object id the policy engine can scope). Review actions
 * follow `admin_console.access` (any console role, passkey, admin audience); the payout money
 * routes additionally need the live finance role. Dual approval is a RECORD the use case checks
 * (ADR-0021 point 7), so the engine is only asked for the read decision.
 */
@Injectable()
export class CreatorAdminAccess {
  constructor(
    @Inject(POLICY_RULES) private readonly rules: readonly Rule[],
    @Inject(AUDIT_SINK) private readonly audit: AuditSink,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async require(actor: Actor, resourceType: ResourceType): Promise<void> {
    const decision = decide(
      {
        actor,
        action: "read",
        resourceType,
        resource: { type: resourceType, id: "collection", state: "active" },
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

  /** Trust and safety, ops or support may review applications and take looks down. */
  review(actor: Actor): Promise<void> {
    return this.require(actor, "admin_console");
  }

  /**
   * A-10: the application list carries `user_id` (P2). Trust and safety (or super admin) only; other
   * console roles can still act on an application they were handed by id.
   */
  async trustSafety(actor: Actor): Promise<void> {
    await this.require(actor, "admin_console");
    const now = this.clock.nowMs();
    const ok = actor.grants.some(
      (g) =>
        g.kind === "admin" &&
        (g.role === "trust_safety" || g.role === "super_admin") &&
        (g.expiresAtMs === undefined || g.expiresAtMs > now),
    );
    if (!ok) throw Problems.forbidden("trust_safety_role_required");
  }

  /**
   * Attribution void (A-3, H2): decides the trust-and-safety gate and writes ONE audit row for the
   * decision, allow or deny, BEFORE the caller writes anything. `ruleId` names the action; the target
   * is the opaque order group id (no PII, and the free-text reason is never audited). Fails closed:
   * an audit sink failure refuses the void with 503 on allow; a deny is still a deny.
   */
  async voidAttribution(actor: Actor, orderGroupId: string): Promise<void> {
    const now = this.clock.nowMs();
    const isTs = actor.grants.some(
      (g) =>
        g.kind === "admin" &&
        (g.role === "trust_safety" || g.role === "super_admin") &&
        (g.expiresAtMs === undefined || g.expiresAtMs > now),
    );
    const reason = isTs ? null : "missing_role";
    try {
      await this.audit.record({
        effect: reason === null ? "allow" : "deny",
        actorId: actor.id,
        action: "update",
        resourceType: "admin_console",
        resourceId: orderGroupId,
        ruleId: "creators.attribution.void",
        reason: reason === null ? "allowed" : "missing_role",
        httpStatus: reason === null ? 200 : 403,
        approverIds: [],
        atMs: now,
      });
    } catch {
      if (reason === null) throw Problems.unavailable("audit_unavailable");
    }
    if (reason !== null) throw Problems.forbidden("trust_safety_role_required");
    // The console-level gate (passkey, admin audience) still applies on top of the role.
    await this.require(actor, "admin_console");
  }

  /** Money routes: payout read rule plus the finance role itself (ops may read, not move money). */
  async finance(actor: Actor): Promise<void> {
    await this.require(actor, "payout");
    const now = this.clock.nowMs();
    const isFinance = actor.grants.some(
      (g) => g.kind === "admin" && g.role === "finance" && (g.expiresAtMs === undefined || g.expiresAtMs > now),
    );
    if (!isFinance) throw Problems.forbidden("finance_role_required");
  }
}
