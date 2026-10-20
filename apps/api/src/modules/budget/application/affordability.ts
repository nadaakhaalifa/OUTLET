import { planPurchases, cycleFor, installmentsDue, priceCeiling, type AffordabilityContext, type Plan, type PlanCycle } from "../domain/bridge";
import type { AffordabilityFilterPort, WishlistPlanSourcePort } from "../domain/ports";
import { loadSnapshot, remainingOf, type BudgetDeps } from "./shared";

/**
 * Request-time filter (spec 12 isolation). Reads the shopper's own state, derives one integer and
 * returns it. It never writes, never caches and never stores the ceiling: `store.read` is a
 * non-locking read-only transaction. Callers must not persist the value either.
 */
export class AffordabilityFilter implements AffordabilityFilterPort {
  constructor(private readonly d: BudgetDeps) {}

  async priceCeilingFor(userId: string, _context: AffordabilityContext): Promise<bigint | null> {
    const r = await this.detail(userId, false);
    return r.kind === "ok" ? r.ceiling : null;
  }

  /** Owner-facing variant used by GET /v1/me/affordability. */
  async detail(
    userId: string,
    includeBag: boolean,
  ): Promise<
    | { readonly kind: "ok"; readonly ceiling: bigint | null; readonly remaining: bigint; readonly overBy: bigint; readonly bag: bigint }
    | { readonly kind: "none" }
  > {
    const d = this.d;
    try {
      if (!(await d.flags.suiteEnabled())) return { kind: "none" };
      if (!(await d.consent.isGranted(userId))) return { kind: "none" };
      const now = d.clock.nowMs();
      const snap = await d.store.read(userId, (tx) => loadSnapshot(d, tx, now));
      if (snap === null) return { kind: "none" };
      const bag = includeBag ? await d.bag.bagTotal(userId) : 0n;
      const r = remainingOf(snap, bag, includeBag);
      return { kind: "ok", ceiling: priceCeiling(r).ceiling, remaining: r.remainingDisplay, overBy: r.overBy, bag: r.bag };
    } catch {
      // Filter failure must never block browsing: no filter.
      return { kind: "none" };
    }
  }
}

export type PlanResult =
  | { readonly kind: "ok"; readonly plan: Plan; readonly cycles: readonly PlanCycle[] }
  | { readonly kind: "empty" }
  | { readonly kind: "not_found" }
  | { readonly kind: "consent_required" }
  | { readonly kind: "disabled" };

/** POST /v1/me/budget/plan: affordable now vs later. The plan is returned, never stored. */
export class PlanMyPurchases {
  constructor(
    private readonly d: BudgetDeps,
    private readonly wishlists: WishlistPlanSourcePort,
  ) {}

  async execute(userId: string, wishlistId: string | null, horizon: number): Promise<PlanResult> {
    const d = this.d;
    if (!(await d.flags.suiteEnabled())) return { kind: "disabled" };
    if (!(await d.consent.isGranted(userId))) return { kind: "consent_required" };
    const now = d.clock.nowMs();
    const snap = await d.store.read(userId, (tx) => loadSnapshot(d, tx, now));
    if (snap === null) return { kind: "empty" };
    const items = await this.wishlists.planItems(userId, wishlistId);
    if (items === null) return { kind: "not_found" };
    const cycles: PlanCycle[] = [];
    let cycle = snap.cycle;
    for (let i = 0; i < horizon; i++) {
      // current cycle: what is left now; future cycles: the whole budget less instalments due then
      const capacity = i === 0 ? remainingOf(snap, 0n, false).remainingDisplay : snap.settings.amount - installmentsDue(snap.commitments, cycle);
      cycles.push({ index: i, startMs: cycle.startMs, endMs: cycle.endMs, capacity: capacity < 0n ? 0n : capacity });
      cycle = cycleFor(snap.settings.payday, cycle.endMs);
    }
    return { kind: "ok", plan: planPurchases(items, cycles), cycles };
  }
}
