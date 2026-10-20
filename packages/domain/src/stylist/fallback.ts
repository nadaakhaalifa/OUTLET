import { isEligible, pairCompat } from "./compat";
import { bestPartial, selectDiverse } from "./optimizer";
import { scoreItems, freeDeliveryStores } from "./score";
import { DEFAULT_OPTIMIZER_CONFIG, TEMPLATES, type Candidate, type OptimizerConfig, type OptimizerResult, type Outfit, type OutfitRequest, type Slot } from "./types";

const cmpPrice = (a: Candidate, b: Candidate): number =>
  a.pricePiastres < b.pricePiastres ? -1 : a.pricePiastres > b.pricePiastres ? 1 : a.itemId < b.itemId ? -1 : 1;

/**
 * Rule-based fallback (spec 11 failure handling): category template + popularity + colour rules.
 * No embeddings, no style vector, no beam. Used when ML or the LLM is down, a breaker is open, or
 * a kill switch is off. Output is flagged `source: "rules"`. Hard constraints are identical to the
 * optimizer's, so the budget property holds here too.
 */
export function rulesOutfits(
  input: { readonly candidates: readonly Candidate[]; readonly request: OutfitRequest; readonly config?: OptimizerConfig },
): OptimizerResult {
  const cfg = input.config ?? DEFAULT_OPTIMIZER_CONFIG;
  const req: OutfitRequest = { ...input.request, styleVector: null };
  const stripped = input.candidates.map((c) => {
    const { embedding: _e, ...rest } = c;
    void _e;
    return rest as Candidate;
  });
  const pool: Outfit[] = [];
  for (const template of TEMPLATES) {
    if (req.locked.some((l) => !template.includes(l.slot))) continue;
    const lockedSlots = new Set(req.locked.map((l) => l.slot));
    const slots = template.filter((s) => !lockedSlots.has(s));
    const byslot = new Map<Slot, Candidate[]>();
    let ok = true;
    for (const s of slots) {
      const list = stripped
        .filter((c) => c.slot === s && isEligible(c, req))
        .sort((a, b) => b.popularity - a.popularity || cmpPrice(a, b));
      if (list.length === 0) ok = false;
      byslot.set(s, list);
    }
    if (!ok) continue;
    // Rotate the scan start of every slot by a different stride so variants differ in >= 2 slots.
    for (let variant = 0; variant < 8; variant++) {
      const chosen: Candidate[] = [...req.locked];
      let total = chosen.reduce((s, c) => s + c.pricePiastres, 0n);
      const stores = new Map<string, number>();
      for (const c of chosen) stores.set(c.storeId, (stores.get(c.storeId) ?? 0) + 1);
      let feasible = true;
      for (const [idx, s] of slots.entries()) {
        const list = byslot.get(s) ?? [];
        const off = list.length === 0 ? 0 : (variant * (idx + 1)) % list.length;
        const ordered = [...list.slice(off), ...list.slice(0, off)];
        let pick: Candidate | null = null;
        // Cheapest completion of the slots after this one, to keep the budget feasible.
        const restMin = slots.slice(idx + 1).reduce((acc, r) => {
          const m = (byslot.get(r) ?? []).slice().sort(cmpPrice)[0];
          return acc + (m?.pricePiastres ?? 0n);
        }, 0n);
        for (const c of ordered) {
          if (req.budgetPiastres !== null && total + c.pricePiastres + restMin > req.budgetPiastres) continue;
          if (!req.scopedToSingleStore && (stores.get(c.storeId) ?? 0) >= cfg.maxPerStore) continue;
          if (chosen.some((o) => pairCompat(c, o, req.season) === null)) continue;
          pick = c;
          break;
        }
        if (pick === null) {
          feasible = false;
          break;
        }
        chosen.push(pick);
        total += pick.pricePiastres;
        stores.set(pick.storeId, (stores.get(pick.storeId) ?? 0) + 1);
      }
      if (!feasible || chosen.length !== template.length) continue;
      pool.push({
        items: chosen,
        totalPiastres: total,
        score: scoreItems(chosen, req),
        complete: true,
        missing: [],
        source: "rules",
        freeDeliveryStoreIds: freeDeliveryStores(chosen, req.freeDeliveryThresholdPiastres),
      });
    }
  }
  const key = (o: Outfit): string => o.items.map((i) => i.itemId).join("|");
  pool.sort((a, b) => b.score - a.score || (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  let outfits = selectDiverse(pool, cfg);
  if (outfits.length === 0) {
    const p = bestPartial({ candidates: stripped, request: req, config: cfg }, cfg, "rules");
    outfits = p === null ? [] : [p];
  }
  return { outfits, timedOut: false, explored: pool.length, source: "rules" };
}
