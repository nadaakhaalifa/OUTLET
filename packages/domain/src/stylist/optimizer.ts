import { isEligible, pairCompat } from "./compat";
import { SCORE, freeDeliveryStores, scoreItems, unaryValue } from "./score";
import {
  DEFAULT_OPTIMIZER_CONFIG,
  TEMPLATES,
  type Candidate,
  type Clock,
  type MissingSlot,
  type OptimizerConfig,
  type OptimizerResult,
  type Outfit,
  type OutfitRequest,
  type OutfitSource,
  type Slot,
} from "./types";

/*
 * Options compared (ADR note, spec 11 Rules):
 *   1. Greedy per slot: O(n) and explainable, but locally optimal and blind to pair compatibility.
 *   2. ILP / CP-SAT: exact, but needs a solver dependency and has unpredictable worst-case latency.
 *   3. Beam search width 50 with a knapsack bound: predictable latency, explainable, and exact
 *      whenever the beam is at least as wide as the search space (asserted by the oracle test).
 * Beam search is chosen. The bound prunes (a) states that cannot finish inside the budget and
 * (b) states whose best case cannot beat the current k-th best known complete outfit.
 */

interface State {
  readonly items: readonly Candidate[];
  readonly price: bigint;
  readonly score: number;
  readonly perStore: ReadonlyMap<string, number>;
}

const byItemId = (a: Candidate, b: Candidate): number => (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0);

const keyOf = (items: readonly Candidate[]): string => items.map((i) => i.itemId).join("|");

function compareStates(a: State, b: State): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.price !== b.price) return a.price < b.price ? -1 : 1;
  const ka = keyOf(a.items);
  const kb = keyOf(b.items);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

export interface OptimizeInput {
  readonly candidates: readonly Candidate[];
  readonly request: OutfitRequest;
  readonly config?: OptimizerConfig;
  /** Injected so tests are deterministic; defaults to Date.now. */
  readonly now?: Clock;
}

const capCandidates = (list: readonly Candidate[], req: OutfitRequest, cap: number): Candidate[] => {
  const ranked = [...list].sort((a, b) => unaryValue(b, req) - unaryValue(a, req) || byItemId(a, b));
  const keep = new Map<string, Candidate>();
  for (const c of ranked.slice(0, cap)) keep.set(c.itemId, c);
  // Always keep the cheapest few so a feasible outfit is never pruned away by the value cap.
  const cheap = [...list].sort((a, b) => (a.pricePiastres < b.pricePiastres ? -1 : a.pricePiastres > b.pricePiastres ? 1 : byItemId(a, b)));
  for (const c of cheap.slice(0, 5)) keep.set(c.itemId, c);
  return [...keep.values()].sort((a, b) => unaryValue(b, req) - unaryValue(a, req) || byItemId(a, b));
};

const storeCap = (req: OutfitRequest, cfg: OptimizerConfig): number =>
  req.scopedToSingleStore ? Number.MAX_SAFE_INTEGER : cfg.maxPerStore;

function admit(
  s: State,
  c: Candidate,
  req: OutfitRequest,
  cfg: OptimizerConfig,
  minRest: bigint,
): { readonly state: State } | null {
  const price = s.price + c.pricePiastres;
  if (req.budgetPiastres !== null && price + minRest > req.budgetPiastres) return null;
  if ((s.perStore.get(c.storeId) ?? 0) + 1 > storeCap(req, cfg)) return null;
  let gain = unaryValue(c, req);
  for (const o of s.items) {
    const p = pairCompat(c, o, req.season);
    if (p === null) return null;
    gain += p;
  }
  const perStore = new Map(s.perStore);
  perStore.set(c.storeId, (perStore.get(c.storeId) ?? 0) + 1);
  return { state: { items: [...s.items, c], price, score: s.score + gain, perStore } };
}

function initialState(req: OutfitRequest): State | null {
  let s: State = { items: [], price: 0n, score: 0, perStore: new Map() };
  // Locked items are fixed first. They must satisfy the hard rules like any other item.
  for (const c of req.locked) {
    const price = s.price + c.pricePiastres;
    if (req.budgetPiastres !== null && price > req.budgetPiastres) return null;
    let gain = unaryValue(c, req);
    for (const o of s.items) {
      const p = pairCompat(c, o, req.season);
      if (p === null) return null;
      gain += p;
    }
    const perStore = new Map(s.perStore);
    perStore.set(c.storeId, (perStore.get(c.storeId) ?? 0) + 1);
    s = { items: [...s.items, c], price, score: s.score + gain, perStore };
  }
  return s;
}

const toOutfit = (s: State, req: OutfitRequest, source: OutfitSource): Outfit => {
  const items = [...s.items].sort((a, b) => slotOrder(a.slot) - slotOrder(b.slot) || byItemId(a, b));
  return {
    items,
    totalPiastres: s.price,
    score: scoreItems(items, req),
    complete: true,
    missing: [],
    source,
    freeDeliveryStoreIds: freeDeliveryStores(items, req.freeDeliveryThresholdPiastres),
  };
};

const slotOrder = (s: Slot): number => ["top", "dress", "bottom", "shoes", "bag", "accessory"].indexOf(s);

const slotDifference = (a: Outfit, b: Outfit): number => {
  const slots = new Set<Slot>([...a.items.map((i) => i.slot), ...b.items.map((i) => i.slot)]);
  let d = 0;
  for (const s of slots) {
    const x = a.items.find((i) => i.slot === s)?.itemId;
    const y = b.items.find((i) => i.slot === s)?.itemId;
    if (x !== y) d++;
  }
  return d;
};

/** Greedy completion of a state (used for seeds and for best-so-far on timeout). */
function complete(
  start: State,
  slots: readonly Slot[],
  pools: ReadonlyMap<Slot, readonly Candidate[]>,
  minAfter: readonly bigint[],
  req: OutfitRequest,
  cfg: OptimizerConfig,
  from: number,
): State | null {
  let s = start;
  for (let d = from; d < slots.length; d++) {
    const slot = slots[d];
    if (slot === undefined) return null;
    let placed: State | null = null;
    for (const c of pools.get(slot) ?? []) {
      const r = admit(s, c, req, cfg, minAfter[d + 1] ?? 0n);
      if (r !== null) {
        placed = r.state;
        break;
      }
    }
    if (placed === null) return null;
    s = placed;
  }
  return s;
}

function runTemplate(
  template: readonly Slot[],
  input: OptimizeInput,
  cfg: OptimizerConfig,
  now: Clock,
  deadline: number,
  counters: { explored: number; timedOut: boolean },
): State[] {
  const req = input.request;
  const lockedSlots = new Set(req.locked.map((l) => l.slot));
  if (req.locked.some((l) => !template.includes(l.slot))) return [];
  const slots = template.filter((s) => !lockedSlots.has(s));
  const init = initialState(req);
  if (init === null) return [];
  const lockedIds = new Set(req.locked.map((l) => l.itemId));
  const pools = new Map<Slot, readonly Candidate[]>();
  for (const slot of slots) {
    const base = input.candidates.filter((c) => c.slot === slot && !lockedIds.has(c.itemId) && isEligible(c, req));
    if (base.length === 0) return [];
    pools.set(slot, capCandidates(base, req, cfg.perSlotCap));
  }

  // Knapsack bound inputs: cheapest completion cost after each depth and best-case value per slot.
  const minAfter: bigint[] = new Array<bigint>(slots.length + 1).fill(0n);
  for (let d = slots.length - 1; d >= 0; d--) {
    const pool = pools.get(slots[d] as Slot) ?? [];
    let m: bigint | null = null;
    for (const c of pool) if (m === null || c.pricePiastres < m) m = c.pricePiastres;
    minAfter[d] = (minAfter[d + 1] ?? 0n) + (m ?? 0n);
  }
  const unaryMax = slots.map((slot) => {
    let m = Number.NEGATIVE_INFINITY;
    for (const c of pools.get(slot) ?? []) m = Math.max(m, unaryValue(c, req));
    return m;
  });
  const nFinal = req.locked.length + slots.length;
  const bound = (s: State, depth: number): number => {
    let ub = s.score + SCORE.freeDeliveryBonus * nFinal;
    for (let d = depth; d < slots.length; d++) ub += (unaryMax[d] ?? 0) + 1000 * (req.locked.length + d);
    return ub;
  };
  if (req.budgetPiastres !== null && init.price + (minAfter[0] ?? 0n) > req.budgetPiastres) return [];

  // Seeds: greedy completions from the top first picks give a lower bound for pruning (k-th best).
  const k = cfg.maxOutfits;
  const seeds: State[] = [];
  const firstSlot = slots[0];
  if (firstSlot === undefined) return [init];
  for (const c of (pools.get(firstSlot) ?? []).slice(0, k)) {
    const a = admit(init, c, req, cfg, minAfter[1] ?? 0n);
    if (a === null) continue;
    const done = complete(a.state, slots, pools, minAfter, req, cfg, 1);
    if (done !== null) seeds.push(done);
  }
  const seedScores = seeds.map((s) => scoreItems(s.items, req)).sort((a, b) => b - a);
  const threshold = seedScores.length >= k ? (seedScores[k - 1] as number) : Number.NEGATIVE_INFINITY;

  let beam: State[] = [init];
  for (let d = 0; d < slots.length; d++) {
    const slot = slots[d] as Slot;
    const next: State[] = [];
    for (const s of beam) {
      if (now() > deadline) {
        counters.timedOut = true;
        const finished: State[] = [];
        for (const rest of [...beam].sort(compareStates).slice(0, cfg.beamWidth)) {
          const done = complete(rest, slots, pools, minAfter, req, cfg, d);
          if (done !== null) finished.push(done);
        }
        return [...finished, ...seeds];
      }
      for (const c of pools.get(slot) ?? []) {
        counters.explored++;
        const a = admit(s, c, req, cfg, minAfter[d + 1] ?? 0n);
        if (a === null) continue;
        if (bound(a.state, d + 1) < threshold) continue;
        next.push(a.state);
      }
    }
    next.sort(compareStates);
    beam = next.slice(0, cfg.beamWidth);
    if (beam.length === 0) break;
  }
  return beam.length > 0 && beam[0] !== undefined && beam[0].items.length === nFinal ? [...beam, ...seeds] : seeds;
}

/** Picks up to maxOutfits that differ pairwise in at least minSlotDifference slots. */
export function selectDiverse(pool: readonly Outfit[], cfg: OptimizerConfig): Outfit[] {
  const seen = new Set<string>();
  const chosen: Outfit[] = [];
  for (const o of pool) {
    const k = keyOf(o.items);
    if (seen.has(k)) continue;
    seen.add(k);
    if (chosen.every((c) => slotDifference(c, o) >= cfg.minSlotDifference)) chosen.push(o);
    if (chosen.length >= cfg.maxOutfits) break;
  }
  return chosen;
}

const byOutfitScore = (a: Outfit, b: Outfit): number =>
  b.score - a.score || (a.totalPiastres < b.totalPiastres ? -1 : a.totalPiastres > b.totalPiastres ? 1 : keyOf(a.items) < keyOf(b.items) ? -1 : 1);

/**
 * Best partial outfit when nothing complete is feasible: per slot take the best item, then
 * downgrade to the cheapest item, then drop the dearest slots until the budget holds. Dropped
 * slots are reported with the piastres the shopper must add ("add X EGP for shoes").
 */
export function bestPartial(input: OptimizeInput, cfg: OptimizerConfig, source: OutfitSource): Outfit | null {
  const req = input.request;
  let best: Outfit | null = null;
  for (const template of TEMPLATES) {
    if (req.locked.some((l) => !template.includes(l.slot))) continue;
    const lockedSlots = new Set(req.locked.map((l) => l.slot));
    const missing: MissingSlot[] = [];
    let state = initialState(req);
    if (state === null) continue;
    const slotsLeft = template.filter((s) => !lockedSlots.has(s));
    const cheapest = new Map<Slot, Candidate>();
    const pools = new Map<Slot, Candidate[]>();
    for (const slot of slotsLeft) {
      const pool = input.candidates.filter((c) => c.slot === slot && isEligible(c, req));
      if (pool.length === 0) {
        missing.push({ slot, reason: "no_item_in_size", addPiastres: null });
        continue;
      }
      pools.set(slot, capCandidates(pool, req, cfg.perSlotCap));
      const cheap = [...pool].sort((a, b) => (a.pricePiastres < b.pricePiastres ? -1 : a.pricePiastres > b.pricePiastres ? 1 : byItemId(a, b)))[0];
      if (cheap !== undefined) cheapest.set(slot, cheap);
    }
    // Fill slots cheapest-first so that as many slots as possible fit the budget.
    const order = [...pools.keys()].sort((a, b) => {
      const pa = cheapest.get(a)?.pricePiastres ?? 0n;
      const pb = cheapest.get(b)?.pricePiastres ?? 0n;
      return pa < pb ? -1 : pa > pb ? 1 : 0;
    });
    for (const slot of order) {
      const pool = pools.get(slot) ?? [];
      let placed: State | null = null;
      for (const c of pool) {
        const r = admit(state, c, req, cfg, 0n);
        if (r !== null) {
          placed = r.state;
          break;
        }
      }
      if (placed !== null) state = placed;
      else {
        const cheap = cheapest.get(slot);
        const remaining = req.budgetPiastres === null ? 0n : req.budgetPiastres - state.price;
        const add = cheap === undefined ? 0n : cheap.pricePiastres - remaining;
        missing.push({ slot, reason: "budget", addPiastres: add > 0n ? add : 1n });
      }
    }
    if (state.items.length === 0 || missing.length === 0) continue;
    const items = [...state.items].sort((a, b) => slotOrder(a.slot) - slotOrder(b.slot) || byItemId(a, b));
    const o: Outfit = {
      items,
      totalPiastres: state.price,
      score: scoreItems(items, req),
      complete: false,
      missing,
      source,
      freeDeliveryStoreIds: freeDeliveryStores(items, req.freeDeliveryThresholdPiastres),
    };
    if (best === null || o.items.length > best.items.length || (o.items.length === best.items.length && o.score > best.score)) best = o;
  }
  return best;
}

/** Beam search optimizer. Always returns outfits whose total is within the budget. */
export function optimizeOutfits(input: OptimizeInput): OptimizerResult {
  const cfg = input.config ?? DEFAULT_OPTIMIZER_CONFIG;
  // Domain code is pure: callers inject the clock. Without one the time budget is not enforced
  // (the search is still bounded by beam width and candidate caps), and results stay deterministic.
  const now = input.now ?? ((): number => 0);
  const deadline = now() + cfg.timeBudgetMs;
  const counters = { explored: 0, timedOut: false };
  const pool: Outfit[] = [];
  for (const template of TEMPLATES) {
    for (const s of runTemplate(template, input, cfg, now, deadline, counters)) {
      if (s.items.length !== template.length) continue;
      pool.push(toOutfit(s, input.request, "ml"));
    }
  }
  pool.sort(byOutfitScore);
  let outfits = selectDiverse(pool, cfg);
  if (outfits.length === 0) {
    const partial = bestPartial(input, cfg, "ml");
    outfits = partial === null ? [] : [partial];
  }
  return { outfits, timedOut: counters.timedOut, explored: counters.explored, source: "ml" };
}

