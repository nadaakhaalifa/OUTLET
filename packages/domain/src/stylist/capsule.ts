import { isEligible, pairCompat } from "./compat";
import { TEMPLATES, type Candidate, type OutfitRequest, type Slot } from "./types";

export interface CapsulePlan {
  readonly items: readonly Candidate[];
  readonly totalPiastres: bigint;
  /** Number of distinct complete outfits the chosen pieces form (capped at maxOutfits). */
  readonly outfitCount: number;
}

/*
 * Options compared: (1) exhaustive subset search is exponential in the catalog; (2) greedy by
 * marginal outfit count per piastre is a standard submodular-coverage heuristic with predictable
 * latency. Greedy is chosen; the property tests check budget, piece count and monotonicity.
 */
const countOutfits = (items: readonly Candidate[], req: OutfitRequest, cap: number): number => {
  const bySlot = new Map<Slot, Candidate[]>();
  for (const c of items) bySlot.set(c.slot, [...(bySlot.get(c.slot) ?? []), c]);
  let total = 0;
  for (const t of TEMPLATES) {
    let combos: Candidate[][] = [[]];
    for (const slot of t) {
      if (slot === "bag" || slot === "accessory") continue; // optional layers do not gate a look
      const opts = bySlot.get(slot) ?? [];
      if (opts.length === 0) {
        combos = [];
        break;
      }
      const next: Candidate[][] = [];
      for (const combo of combos) {
        for (const o of opts) {
          if (combo.every((c) => pairCompat(c, o, req.season) !== null)) next.push([...combo, o]);
          if (next.length >= cap * 4) break;
        }
      }
      combos = next;
    }
    total += combos.length;
    if (total >= cap) return cap;
  }
  return Math.min(total, cap);
};

export function planCapsule(input: {
  readonly candidates: readonly Candidate[];
  readonly request: OutfitRequest;
  readonly pieces: number;
  readonly maxOutfits: number;
}): CapsulePlan {
  const { request: req } = input;
  const pool = input.candidates.filter((c) => isEligible(c, req));
  const chosen: Candidate[] = [];
  let total = 0n;
  let count = 0;
  for (let n = 0; n < input.pieces; n++) {
    let best: { c: Candidate; gain: number; ratio: number } | null = null;
    for (const c of pool) {
      if (chosen.some((x) => x.itemId === c.itemId)) continue;
      if (req.budgetPiastres !== null && total + c.pricePiastres > req.budgetPiastres) continue;
      const after = countOutfits([...chosen, c], req, input.maxOutfits);
      const gain = after - count;
      // Gain per 100 EGP; ties prefer cheaper, then lexicographic id (deterministic).
      const ratio = (gain * 1_000_000) / Number(c.pricePiastres);
      if (
        best === null ||
        ratio > best.ratio ||
        (ratio === best.ratio && (c.pricePiastres < best.c.pricePiastres || (c.pricePiastres === best.c.pricePiastres && c.itemId < best.c.itemId)))
      ) {
        best = { c, gain, ratio };
      }
    }
    if (best === null) break;
    chosen.push(best.c);
    total += best.c.pricePiastres;
    count += best.gain;
    if (count >= input.maxOutfits && n + 1 >= 3) break;
  }
  return { items: chosen, totalPiastres: total, outfitCount: countOutfits(chosen, req, input.maxOutfits) };
}
