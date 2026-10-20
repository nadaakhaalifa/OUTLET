import { Inject, Injectable } from "@nestjs/common";
import { decide, type Actor, type Rule } from "@outlet/policy";
import { ProblemError, Problems } from "../../../platform/problem";
import type { AuditSink, Clock } from "../../../platform/ports";
import { AUDIT_SINK, CLOCK, POLICY_RULES } from "../../../platform/tokens";
import type { SellerOrderFacts, SellerOrderPort } from "../domain/ports";
import { FULFILLMENT_ORDERS } from "./tokens";

/**
 * Loads a seller order and authorizes the actor to dispatch it, through the same `decide()` rules
 * the guard uses. The store always comes from the loaded order, never from the request body.
 * Unknown and not-owned orders are indistinguishable (404); a missing role is 403.
 */
@Injectable()
export class SellerOrderAccess {
  constructor(
    @Inject(FULFILLMENT_ORDERS) private readonly orders: SellerOrderPort,
    @Inject(POLICY_RULES) private readonly rules: readonly Rule[],
    @Inject(AUDIT_SINK) private readonly audit: AuditSink,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async authorizeDispatch(actor: Actor, sellerOrderId: string): Promise<SellerOrderFacts> {
    const order = await this.orders.find(sellerOrderId);
    const decision = decide(
      {
        actor,
        action: "update",
        resourceType: "store_order",
        resource:
          order === null ? null : { type: "store_order", id: order.id, storeId: order.storeId, state: "active" },
        nowMs: this.clock.nowMs(),
      },
      this.rules,
    );
    try {
      await this.audit.record(decision.audit);
    } catch {
      if (decision.effect === "allow") throw Problems.unavailable("audit_unavailable");
    }
    if (decision.effect === "allow" && order !== null) return order;
    if (decision.effect === "allow") throw Problems.notFound();
    if (decision.httpStatus === 404) throw Problems.notFound();
    if (decision.httpStatus === 401) throw Problems.unauthenticated();
    throw new ProblemError(403, "forbidden", "You are not allowed to do this", { code: "forbidden" });
  }
}
