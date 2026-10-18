/** Home (spec §3, §13, §16, phase 1 discovery). Pure model, port and in-memory fake; no UI imports. */
import { PortError, type PortFailure, type StoreSummary, type World } from "../worlds/model";
import type { ProductKind } from "../../art/product-shapes";
import type { HeroVariant } from "../../art/art-geometry";
import { mix } from "../../art/palette";
import { brand, radius } from "@outlet/ui-tokens";
import {
  EMPTY_SHOP_FILTERS, MAX_CATEGORY_FILTER, hasBudget, piastresToField, resolveCategoryParam, type CategoryNode, type ShopFilters,
} from "../shop-all/model";

export { PortError };
export type { PortFailure };

export interface HomeProduct {
  readonly id: string;
  readonly title: string;
  readonly storeId: string;
  readonly storeName: string;
  readonly kind: ProductKind;
  readonly price: bigint;
  /** Verified reference price (spec §9). Null = no claim; never seller input. */
  readonly referencePrice: bigint | null;
  readonly verifiedPct: number | null;
  readonly isLaunchPrice: boolean;
  readonly createdAtMs: number;
  /** Real end of the offer on the server schedule; null when the offer has no end. */
  readonly endsAtMs: number | null;
  readonly sponsored: boolean;
}

export interface HeroDrop {
  readonly id: string;
  readonly title: string;
  readonly storeName: string;
  readonly variant: HeroVariant;
  /** A countdown exists only for a drop with a real future start on the server schedule. */
  readonly startsAtMs: number | null;
  readonly live: boolean;
}

export interface HomeData {
  readonly serverNowMs: number;
  readonly hero: HeroDrop | null;
  /** Every real upcoming or live drop from the drops port (superset of `hero`); absent on older adapters. */
  readonly drops?: readonly HeroDrop[];
  readonly products: readonly HomeProduct[];
  /** Product ids the server ranked for this user; null when personalization is off. */
  readonly forYouIds: readonly string[] | null;
}

export interface HomePort {
  load(): Promise<HomeData>;
}

export const RAIL_LIMIT = 8;
export const MIN_VERIFIED_PCT = 5;

/** Same arithmetic as PriceBlock: percent must equal floor((ref-price)*100/ref) and be >= 5. */
export function claimOf(p: Pick<HomeProduct, "price" | "referencePrice" | "verifiedPct">): { referencePrice: bigint; percent: number } | null {
  if (p.referencePrice === null || p.verifiedPct === null) return null;
  if (p.referencePrice <= 0n || p.referencePrice <= p.price) return null;
  if (!Number.isInteger(p.verifiedPct) || p.verifiedPct < MIN_VERIFIED_PCT) return null;
  const expected = ((p.referencePrice - p.price) * 100n) / p.referencePrice;
  return BigInt(p.verifiedPct) === expected ? { referencePrice: p.referencePrice, percent: p.verifiedPct } : null;
}

/** Keeps only products sold by a store of the chosen world (suspended stores are not in `stores`). */
export function scopeProducts(products: readonly HomeProduct[], stores: readonly StoreSummary[], world: World): readonly HomeProduct[] {
  const allowed = new Set(
    stores.filter((s) => s.status === "active" && (world === "everything" || (world === "myStores" ? s.isFavourite : s.kind === world))).map((s) => s.id),
  );
  return products.filter((p) => allowed.has(p.storeId));
}

export function newDrops(products: readonly HomeProduct[]): readonly HomeProduct[] {
  return [...products].sort((a, b) => b.createdAtMs - a.createdAtMs || a.id.localeCompare(b.id)).slice(0, RAIL_LIMIT);
}

/** Only items whose claim verifies; strongest first. */
export function biggestVerifiedDiscounts(products: readonly HomeProduct[]): readonly HomeProduct[] {
  return products
    .map((p) => ({ p, c: claimOf(p) }))
    .filter((x): x is { p: HomeProduct; c: { referencePrice: bigint; percent: number } } => x.c !== null)
    .sort((a, b) => b.c.percent - a.c.percent || a.p.id.localeCompare(b.p.id))
    .slice(0, RAIL_LIMIT)
    .map((x) => x.p);
}

/** Null (rail hidden entirely) when personalization is off or the server ranked nothing in scope. */
export function forYou(products: readonly HomeProduct[], ids: readonly string[] | null): readonly HomeProduct[] | null {
  if (ids === null) return null;
  const byId = new Map(products.map((p) => [p.id, p] as const));
  const out = ids.flatMap((id) => { const p = byId.get(id); return p === undefined ? [] : [p]; }).slice(0, RAIL_LIMIT);
  return out.length > 0 ? out : null;
}

/** Offers still running on SERVER time, soonest end first. */
export function endingSoon(products: readonly HomeProduct[], serverNowMs: number, withinMs = 72 * 3_600_000): readonly HomeProduct[] {
  return products
    .filter((p) => p.endsAtMs !== null && p.endsAtMs > serverNowMs && p.endsAtMs - serverNowMs <= withinMs)
    .sort((a, b) => (a.endsAtMs ?? 0) - (b.endsAtMs ?? 0) || a.id.localeCompare(b.id))
    .slice(0, RAIL_LIMIT);
}

export interface Countdown {
  readonly days: number;
  readonly hours: number;
  readonly minutes: number;
  readonly seconds: number;
}

/**
 * Countdown for the hero. Null unless the drop has a real start still in the future on server time;
 * the server clock offset is fixed when the data arrived, the device clock only advances it.
 */
export function heroCountdown(hero: HeroDrop | null, serverNowMs: number): Countdown | null {
  if (hero === null || hero.startsAtMs === null) return null;
  const total = Math.floor((hero.startsAtMs - serverNowMs) / 1000);
  if (total <= 0) return null;
  return { days: Math.floor(total / 86_400), hours: Math.floor((total % 86_400) / 3600), minutes: Math.floor((total % 3600) / 60), seconds: total % 60 };
}

export interface DropBanner {
  readonly id: string;
  readonly title: string;
  readonly storeName: string;
  readonly variant: HeroDrop["variant"];
  readonly live: boolean;
  /** Present only while the real start is still in the future on server time. */
  readonly countdown: Countdown | null;
}

/**
 * Compact home banner for a real upcoming (or live) drop. Null renders nothing: no drop, or a drop whose
 * start has passed without being live. The countdown comes from server time only.
 */
export function dropBanner(hero: HeroDrop | null, serverNowMs: number): DropBanner | null {
  if (hero === null) return null;
  const countdown = heroCountdown(hero, serverNowMs);
  if (!hero.live && countdown === null) return null;
  return { id: hero.id, title: hero.title, storeName: hero.storeName, variant: hero.variant, live: hero.live, countdown };
}

const KIND_WORDS: ReadonlyArray<readonly [ProductKind, RegExp]> = [
  ["dress", /dress|gown|فستان/i], ["jeans", /jean|denim|trouser|pant|جينز|بنطل/i], ["shorts", /short|شورت/i], ["jacket", /jacket|coat|blazer|جاكيت|بالطو/i],
  ["hoodie", /hoodie|sweat|هودي/i], ["sneaker", /sneaker|trainer|shoe|حذاء|كوتشي/i], ["heel", /heel|pump|كعب/i], ["bag", /bag|tote|clutch|شنطة|حقيبة/i],
  ["cap", /\bcap\b|hat|قبعة|كاب/i], ["belt", /belt|حزام/i], ["scarf", /scarf|shawl|حجاب|وشاح/i], ["watch", /watch|ساعة/i], ["sunglasses", /sunglass|glasses|نظارة/i],
  ["shirt", /shirt|blouse|قميص|بلوزة/i], ["tee", /tee|t-shirt|top|تيشيرت/i],
];

/** Placeholder-art silhouette for a listing until real photos exist (PLACEHOLDER only). */
export function inferKind(title: string): ProductKind {
  for (const [kind, re] of KIND_WORDS) if (re.test(title)) return kind;
  return "tee";
}

export type HomeState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly offline: boolean }
  | { readonly status: "ready"; readonly data: HomeData };

export function homeFailure(e: unknown): HomeState {
  return { status: "error", offline: e instanceof PortError && e.kind === "offline" };
}

export interface HomeView {
  readonly hero: HeroDrop | null;
  readonly newDrops: readonly HomeProduct[];
  readonly verified: readonly HomeProduct[];
  readonly forYou: readonly HomeProduct[] | null;
  readonly endingSoon: readonly HomeProduct[];
  readonly grid: readonly HomeProduct[];
  readonly empty: boolean;
}

export function buildHome(data: HomeData, stores: readonly StoreSummary[], world: World, serverNowMs: number): HomeView {
  const scoped = scopeProducts(data.products, stores, world);
  return {
    hero: data.hero,
    newDrops: newDrops(scoped),
    verified: biggestVerifiedDiscounts(scoped),
    forYou: forYou(scoped, data.forYouIds),
    endingSoon: endingSoon(scoped, serverNowMs),
    grid: scoped,
    empty: scoped.length === 0,
  };
}

/* ---- in-memory fakes (development and tests only; synthetic data) ---- */

const H = 3_600_000;
const NOW = 1_760_000_000_000;

const row = (id: string, title: string, storeId: string, storeName: string, price: bigint, referencePrice: bigint | null, verifiedPct: number | null, ageH: number, endsInH: number | null, launch = false): HomeProduct => ({
  id, title, storeId, storeName, kind: inferKind(title), price, referencePrice, verifiedPct, isLaunchPrice: launch, createdAtMs: NOW - ageH * H, endsAtMs: endsInH === null ? null : NOW + endsInH * H, sponsored: false,
});

export const FIXTURE_HOME_PRODUCTS: readonly HomeProduct[] = [
  row("p1", "White linen dress", "s1", "Cairo Denim", 120_000n, 171_500n, 30, 5, 30),
  row("p2", "Straight jeans", "s1", "Cairo Denim", 119_000n, null, null, 20, null),
  row("p3", "Denim jacket", "s1", "Cairo Denim", 76_000n, 86_400n, 12, 30, 60),
  row("p4", "Running shorts", "s3", "Atlas Sport", 45_000n, 100_000n, 55, 3, 12),
  row("p5", "Court sneaker", "s3", "Atlas Sport", 210_000n, 280_000n, 25, 48, null),
  row("p6", "Oversized hoodie", "s2", "Nile Basics", 95_000n, null, null, 8, null, true),
  row("p7", "Cotton tee", "s2", "Nile Basics", 35_000n, null, null, 70, null, true),
  row("p8", "Leather tote bag", "s3", "Atlas Sport", 180_000n, 240_000n, 25, 90, 200),
  row("p9", "Silk scarf", "s2", "Nile Basics", 52_000n, null, null, 12, null),
  row("p10", "Pleated midi dress", "s1", "Cairo Denim", 150_000n, 214_000n, 29, 2, 40),
];

export const FIXTURE_HOME: HomeData = {
  serverNowMs: NOW,
  hero: { id: "d1", title: "The Eid edit", storeName: "Cairo Denim", variant: "eid", startsAtMs: NOW + 26 * H, live: false },
  drops: [
    { id: "d1", title: "The Eid edit", storeName: "Cairo Denim", variant: "eid", startsAtMs: NOW + 26 * H, live: false },
    { id: "d2", title: "Atlas sample sale", storeName: "Atlas Sport", variant: "sale", startsAtMs: null, live: true },
    { id: "d3", title: "Nile basics restock", storeName: "Nile Basics", variant: "tide", startsAtMs: NOW + 50 * H, live: false },
  ],
  products: FIXTURE_HOME_PRODUCTS,
  forYouIds: ["p10", "p6", "p1", "p5"],
};

export class InMemoryHomePort implements HomePort {
  constructor(private readonly data: HomeData = FIXTURE_HOME, private failure: PortFailure | null = null) {}
  setFailure(f: PortFailure | null): void {
    this.failure = f;
  }
  async load(): Promise<HomeData> {
    if (this.failure !== null) throw new PortError(this.failure);
    return this.data;
  }
}

const COMPLEMENT: Readonly<Record<ProductKind, readonly ProductKind[]>> = {
  dress: ["heel", "bag", "scarf", "sunglasses", "watch"], tee: ["jeans", "shorts", "sneaker", "cap", "bag"], shirt: ["jeans", "belt", "sneaker", "watch"],
  jeans: ["tee", "shirt", "hoodie", "sneaker", "belt"], shorts: ["tee", "hoodie", "sneaker", "cap"], jacket: ["tee", "jeans", "sneaker", "scarf"],
  hoodie: ["jeans", "shorts", "sneaker", "cap"], sneaker: ["tee", "jeans", "shorts", "hoodie"], heel: ["dress", "bag", "scarf"], bag: ["dress", "tee", "jeans", "heel"],
  cap: ["tee", "hoodie", "shorts"], belt: ["jeans", "shirt"], scarf: ["dress", "jacket", "bag"], watch: ["shirt", "dress", "tee"], sunglasses: ["dress", "tee", "shirt"],
};

/** "Complete the look": other categories that pair with this one, at most one per category, never the same item. */
export function completeTheLook(currentId: string, currentKind: ProductKind, products: readonly HomeProduct[], limit = 6): readonly HomeProduct[] {
  const order = COMPLEMENT[currentKind];
  const out: HomeProduct[] = [];
  for (const k of order) {
    const hit = products.find((p) => p.id !== currentId && p.kind === k);
    if (hit !== undefined) out.push(hit);
    if (out.length >= limit) break;
  }
  return out;
}

/* ---- Home layout v2: section order, drops carousel, departments, filter state ---- */

/** Vertical order under the header (owner request). Tests pin this; do not reorder without the owner. */
/** One corner radius for every Home card, tile and button. */
export const HOME_CARD_RADIUS = radius.tile;

export const HOME_SECTION_ORDER = ["offers", "quickActions", "departments", "drops", "rails", "stores"] as const;
export type HomeSectionKey = (typeof HOME_SECTION_ORDER)[number];

/** Upcoming or live drops on SERVER time: live first, then soonest start. Passed-and-not-live drops are dropped. */
export function upcomingDrops(data: Pick<HomeData, "hero" | "drops">, serverNowMs: number): readonly DropBanner[] {
  const source = data.drops ?? (data.hero !== null ? [data.hero] : []);
  const out: DropBanner[] = [];
  const seen = new Set<string>();
  for (const d of source) {
    if (seen.has(d.id)) continue;
    const b = dropBanner(d, serverNowMs);
    if (b === null) continue;
    seen.add(d.id);
    out.push(b);
  }
  const start = (id: string): number => source.find((d) => d.id === id)?.startsAtMs ?? 0;
  return out.sort((a, b) => Number(b.live) - Number(a.live) || start(a.id) - start(b.id) || a.id.localeCompare(b.id));
}

export const DROP_CARD_GAP = 12;
export const DROP_PEEK = 28;

/** Card width leaving a peek of the next card. */
export function dropCardWidth(containerWidth: number, sidePadding = 20): number {
  return Math.max(200, Math.floor(containerWidth - sidePadding - DROP_PEEK - DROP_CARD_GAP));
}

/** Page index from a scroll offset; clamped, never NaN. `rtl` flips the sign of offsets measured from the visual left. */
export function dropPageIndex(offsetX: number, cardWidth: number, count: number, gap: number = DROP_CARD_GAP): number {
  if (count <= 0 || !Number.isFinite(offsetX) || cardWidth <= 0) return 0;
  return Math.min(count - 1, Math.max(0, Math.round(offsetX / (cardWidth + gap))));
}

/** "n / N" indicator (1-based); null with fewer than two cards. */
export function dropIndicator(index: number, count: number): { readonly current: number; readonly total: number } | null {
  if (count < 2) return null;
  return { current: Math.min(count, Math.max(0, index) + 1), total: count };
}

export const DEPARTMENTS = ["women", "men", "kids", "accessories"] as const;
export type Department = (typeof DEPARTMENTS)[number];
export const DEPARTMENT_ART: Readonly<Record<Department, HeroVariant>> = { women: "atelier", men: "tide", kids: "sale", accessories: "plus" };

/** Distinct tonal base per department (art-kit palette). The label sits on a bottom scrim over this base. */
export const DEPARTMENT_TONE: Readonly<Record<Department, string>> = {
  women: brand.sand,
  men: mix(brand.teal, brand.sage, 0.25),
  kids: mix(brand.sand, brand.ink, 0.28),
  accessories: brand.sage,
};
/** Opacity of the ink scrim behind the label; chosen so ivory text clears 4.5:1 on every tone above. */
export const DEPARTMENT_SCRIM_OPACITY = 0.62;

export interface DepartmentTarget {
  /** Shopper department filter (women, men, kids): the backend `department` attribute. */
  readonly department?: "women" | "men" | "kids";
  /** Category slug when the real tree has a matching top-level node (Accessories). */
  readonly category?: string;
  /** Free-text fallback when the tree has no matching category node. */
  readonly q?: string;
}

/**
 * Women, Men and Kids filter by the product `department` attribute. Accessories is a category, not a department:
 * it opens the top-level `accessories` category when the live tree has it, else the text query. Nothing is invented.
 */
export function departmentTarget(tree: readonly CategoryNode[], dept: Department): DepartmentTarget {
  if (dept !== "accessories") return { department: dept };
  const node = tree.find((n) => n.parentId === null && n.slug === "accessories");
  if (node !== undefined && resolveCategoryParam(tree, "accessories") !== null) return { category: node.slug };
  return { q: "accessories" };
}

export type HomeFilterState = ShopFilters;
export const EMPTY_HOME_FILTERS: HomeFilterState = EMPTY_SHOP_FILTERS;

/** Badge count: categories (one per selection), budget (1), non-default world (1). */
export function homeFilterCount(f: ShopFilters, worldIsDefault: boolean): number {
  return f.categoryIds.length + (hasBudget(f.budget) ? 1 : 0) + (worldIsDefault ? 0 : 1);
}

export interface HomeShopParams { category?: string; min?: string; max?: string }

/** Route params for /shop-all (comma-joined category slugs, EGP min/max). Budget is in memory and in this navigation only. */
export function homeFilterParams(f: ShopFilters, tree: readonly CategoryNode[]): HomeShopParams {
  const slugs = f.categoryIds
    .slice(0, MAX_CATEGORY_FILTER)
    .flatMap((id) => { const n = tree.find((x) => x.id === id); return n === undefined ? [] : [n.slug]; });
  return {
    ...(slugs.length > 0 ? { category: slugs.join(",") } : {}),
    ...(f.budget.min !== null ? { min: piastresToField(f.budget.min) } : {}),
    ...(f.budget.max !== null ? { max: piastresToField(f.budget.max) } : {}),
  };
}

/* ---- round-2 item 2/4: department tap, section reasons, section analytics ---- */

export type DepartmentTap =
  | { readonly kind: "window"; readonly node: CategoryNode }
  | { readonly kind: "route"; readonly target: DepartmentTarget };

/**
 * A department that matches a top-level category with children opens the in-place category window; anything else
 * (Women and Men are filters, not nodes; a node without children) goes straight to Shop all.
 */
export function departmentTap(tree: readonly CategoryNode[], dept: Department): DepartmentTap {
  const node = tree.find((n) => n.parentId === null && n.slug === dept);
  if (node !== undefined && tree.some((c) => c.parentId === node.id)) return { kind: "window", node };
  return { kind: "route", target: departmentTarget(tree, dept) };
}

export type HomeReasonSection = "stores" | "all_pieces";

/**
 * One-line honest reason for a Home block: a fact about the data source or order, never popularity.
 * Stores order is "live drops first" (server order after that); All pieces order is unknown on Home, so the generic line is used.
 */
export function homeReasonKey(section: HomeReasonSection, area: string | null): { readonly key: string; readonly vars: Record<string, string> } {
  if (section === "stores") {
    return area !== null && area.length > 0 ? { key: "homeReason.storesNear", vars: { area } } : { key: "homeReason.storesGeneric", vars: {} };
  }
  return { key: "homeReason.allPiecesGeneric", vars: {} };
}

/** Impression is sent once per session per section. Returns true the first time only. */
export function shouldTrackSection(seen: Set<HomeReasonSection>, section: HomeReasonSection): boolean {
  if (seen.has(section)) return false;
  seen.add(section);
  return true;
}

/** Copy keys the quick-action tiles use as their one-line reasons (shared with the section reasons, not duplicated). */
export const QUICK_ACTION_REASON_KEYS: readonly string[] = [homeReasonKey("stores", null).key, homeReasonKey("all_pieces", null).key];
