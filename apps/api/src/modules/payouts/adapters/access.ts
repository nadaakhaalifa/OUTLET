import { Inject, Injectable } from "@nestjs/common";
import { decide, type Actor, type ResourceType, type Rule } from "@outlet/policy";
import { Problems } from "../../../platform/problem";
import type { AuditSink, Clock } from "../../../platform/ports";
import { AUDIT_SINK, CLOCK, POLICY_RULES } from "../../../platform/tokens";

async function record(audit: AuditSink, entry: Parameters<AuditSink["record"]>[0], allow: boolean): Promise<void> {
  try {
    await audit.record(entry);
  } catch {
    if (allow) throw Problems.unavailable("audit_unavailable");
  }
}

/**
 * Store ids the actor may READ payouts of, decided by the central policy per store (brand role and
 * token scope), for collection routes that have no object id. None allowed is 403.
 */
@Injectable()
export class PayoutStoreAccess {
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
          resourceType: "store_payout",
          resource: { type: "store_payout", id: "collection", storeId, state: "active" },
          nowMs: this.clock.nowMs(),
        },
        this.rules,
      );
      await record(this.audit, decision.audit, decision.effect === "allow");
      if (decision.effect === "allow") allowed.push(storeId);
    }
    if (allowed.length === 0) throw Problems.forbidden();
    return allowed;
  }
}

/**
 * Finance console gate for collection routes (no object id). Reads follow the central `payout.read`
 * rule (finance, ops; passkey; admin scope). Writes additionally need the finance role itself: the
 * policy engine's dual approval is a live co-signer model, payouts use admin approval RECORDS
 * (ADR-0021 point 7) which the use case checks, so the engine is only asked for the read decision.
 */
@Injectable()
export class FinanceAccess {
  constructor(
    @Inject(POLICY_RULES) private readonly rules: readonly Rule[],
    @Inject(AUDIT_SINK) private readonly audit: AuditSink,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async require(actor: Actor, resourceType: ResourceType = "payout"): Promise<void> {
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
    await record(this.audit, decision.audit, decision.effect === "allow");
    if (decision.effect !== "allow") throw Problems.forbidden();
  }

  /** True when the actor holds a live finance grant (not ops). */
  static isFinance(actor: Actor, nowMs: number): boolean {
    return actor.grants.some(
      (g) => g.kind === "admin" && g.role === "finance" && (g.expiresAtMs === undefined || g.expiresAtMs > nowMs),
    );
  }
}
