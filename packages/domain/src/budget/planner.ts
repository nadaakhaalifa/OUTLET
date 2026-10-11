import { BUDGET_LIMITS, type Plan, type PlanCycle, type PlanItem, type PlanPriority, type PlannedItem } from "./types";

/**
 * Purchase planner (spec 12: Need > dates > Want > Treat).
 *
 * Options compared:
 *  1. Greedy first-fit in priority order: walk items by (priority, due date, price, id) and place
 *     each in the earliest cycle that still has room. O(n*c), explainable, and a higher
 *     priority item is never pushed later by a lower priority one.
 *  2. Per-cycle 0/1 knapsack on priority weights: packs more value into a cycle but can defer a
 *     Need to fit two Treats, which contradicts "Need first" and is hard to explain to a shopper.
 * Option 1 is chosen. Ties are fully deterministic so a re-plan after a verified price drop only
 * moves items that the drop actually changes.
 */
const RANK: Readonly<Record<PlanPriority, number>> = { need: 0, dated: 1, want: 2, treat: 3 };

const cmp = (a: PlanItem, b: PlanItem): number => {
  if (RANK[a.priority] !== RANK[b.priority]) return RANK[a.priority] - RANK[b.priority];
  const ad = a.dueAtMs ?? Number.POSITIVE_INFINITY;
  const bd = b.dueAtMs ?? Number.POSITIVE_INFINITY;
  if (ad !== bd) return ad < bd ? -1 : 1;
  if (a.price !== b.price) return a.price < b.price ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

export function planPurchases(items: readonly PlanItem[], cycles: readonly PlanCycle[]): Plan {
  const horizon = cycles.slice(0, BUDGET_LIMITS.planHorizonCycles);
  const room = horizon.map((c) => (c.capacity < 0n ? 0n : c.capacity));
  const used = horizon.map(() => 0n);
  const planned: PlannedItem[] = [];
  const unplanned: { id: string; reason: "exceeds_every_cycle" | "no_capacity" }[] = [];
  const maxCapacity = room.reduce((m, r) => (r > m ? r : m), 0n);

  for (const item of [...items].sort(cmp)) {
    if (item.price > maxCapacity) {
      unplanned.push({ id: item.id, reason: "exceeds_every_cycle" });
      continue;
    }
    const idx = room.findIndex((r) => r >= item.price);
    if (idx === -1) {
      unplanned.push({ id: item.id, reason: "no_capacity" });
      continue;
    }
    room[idx] = (room[idx] ?? 0n) - item.price;
    used[idx] = (used[idx] ?? 0n) + item.price;
    const cycle = horizon[idx];
    planned.push({
      id: item.id,
      priority: item.priority,
      price: item.price,
      cycleIndex: idx,
      missesDate: item.dueAtMs !== null && cycle !== undefined && cycle.startMs > item.dueAtMs,
      watchPriceDrop: idx > 0,
    });
  }
  return { planned, unplanned, usedByCycle: used };
}
