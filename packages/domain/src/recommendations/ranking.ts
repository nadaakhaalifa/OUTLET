import type { Candidate, Rng, ScoredCandidate } from "./types";
import type { UserFeatures } from "./features";

export const MAX_CONSECUTIVE_PER_STORE = 2;
export const EXPLORATION_CAP_PERCENT = 5;
const DAY_MS = 86_400_000;

/** Popularity + freshness only. The non-personalized ranking and the ranker-down fallback. */
export function baselineScore(c: Candidate, nowMs: number): number {
  const ageDays = Math.max(0, (nowMs - c.createdAtMs) / DAY_MS);
  const freshness = 1000 / (1 + ageDays / 7);
  return c.popularity + freshness;
}

/** Rules ranker used as the versioned offline model's stand-in and as its fallback. */
export function personalScore(c: Candidate, f: UserFeatures | null, nowMs: number): number {
  let s = baselineScore(c, nowMs);
  s += c.verifiedDiscountPct * 10 + c.sellerHealth * 2 + c.priceTrust * 2 - c.returnRatePermille;
  if (f !== null) {
    s += (f.categoryAffinity[c.categoryId] ?? 0) * 2 + (f.storeAffinity[c.storeId] ?? 0);
  }
  return s;
}

export function sortByScore(items: readonly ScoredCandidate[]): ScoredCandidate[] {
  return [...items].sort(
    (a, b) => b.score - a.score || (a.candidate.productId < b.candidate.productId ? -1 : a.candidate.productId > b.candidate.productId ? 1 : 0),
  );
}

/**
 * Greedy diversity re-rank: keep score order, but never place a third consecutive item of the same
 * store while another store's item remains. When only one store is left the run is unavoidable.
 */
export function diversify(
  items: readonly ScoredCandidate[],
  maxConsecutive: number = MAX_CONSECUTIVE_PER_STORE,
): ScoredCandidate[] {
  const rest = [...items];
  const out: ScoredCandidate[] = [];
  let runStore: string | null = null;
  let run = 0;
  while (rest.length > 0) {
    let idx = rest.findIndex((x) => !(x.candidate.storeId === runStore && run >= maxConsecutive));
    if (idx === -1) idx = 0;
    const [picked] = rest.splice(idx, 1);
    if (picked === undefined) break;
    run = picked.candidate.storeId === runStore ? run + 1 : 1;
    runStore = picked.candidate.storeId;
    out.push(picked);
  }
  return out;
}

export function maxExplorationSlots(listSize: number, capPercent: number = EXPLORATION_CAP_PERCENT): number {
  return Math.max(0, Math.floor((listSize * capPercent) / 100));
}

export interface ExplorationStats {
  readonly impressions: number;
  readonly clicks: number;
}

/** Gamma(k, 1) for integer k >= 1 as a sum of k exponentials. */
function gammaInt(k: number, rng: Rng): number {
  let s = 0;
  for (let i = 0; i < k; i++) s += -Math.log(1 - rng.next());
  return s;
}

/** Beta(a, b) for integer a, b >= 1. Counts are scaled down to <= 60 to bound the loop. */
export function sampleBeta(a: number, b: number, rng: Rng): number {
  const total = a + b;
  const scale = total > 60 ? 60 / total : 1;
  const aa = Math.max(1, Math.round(a * scale));
  const bb = Math.max(1, Math.round(b * scale));
  const x = gammaInt(aa, rng);
  const y = gammaInt(bb, rng);
  return x / (x + y);
}

/**
 * Thompson sampling over new-seller candidates: sample click-through from Beta(clicks+1,
 * impressions-clicks+1) and take the top `slots`. At most `maxExplorationSlots(listSize)` are
 * returned so exploration never exceeds 5% of impressions.
 */
export function pickExploration(
  pool: readonly Candidate[],
  stats: ReadonlyMap<string, ExplorationStats>,
  listSize: number,
  rng: Rng,
  capPercent: number = EXPLORATION_CAP_PERCENT,
): Candidate[] {
  const slots = Math.min(maxExplorationSlots(listSize, capPercent), pool.length);
  if (slots === 0) return [];
  const drawn = pool
    .filter((c) => c.isNewSeller && c.storeActive && c.inStock)
    .map((c) => {
      const s = stats.get(c.productId) ?? { impressions: 0, clicks: 0 };
      const clicks = Math.max(0, Math.min(s.clicks, s.impressions));
      return { c, theta: sampleBeta(clicks + 1, s.impressions - clicks + 1, rng) };
    })
    .sort((a, b) => b.theta - a.theta || (a.c.productId < b.c.productId ? -1 : 1));
  return drawn.slice(0, slots).map((d) => d.c);
}

/** Spreads exploration items evenly through the list, replacing none: total length grows by their count. */
export function mergeExploration(ranked: readonly ScoredCandidate[], explored: readonly Candidate[]): ScoredCandidate[] {
  const seen = new Set(ranked.map((r) => r.candidate.productId));
  const fresh = explored.filter((c) => !seen.has(c.productId));
  if (fresh.length === 0) return [...ranked];
  const out = [...ranked];
  const step = Math.max(1, Math.floor(out.length / (fresh.length + 1)));
  fresh.forEach((c, i) => {
    const at = Math.min(out.length, (i + 1) * step + i);
    out.splice(at, 0, { candidate: c, score: 0, exploration: true });
  });
  return out;
}

/** mulberry32: small seeded PRNG for tests and replayable exploration. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return {
    next(): number {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}
