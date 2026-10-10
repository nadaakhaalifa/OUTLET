import type { ClaimOutcome, ReleaseOutcome, ReleaseReason, SweepResult } from "../domain/core";
import type { ClockPort, InventoryStore } from "../domain/ports";
import { OrderGroupInput } from "./schemas";

export type ClaimResult = ClaimOutcome | { readonly status: "invalid_input" };
export type ReleaseResult = ReleaseOutcome | { readonly status: "invalid_input" };

/**
 * Checkout saga: payment.succeeded. The caller runs this in the same unit of work as its ledger
 * posting where the store adapter supports it; the claim itself is atomic with its outbox row.
 * `unavailable` means a lapsed reservation could not be re-claimed: the saga must refund.
 */
export class ClaimReservation {
  constructor(private readonly store: InventoryStore, private readonly clock: ClockPort) {}

  async execute(raw: unknown): Promise<ClaimResult> {
    const p = OrderGroupInput.safeParse(raw);
    if (!p.success) return { status: "invalid_input" };
    return this.store.claim(p.data.orderGroupId, this.clock.nowMs());
  }
}

/** Saga compensation and explicit cancellation before payment. Idempotent. */
export class ReleaseReservation {
  constructor(private readonly store: InventoryStore, private readonly clock: ClockPort) {}

  async execute(raw: unknown, reason: Exclude<ReleaseReason, "expired">): Promise<ReleaseResult> {
    const p = OrderGroupInput.safeParse(raw);
    if (!p.success) return { status: "invalid_input" };
    return this.store.release(p.data.orderGroupId, reason, this.clock.nowMs());
  }
}

/** Scheduled every 30 s. Returns when one batch is done; the scheduler calls again while `expiredReservations === batch`. */
export class SweepExpiredReservations {
  constructor(private readonly store: InventoryStore, private readonly clock: ClockPort, private readonly batch = 500) {}

  async execute(): Promise<SweepResult> {
    return this.store.sweepExpired(this.clock.nowMs(), this.batch);
  }
}

export class ReplenishPools {
  constructor(private readonly store: InventoryStore, private readonly limit = 200) {}

  async execute(): Promise<number> {
    return this.store.replenishDue(this.limit);
  }
}
