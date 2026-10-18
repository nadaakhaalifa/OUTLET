import { canCancelAttempt, nextAttemptState, type AttemptState } from "../domain/bridge";
import type { AutoBuyDeps } from "./shared";
import { disarmMandate, releaseHold } from "./shared";

export type CancelMandateResult =
  | { readonly kind: "cancelled" }
  | { readonly kind: "already_cancelled" }
  | { readonly kind: "closed"; readonly status: "PURCHASED" | "EXPIRED" }
  | { readonly kind: "not_found" };

export class CancelMandate {
  constructor(private readonly d: AutoBuyDeps) {}

  /** Owner only: a rule that is not the caller's is indistinguishable from a missing one. */
  async execute(userId: string, mandateId: string): Promise<CancelMandateResult> {
    const now = this.d.clock.nowMs();
    const out = await this.d.store.run(async (tx): Promise<{ r: CancelMandateResult; holds: readonly string[] }> => {
      const m = await tx.getOwnedMandateForUpdate(userId, mandateId);
      if (m === null) return { r: { kind: "not_found" }, holds: [] };
      if (m.status === "DISARMED") return { r: { kind: "already_cancelled" }, holds: [] };
      if (m.status !== "ARMED") return { r: { kind: "closed", status: m.status }, holds: [] };
      const holds = await disarmMandate(tx, m, "DISARMED", "user_cancelled", "user", now);
      return { r: { kind: "cancelled" }, holds };
    });
    for (const key of out.holds) await releaseHold(this.d, key);
    return out.r;
  }
}

export type CancelAttemptResult =
  | { readonly kind: "cancelled" }
  | { readonly kind: "already_cancelled" }
  | { readonly kind: "not_cancellable"; readonly state: AttemptState }
  | { readonly kind: "not_found" };

/** The pre-charge cancel. It wins only if it commits before the charge claim moves the attempt to CHARGING. */
export class CancelAttempt {
  constructor(private readonly d: AutoBuyDeps) {}

  async execute(userId: string, attemptId: string): Promise<CancelAttemptResult> {
    const now = this.d.clock.nowMs();
    const out = await this.d.store.run(async (tx): Promise<{ r: CancelAttemptResult; hold: string | null }> => {
      const a = await tx.getOwnedAttemptForUpdate(userId, attemptId);
      if (a === null) return { r: { kind: "not_found" }, hold: null };
      if (a.state === "CANCELLED_BY_USER") return { r: { kind: "already_cancelled" }, hold: null };
      if (!canCancelAttempt(a.state)) return { r: { kind: "not_cancellable", state: a.state }, hold: null };
      await tx.updateAttempt({ ...a, state: nextAttemptState(a.state, "USER_CANCELLED"), updatedAtMs: now });
      await tx.emit([{ type: "auto_buy.cancelled", userId, mandateId: a.mandateId, attemptId: a.id, by: "user" }]);
      return { r: { kind: "cancelled" }, hold: a.id };
    });
    if (out.hold !== null) await releaseHold(this.d, out.hold);
    return out.r;
  }
}
