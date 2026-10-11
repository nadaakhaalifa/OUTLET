import { cycleFor, evaluateCap, unlockAt, type CapDecision } from "../domain/bridge";
import type { CheckoutCapPort } from "../domain/ports";
import { loadSnapshot, refreshCycle, remainingOf, type BudgetDeps } from "./shared";

/**
 * Checkout cap guard. `authorize` re-checks under the per-user lock and, when allowing, records
 * the order provisionally (key `placed:<orderKey>`) so a concurrent second order sees it. The
 * event log is idempotent: the later `order_group.paid` handler records the same key as a no-op.
 *
 * Failure policy (spec Failure handling): the budget service being down fails OPEN for soft caps
 * and for no cap, and fails CLOSED only for a hard cap that this process has already seen active.
 */
export class CheckoutCapGuard implements CheckoutCapPort {
  private readonly hardActive = new Map<string, number>();

  constructor(private readonly d: BudgetDeps) {}

  async authorize(input: { userId: string; orderKey: string; orderTotal: bigint; softHeldSinceMs: number | null }): Promise<CapDecision> {
    const d = this.d;
    const now = d.clock.nowMs();
    try {
      if (!(await d.flags.capsEnabled()) || !(await d.flags.suiteEnabled())) return { kind: "allow", reason: "cap_off" };
      if (!(await d.consent.isGranted(input.userId))) return { kind: "allow", reason: "cap_off" };
      return await d.store.run(input.userId, async (tx) => {
        const snap = await loadSnapshot(d, tx, now);
        if (snap === null) return { kind: "allow", reason: "cap_off" } as const;
        if (snap.settings.capMode === "hard") this.hardActive.set(input.userId, snap.cycle.endMs);
        else this.hardActive.delete(input.userId);
        // Re-checking the same order must not count its own provisional spend twice.
        const own = snap.events.find((e) => e.key === `placed:${input.orderKey}`);
        const remaining = remainingOf(snap, 0n, false).remaining + (own !== undefined && own.kind === "placed" ? own.amount : 0n);
        const decision = evaluateCap({
          capMode: snap.settings.capMode,
          remaining,
          orderTotal: input.orderTotal,
          nowMs: now,
          cycle: snap.cycle,
          softHeldSinceMs: input.softHeldSinceMs,
          holdUntilMs: snap.holdUntilMs,
        });
        if (decision.kind === "allow" && own === undefined && input.orderTotal > 0n) {
          await tx.insertSpendEvent(
            await d.codec.sealEvent(input.userId, {
              key: `placed:${input.orderKey}`,
              kind: "placed",
              amount: input.orderTotal,
              orderPlacedAtMs: now,
              occurredAtMs: now,
              lines: [],
              verifiedSavings: 0n,
              plusSavings: 0n,
            }),
          );
          await refreshCycle(d, tx, input.userId, snap.settings.payday, now, now);
        }
        return decision;
      });
    } catch {
      const until = this.hardActive.get(input.userId);
      if (until !== undefined && until > now) {
        return { kind: "blocked", reason: "hard_cap", overBy: 0n, unlockAtMs: null, cycleEndMs: until };
      }
      return { kind: "allow", reason: "service_unavailable" };
    }
  }

  async release(userId: string, orderKey: string): Promise<void> {
    const d = this.d;
    const now = d.clock.nowMs();
    await d.store.run(userId, async (tx) => {
      const b = await tx.getBudget();
      if (b === null) return;
      if (await tx.deleteSpendEvent(`placed:${orderKey}`)) await refreshCycle(d, tx, userId, b.payday, now, now);
    });
  }
}

export type CapUnlockResult =
  | { readonly kind: "requested"; readonly unlockAtMs: number }
  | { readonly kind: "already_requested"; readonly unlockAtMs: number }
  | { readonly kind: "not_applicable" }
  | { readonly kind: "consent_required" }
  | { readonly kind: "disabled" };

/** POST /v1/me/budget/cap-unlock: starts the 24 h delay; the notification rides the outbox event. */
export class RequestCapUnlock {
  constructor(private readonly d: BudgetDeps) {}

  async execute(userId: string): Promise<CapUnlockResult> {
    const d = this.d;
    if (!(await d.flags.suiteEnabled()) || !(await d.flags.capsEnabled())) return { kind: "disabled" };
    if (!(await d.consent.isGranted(userId))) return { kind: "consent_required" };
    const now = d.clock.nowMs();
    return d.store.run(userId, async (tx) => {
      const b = await tx.getBudget();
      if (b === null || b.capMode !== "hard") return { kind: "not_applicable" } as const;
      const cycle = cycleFor(b.payday, now);
      if (b.holdUntilMs !== null && b.holdUntilMs >= cycle.startMs) {
        return { kind: "already_requested", unlockAtMs: b.holdUntilMs } as const;
      }
      const at = unlockAt(now);
      await tx.insertUnlockRequest({ id: d.ids.uuidV7(), userId, requestedAtMs: now, unlockAtMs: at });
      await tx.putBudget({ ...b, holdUntilMs: at, updatedAtMs: now });
      await tx.emit([{ type: "budget.cap_unlock_requested", userId, unlockAtMs: at }]);
      return { kind: "requested", unlockAtMs: at } as const;
    });
  }
}
