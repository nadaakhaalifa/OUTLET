/** "Choose your world" (spec §3). Pure model, port and in-memory fake; no UI imports. */

export type World = "local" | "global" | "everything" | "myStores";
export const WORLDS: readonly World[] = ["local", "global", "everything", "myStores"];
export const DEFAULT_WORLD: World = "everything";

export type StoreSort = "trending" | "biggestDiscount" | "newDrops" | "fastestDelivery" | "az";
export const STORE_SORTS: readonly StoreSort[] = ["trending", "biggestDiscount", "newDrops", "fastestDelivery", "az"];
export const DEFAULT_SORT: StoreSort = "trending";

export interface StoreSummary {
  readonly id: string;
  readonly name: string;
  readonly kind: "local" | "global";
  readonly status: "active" | "suspended";
  /** Highest VERIFIED discount (spec §9). Null when no evidence: nothing is shown, never a guess. */
  readonly maxVerifiedDiscountPct: number | null;
  readonly rating: number | null;
  readonly followerCount: number;
  readonly liveDrop: boolean;
  /** Server-computed rank, 1 = most trending. */
  readonly trendingRank: number;
  readonly newestDropAtMs: number | null;
  readonly deliveryDays: number | null;
  readonly isFavourite: boolean;
  /** Store verification badge (`verified_badge` on the wire). Absent in fixtures: then no glyph is drawn. */
  readonly verified?: boolean;
}

export type PortFailure = "offline" | "failed";

export class PortError extends Error {
  readonly kind: PortFailure;
  constructor(kind: PortFailure) {
    super(`port ${kind}`);
    this.name = "PortError";
    this.kind = kind;
  }
}

export interface WorldsPort {
  listStores(): Promise<readonly StoreSummary[]>;
}

/** Per-device persisted choice. The app adapter uses SecureStorage; tests use memory. */
export interface WorldPreferencePort {
  load(): Promise<{ world: World; sort: StoreSort } | null>;
  save(pref: { world: World; sort: StoreSort }): Promise<void>;
}

export function parseWorld(v: unknown): World | null {
  return WORLDS.find((w) => w === v) ?? null;
}
export function parseSort(v: unknown): StoreSort | null {
  return STORE_SORTS.find((s) => s === v) ?? null;
}

export function encodePreference(p: { world: World; sort: StoreSort }): string {
  return `${p.world}|${p.sort}`;
}
export function decodePreference(raw: string | null): { world: World; sort: StoreSort } | null {
  if (raw === null) return null;
  const [w, s, extra] = raw.split("|");
  const world = parseWorld(w);
  const sort = parseSort(s);
  return world !== null && sort !== null && extra === undefined ? { world, sort } : null;
}

function nullsLast(a: number | null, b: number | null, dir: 1 | -1): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return (a - b) * dir;
}

export function compareStores(sort: StoreSort): (a: StoreSummary, b: StoreSummary) => number {
  const byName = (a: StoreSummary, b: StoreSummary) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  return (a, b) => {
    let r = 0;
    switch (sort) {
      case "trending":
        r = a.trendingRank - b.trendingRank;
        break;
      case "biggestDiscount":
        r = nullsLast(a.maxVerifiedDiscountPct, b.maxVerifiedDiscountPct, -1);
        break;
      case "newDrops":
        r = nullsLast(a.newestDropAtMs, b.newestDropAtMs, -1);
        break;
      case "fastestDelivery":
        r = nullsLast(a.deliveryDays, b.deliveryDays, 1);
        break;
      case "az":
        r = 0;
        break;
    }
    return r !== 0 ? r : byName(a, b);
  };
}

export type DirectoryEmpty = "noStores" | "noFavourites" | "favouritesHidden" | null;

export interface DirectoryView {
  readonly rows: readonly StoreSummary[];
  /** Favourites hidden because the store is suspended; explained in the UI (spec §3). */
  readonly hiddenFavouriteCount: number;
  readonly empty: DirectoryEmpty;
  /** My Stores empty states offer one tap to widen to Shop Everything. */
  readonly canWiden: boolean;
}

export function buildDirectory(stores: readonly StoreSummary[], world: World, sort: StoreSort): DirectoryView {
  const hiddenFavouriteCount = stores.filter((s) => s.isFavourite && s.status === "suspended").length;
  const active = stores.filter((s) => s.status === "active");
  const scoped = active.filter((s) => {
    switch (world) {
      case "local":
        return s.kind === "local";
      case "global":
        return s.kind === "global";
      case "everything":
        return true;
      case "myStores":
        return s.isFavourite;
    }
  });
  const rows = [...scoped].sort(compareStores(sort));
  let empty: DirectoryEmpty = null;
  if (rows.length === 0) {
    if (world === "myStores") empty = hiddenFavouriteCount > 0 ? "favouritesHidden" : "noFavourites";
    else empty = "noStores";
  }
  return {
    rows,
    hiddenFavouriteCount: world === "myStores" ? hiddenFavouriteCount : 0,
    empty,
    canWiden: world === "myStores" && rows.length === 0,
  };
}

/** Local world CTA "Shop all Local stores together" sets the scope to Local-only everything. */
export function worldAfterWiden(): World {
  return "everything";
}

export type WorldsScreenState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly offline: boolean }
  | { readonly status: "ready"; readonly stores: readonly StoreSummary[] };

export function failureState(e: unknown): WorldsScreenState {
  return { status: "error", offline: e instanceof PortError && e.kind === "offline" };
}

/* ---- in-memory fakes (development and tests only; synthetic data) ---- */

export const FIXTURE_STORES: readonly StoreSummary[] = [
  { id: "s1", name: "Cairo Denim", kind: "local", status: "active", maxVerifiedDiscountPct: 40, rating: 4.4, followerCount: 1200, liveDrop: true, trendingRank: 2, newestDropAtMs: 1_760_000_000_000, deliveryDays: 2, isFavourite: true },
  { id: "s2", name: "Nile Basics", kind: "local", status: "active", maxVerifiedDiscountPct: null, rating: null, followerCount: 80, liveDrop: false, trendingRank: 3, newestDropAtMs: null, deliveryDays: 1, isFavourite: false },
  { id: "s3", name: "Atlas Sport", kind: "global", status: "active", maxVerifiedDiscountPct: 55, rating: 4.7, followerCount: 5400, liveDrop: false, trendingRank: 1, newestDropAtMs: 1_759_000_000_000, deliveryDays: 5, isFavourite: true },
  { id: "s4", name: "Delta Dresses", kind: "local", status: "suspended", maxVerifiedDiscountPct: 30, rating: 3.9, followerCount: 300, liveDrop: false, trendingRank: 4, newestDropAtMs: null, deliveryDays: 3, isFavourite: true },
];

export class InMemoryWorldsPort implements WorldsPort {
  constructor(private readonly stores: readonly StoreSummary[] = FIXTURE_STORES, private failure: PortFailure | null = null) {}
  setFailure(f: PortFailure | null): void {
    this.failure = f;
  }
  async listStores(): Promise<readonly StoreSummary[]> {
    if (this.failure !== null) throw new PortError(this.failure);
    return this.stores;
  }
}

export class InMemoryWorldPreference implements WorldPreferencePort {
  private value: { world: World; sort: StoreSort } | null = null;
  async load() {
    return this.value;
  }
  async save(p: { world: World; sort: StoreSort }) {
    this.value = p;
  }
}

/* ---- Explore: editorial category tiles (spec §3) ---- */

export type CategoryId = "dresses" | "tops" | "denim" | "outerwear" | "shoes" | "bags" | "watches" | "eyewear" | "accessories" | "activewear" | "kids" | "modest";

export interface CategoryTile {
  readonly id: CategoryId;
  /** Placeholder-art silhouette (ProductKind) until category photography exists. */
  readonly kind: "dress" | "tee" | "jeans" | "jacket" | "sneaker" | "bag" | "watch" | "sunglasses" | "scarf" | "shorts" | "hoodie" | "shirt";
}

export const CATEGORY_TILES: readonly CategoryTile[] = [
  { id: "dresses", kind: "dress" }, { id: "tops", kind: "tee" }, { id: "denim", kind: "jeans" }, { id: "outerwear", kind: "jacket" },
  { id: "shoes", kind: "sneaker" }, { id: "bags", kind: "bag" }, { id: "watches", kind: "watch" }, { id: "eyewear", kind: "sunglasses" },
  { id: "accessories", kind: "scarf" }, { id: "activewear", kind: "shorts" }, { id: "kids", kind: "hoodie" }, { id: "modest", kind: "shirt" },
];

/** Discover category grid: chunks of `perRow` tiles. A short last row is padded by the screen with spacers (start-aligned). */
export const TILES_PER_ROW = 3;
/** At accessibility text sizes the grid falls back to two per row. */
export const TILES_PER_ROW_LARGE_TEXT = 2;
export function rowsOf<T>(items: readonly T[], perRow: number): readonly (readonly T[])[] {
  const n = Math.max(1, Math.floor(perRow));
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += n) rows.push(items.slice(i, i + n));
  return rows;
}

/** Maps a static tile or department id to a category-tree node by slug (top level first); null when the tree has no such node. */
export function nodeForSlug<N extends { readonly slug: string; readonly parentId: string | null }>(tree: readonly N[], slug: string): N | null {
  return tree.find((n) => n.slug === slug && n.parentId === null) ?? tree.find((n) => n.slug === slug) ?? null;
}

/** Number of stores a sort/scope sheet would show (live count, spec §3). */
export function storeCount(stores: readonly StoreSummary[], world: World): number {
  return buildDirectory(stores, world, "az").rows.length;
}

/* ---- Discover: department avatars and navigation targets ---- */

export type DiscoverDepartmentId = "women" | "men" | "kids" | "lifestyle";

export interface DiscoverDepartment {
  readonly id: DiscoverDepartmentId;
  readonly kind: CategoryTile["kind"];
}

export const DISCOVER_DEPARTMENTS: readonly DiscoverDepartment[] = [
  { id: "women", kind: "dress" }, { id: "men", kind: "shirt" }, { id: "kids", kind: "hoodie" }, { id: "lifestyle", kind: "bag" },
];

/** Women, Men and Kids use the product `department` attribute; Lifestyle is not a department, so it opens a text query. */
export function departmentParams(id: DiscoverDepartmentId, label: string): Readonly<Record<string, string>> {
  return id === "lifestyle" ? { q: label } : { department: id };
}
