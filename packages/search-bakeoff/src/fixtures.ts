import { GROUPS, groupVariants, groupById, type SynonymGroup } from "./lexicon.js";
import { normalizeArabic } from "./normalize.js";
import type { SearchDoc } from "./port.js";

/** mulberry32: small deterministic PRNG so fixtures are reproducible. */
export const makeRng = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const ofKind = (kind: SynonymGroup["kind"]): SynonymGroup[] => GROUPS.filter((g) => g.kind === kind);

/** Titles + all variants of the concepts, normalised. This is the extra indexed field of the shared layer. */
export const buildSearchText = (titleAr: string, titleEn: string, conceptIds: readonly string[]): string => {
  const variants = conceptIds.flatMap((id) => {
    const g = groupById(id);
    return g === undefined ? [] : groupVariants(g);
  });
  return normalizeArabic([titleAr, titleEn, ...variants].join(" "));
};

const PRICE_RANGE: Readonly<Record<string, readonly [number, number]>> = {
  bag: [30000, 600000], watch: [50000, 900000], sunglasses: [30000, 500000], shoes: [40000, 700000],
  sneakers: [60000, 900000], coat: [80000, 1200000], suit: [150000, 1500000],
};
const DEFAULT_RANGE: readonly [number, number] = [10000, 400000];

/** Synthetic catalog for the bake-off ONLY. Never shown to users, never mixed with real listings. */
export const generateFixtures = (count: number, seed = 20261108): SearchDoc[] => {
  const rng = makeRng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)] as T;
  const cats = ofKind("category");
  const colors = ofKind("color");
  const mats = ofKind("material");
  const auds = ofKind("audience");
  const brands = ofKind("brand");
  const tags = [...ofKind("style"), ...ofKind("occasion"), ...ofKind("season")];
  const docs: SearchDoc[] = [];
  for (let i = 0; i < count; i += 1) {
    const cat = pick(cats);
    const color = pick(colors);
    const mat = pick(mats);
    const aud = pick(auds);
    const brand = pick(brands);
    const tag = rng() < 0.45 ? pick(tags) : undefined;
    const titleAr = [cat.ar[0], aud.ar[0], mat.ar[0], color.ar[0], brand.ar[0], tag?.ar[0]].filter(Boolean).join(" ");
    const titleEn = [brand.en[0], color.en[0], mat.en[0], cat.en[0], aud.en[0], tag?.en[0]].filter(Boolean).join(" ");
    const [lo, hi] = PRICE_RANGE[cat.id] ?? DEFAULT_RANGE;
    const priceMinor = Math.round((lo + rng() * (hi - lo)) / 500) * 500;
    docs.push({
      id: `p${String(i + 1).padStart(6, "0")}`,
      titleAr,
      titleEn,
      category: cat.id,
      color: color.id,
      material: mat.id,
      audience: aud.id,
      brand: brand.id,
      priceMinor,
      inStock: rng() > 0.1,
      searchText: buildSearchText(titleAr, titleEn, [cat.id, color.id, mat.id, aud.id, brand.id, ...(tag === undefined ? [] : [tag.id])]),
    });
  }
  return docs;
};
