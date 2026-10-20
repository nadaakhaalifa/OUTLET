import { isEligible, pairCompat } from "./compat";
import type { Candidate, OptimizerConfig, OutfitRequest } from "./types";
import { DEFAULT_OPTIMIZER_CONFIG } from "./types";

export type Violation =
  | "over_budget"
  | "store_cap"
  | "not_in_size"
  | "not_modest"
  | "incompatible_pair"
  | "duplicate_slot"
  | "locked_missing";

/** Independent checker of the hard constraints. Used by tests and by the add-to-bag re-validation. */
export function checkOutfit(
  items: readonly Candidate[],
  req: OutfitRequest,
  cfg: OptimizerConfig = DEFAULT_OPTIMIZER_CONFIG,
): readonly Violation[] {
  const v = new Set<Violation>();
  const total = items.reduce((s, c) => s + c.pricePiastres, 0n);
  if (req.budgetPiastres !== null && total > req.budgetPiastres) v.add("over_budget");
  const stores = new Map<string, number>();
  const slots = new Set<string>();
  for (const c of items) {
    stores.set(c.storeId, (stores.get(c.storeId) ?? 0) + 1);
    if (slots.has(c.slot)) v.add("duplicate_slot");
    slots.add(c.slot);
    if (!c.inSize) v.add("not_in_size");
    if (!isEligible(c, req)) {
      if (req.modest && c.inSize) v.add("not_modest");
    }
  }
  if (!req.scopedToSingleStore) for (const n of stores.values()) if (n > cfg.maxPerStore) v.add("store_cap");
  for (let i = 0; i < items.length; i++) {
    for (let j = 0; j < i; j++) {
      const a = items[i];
      const b = items[j];
      if (a !== undefined && b !== undefined && pairCompat(a, b, req.season) === null) v.add("incompatible_pair");
    }
  }
  for (const l of req.locked) if (!items.some((c) => c.itemId === l.itemId)) v.add("locked_missing");
  return [...v];
}
