import type { Candidate, Coverage, OutfitRequest, Season } from "./types";

/** Canonical colour ids. Neutrals pair with everything. */
const NEUTRALS: ReadonlySet<string> = new Set(["black", "white", "grey", "beige", "navy", "denim", "cream", "brown"]);

/** Hand written harmony pairs (category-template rule layer; unlisted non-neutral pairs clash). */
const HARMONY: readonly (readonly [string, string])[] = [
  ["red", "olive"],
  ["pink", "olive"],
  ["blue", "orange"],
  ["green", "pink"],
  ["yellow", "purple"],
  ["teal", "coral"],
  ["burgundy", "olive"],
  ["mustard", "blue"],
];

const harmonious = (a: string, b: string): boolean =>
  HARMONY.some(([x, y]) => (x === a && y === b) || (x === b && y === a));

/** 0..1000. Best pair of colours across the two items decides. */
export function colourHarmony(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 600;
  let best = 0;
  for (const x of a) {
    for (const y of b) {
      let s: number;
      if (NEUTRALS.has(x) || NEUTRALS.has(y)) s = 1000;
      else if (x === y) s = 800;
      else if (harmonious(x, y)) s = 700;
      else s = 300;
      if (s > best) best = s;
    }
  }
  return best;
}

export function seasonFit(item: readonly Season[], wanted: Season): number {
  if (item.length === 0) return 600;
  return item.includes("all") || item.includes(wanted) || wanted === "all" ? 1000 : 300;
}

/** Cosine similarity mapped to 0..1000, neutral 500 when either side has no embedding or dims differ. */
export function embeddingSimilarity(a: readonly number[] | undefined, b: readonly number[] | undefined): number {
  if (a === undefined || b === undefined || a.length === 0 || a.length !== b.length) return 500;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 500;
  const cos = Math.max(-1, Math.min(1, dot / Math.sqrt(na * nb)));
  return Math.round(((cos + 1) / 2) * 1000);
}

/** Largest formality gap allowed inside one outfit. A gap of 3 or more is a hard rule failure. */
export const MAX_FORMALITY_GAP = 2;

/**
 * Pair compatibility 0..1000 or null when a hard rule forbids the pair. Embedding, colour and season
 * are weighted 4:4:2. Embeddings missing => neutral 500, so category rules alone still order items.
 */
export function pairCompat(a: Candidate, b: Candidate, season: Season): number | null {
  if (Math.abs(a.formality - b.formality) > MAX_FORMALITY_GAP) return null;
  const colour = colourHarmony(a.colors, b.colors);
  const seas = Math.floor((seasonFit(a.seasons, season) + seasonFit(b.seasons, season)) / 2);
  const emb = embeddingSimilarity(a.embedding, b.embedding);
  return Math.floor((colour * 4 + seas * 2 + emb * 4) / 10);
}

const SLEEVE_RANK: Readonly<Record<string, number>> = { none: 0, short: 1, elbow: 2, long: 3 };
const LENGTH_RANK: Readonly<Record<string, number>> = { mini: 0, knee: 1, midi: 2, maxi: 3 };

/**
 * Modest coverage (spec 11 edge case): sleeves reach the elbow, neckline is not low, hemline at
 * least midi. A dimension that does not apply to the garment ("n/a") never fails the check.
 */
export function isModestCompliant(c: Coverage): boolean {
  if (c.sleeve !== "n/a" && (SLEEVE_RANK[c.sleeve] ?? 0) < 2) return false;
  if (c.neckline === "low") return false;
  if (c.length !== "n/a" && (LENGTH_RANK[c.length] ?? 0) < 2) return false;
  return true;
}

/** Candidate generation filter shared by the optimizer, the rules fallback and the validator. */
export function isEligible(c: Candidate, req: Pick<OutfitRequest, "modest">): boolean {
  if (!c.inSize) return false;
  if (c.pricePiastres <= 0n) return false;
  if (req.modest && !isModestCompliant(c.coverage)) return false;
  return true;
}
