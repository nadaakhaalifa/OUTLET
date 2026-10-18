import { disarmMandate, releaseHold, type AutoBuyDeps } from "./shared";

/**
 * Checkout hook: the shopper bought this SKU through the normal flow (mode A deep link or any
 * other way), so the standing rule is closed. A rule whose attempt is mid-charge is left alone:
 * that order IS the auto-buy and is recorded as PURCHASED by the sweep.
 */
export class CloseOnPurchase {
  constructor(private readonly d: AutoBuyDeps) {}

  async execute(userId: string, skuId: string): Promise<number> {
    const now = this.d.clock.nowMs();
    let closed = 0;
    for (const m of await this.d.store.armedForUserSku(userId, skuId)) {
      const holds = await this.d.store.run(async (tx) => {
        const cur = await tx.getMandateForUpdate(m.id);
        if (cur === null || cur.status !== "ARMED") return null;
        const open = await tx.openAttemptsOfMandate(cur.id);
        if (open.some((a) => a.state === "CHARGING" || a.state === "REQUIRES_USER_ACTION" || a.state === "MANUAL_REVIEW")) return null;
        return disarmMandate(tx, cur, "DISARMED", "purchased_via_checkout", "system", now);
      });
      if (holds === null) continue;
      closed += 1;
      for (const k of holds) await releaseHold(this.d, k);
    }
    return closed;
  }
}

/** Card removed or account deleted: every matching rule is cancelled (spec Edge cases). */
export class CancelAllForUser {
  constructor(private readonly d: AutoBuyDeps) {}

  async execute(userId: string, reason: "account_deleted" | "card_removed", tokenRef: string | null = null): Promise<number> {
    const now = this.d.clock.nowMs();
    let closed = 0;
    for (const m of await this.d.store.armedForUser(userId, tokenRef)) {
      const holds = await this.d.store.run(async (tx) => {
        const cur = await tx.getMandateForUpdate(m.id);
        if (cur === null || cur.status !== "ARMED") return null;
        return disarmMandate(tx, cur, "DISARMED", reason, "system", now);
      });
      if (holds === null) continue;
      closed += 1;
      for (const k of holds) await releaseHold(this.d, k);
    }
    return closed;
  }
}
