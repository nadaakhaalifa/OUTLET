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
