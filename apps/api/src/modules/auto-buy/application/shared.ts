import type { AttemptRecord, AutoBuyFlagsPort, AutoBuyStore, AutoBuyTx, BudgetGatePort, CardVaultPort, CatalogQuotePort, Clock, DeliverabilityPort, IdPort, InventoryHoldPort, MandateRecord, MemberEligibilityPort, MitCheckoutPort, NoticePort, RiskPort } from "../domain/ports";
import { nextAttemptState, type MandateView } from "../domain/bridge";

export interface AutoBuyDeps {
  readonly store: AutoBuyStore;
  readonly clock: Clock;
  readonly ids: IdPort;
  readonly flags: AutoBuyFlagsPort;
  readonly eligibility: MemberEligibilityPort;
  readonly catalog: CatalogQuotePort;
  readonly deliverability: DeliverabilityPort;
  readonly risk: RiskPort;
  readonly budget: BudgetGatePort;
  readonly vault: CardVaultPort;
  readonly inventory: InventoryHoldPort;
  readonly mit: MitCheckoutPort;
  readonly notices: NoticePort;
}

export const viewOf = (m: MandateRecord, lastAttemptAtMs: number | null, hasOpenAttempt: boolean): MandateView => ({
  status: m.status,
  skuId: m.skuId,
  targetPrice: m.targetPrice,
  maxPrice: m.maxPrice,
  expiresAtMs: m.expiresAtMs,
  lastAttemptAtMs,
  hasOpenAttempt,
});

/** Releases a stock hold. The hold has a TTL, so a failure here is a delay, never a leak. */
export async function releaseHold(d: Pick<AutoBuyDeps, "inventory">, holdKey: string): Promise<void> {
  try {
    await d.inventory.release(holdKey);
  } catch {
    // TTL expiry is the backstop (reservationTtlMs); the sweeper does not retry a release.
  }
}

/**
 * Closes a rule for a non-purchase reason inside the caller's transaction. Open attempts that can
 * still be disarmed are disarmed; an attempt that is already charging or waiting on SCA is left to
 * finish (cancel wins only if it commits before the charge claim). Returns the hold keys to release
 * AFTER the transaction commits.
 */
export async function disarmMandate(
  tx: AutoBuyTx,
  m: MandateRecord,
  status: "DISARMED" | "EXPIRED",
  reason: string,
  by: "user" | "system",
  nowMs: number,
): Promise<readonly string[]> {
  const holds: string[] = [];
  for (const a of await tx.openAttemptsOfMandate(m.id)) {
    if (a.state === "CHARGING" || a.state === "REQUIRES_USER_ACTION" || a.state === "MANUAL_REVIEW") continue;
    const next = nextAttemptState(a.state, "DISARM");
    await tx.updateAttempt({ ...a, state: next, updatedAtMs: nowMs });
    holds.push(a.id);
  }
  await tx.closeMandate(m.id, status, reason, nowMs);
  await tx.emit([{ type: "auto_buy.cancelled", userId: m.userId, mandateId: m.id, attemptId: null, by }]);
  return holds;
}

export const isHeld = (a: AttemptRecord): boolean => a.reservationRef !== null;
