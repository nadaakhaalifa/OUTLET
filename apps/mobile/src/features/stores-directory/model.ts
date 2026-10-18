/** Stores directory (route /stores). Pure logic, port and in-memory fake; no UI imports. */
import { FIXTURE_STORES, PortError, type PortFailure, type StoreSummary } from "../worlds/model";

export { PortError, type PortFailure, type StoreSummary };

/** Wire limit for `store_ids` (spec §3/§4, API4); mirrors shop-all. */
export const MAX_SELECTED_STORES = 30;

export type DirectoryWorld = "all" | "local" | "global";
export const DIRECTORY_WORLDS: readonly DirectoryWorld[] = ["all", "local", "global"];

/** Only sorts the app can honour: the wire returns trending order, the rest are applied to the loaded list client-side. */
export type DirectorySort = "trending" | "biggestDiscount" | "newDrops" | "az";
export const DIRECTORY_SORTS: readonly DirectorySort[] = ["trending", "biggestDiscount", "newDrops", "az"];

export interface DirectoryFilter {
  readonly query: string;
  readonly world: DirectoryWorld;
  /** Stores with a verified discount on at least one item (the wire has no separate "verified store" flag). */
  readonly verifiedDeals: boolean;
  readonly liveDrop: boolean;
  readonly myStores: boolean;
  /** Outlet location: one governorate (repo coverage code), optionally narrowed to several areas inside it. */
  readonly governorateId: string | null;
  readonly areaIds: readonly string[];
}

export const EMPTY_DIRECTORY_FILTER: DirectoryFilter = { query: "", world: "all", verifiedDeals: false, liveDrop: false, myStores: false, governorateId: null, areaIds: [] };

/** Where an outlet is, by dataset ids (egypt-areas.ts). Either part may be unknown. */
export interface OutletLocation {
  readonly governorateId: string | null;
  readonly areaId: string | null;
}
export type OutletLocations = Readonly<Record<string, OutletLocation>>;

/** Read-only stores source. No follow/unfollow: the stores port does not support it (docs/plan/api-client-gap.md). */
export interface StoresDirectoryPort {
  listStores(): Promise<readonly StoreSummary[]>;
}

const EASTERN = "٠١٢٣٤٥٦٧٨٩";
const PERSIAN = "۰۱۲۳۴۵۶۷۸۹";

/** Arabic-aware search key: folds alef forms, ya/alef-maqsura, ta-marbuta, strips diacritics and tatweel, maps Eastern digits. */
export function normalizeQuery(input: string): string {
  let out = "";
  for (const ch of input.normalize("NFKC").toLowerCase()) {
    const code = ch.codePointAt(0) ?? 0;
    if ((code >= 0x064b && code <= 0x065f) || code === 0x0670 || code === 0x0640) continue;
    const e = EASTERN.indexOf(ch);
    if (e >= 0) { out += String(e); continue; }
    const p = PERSIAN.indexOf(ch);
    if (p >= 0) { out += String(p); continue; }
    if ("أإآٱ".includes(ch)) out += "ا";
    else if (ch === "ى" || ch === "ئ") out += "ي";
    else if (ch === "ة") out += "ه";
    else out += ch;
  }
  return out.replace(/\s+/g, " ").trim();
}

/**
 * Location rule: areas (multi-select) match exactly those areas; a governorate with no areas matches the whole governorate.
 * An outlet with unknown location never matches an active location filter.
 */
export function matchesLocation(loc: OutletLocation | undefined, f: Pick<DirectoryFilter, "governorateId" | "areaIds">): boolean {
  if (f.areaIds.length > 0) return loc?.areaId !== null && loc?.areaId !== undefined && f.areaIds.includes(loc.areaId) && (f.governorateId === null || loc.governorateId === f.governorateId);
  if (f.governorateId !== null) return loc?.governorateId === f.governorateId;
  return true;
}

export function filterStores(stores: readonly StoreSummary[], f: DirectoryFilter, locations: OutletLocations = {}): readonly StoreSummary[] {
  const q = normalizeQuery(f.query);
  return stores.filter((s) => {
    if (!matchesLocation(locations[s.id], f)) return false;
    if (s.status !== "active") return false;
    if (f.world !== "all" && s.kind !== f.world) return false;
    if (f.verifiedDeals && s.maxVerifiedDiscountPct === null) return false;
    if (f.liveDrop && !s.liveDrop) return false;
    if (f.myStores && !s.isFavourite) return false;
    return q.length === 0 || normalizeQuery(s.name).includes(q);
  });
}

function nullsLast(a: number | null, b: number | null, dir: 1 | -1): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return (a - b) * dir;
}

export function sortStores(stores: readonly StoreSummary[], sort: DirectorySort): readonly StoreSummary[] {
  const byName = (a: StoreSummary, b: StoreSummary) => normalizeQuery(a.name).localeCompare(normalizeQuery(b.name)) || a.id.localeCompare(b.id);
  const cmp = (a: StoreSummary, b: StoreSummary): number => {
    let r = 0;
    if (sort === "trending") r = a.trendingRank - b.trendingRank;
    else if (sort === "biggestDiscount") r = nullsLast(a.maxVerifiedDiscountPct, b.maxVerifiedDiscountPct, -1);
    else if (sort === "newDrops") r = nullsLast(a.newestDropAtMs, b.newestDropAtMs, -1);
    return r !== 0 ? r : byName(a, b);
  };
  return [...stores].sort(cmp);
}

/** True when a sort key has no real data in the loaded list (so the sheet can say it follows the server order). */
export function sortHasNoData(stores: readonly StoreSummary[], sort: DirectorySort): boolean {
  if (sort === "biggestDiscount") return stores.every((s) => s.maxVerifiedDiscountPct === null);
  if (sort === "newDrops") return stores.every((s) => s.newestDropAtMs === null);
  return false;
}

/** Location filters only (governorate + each area): what the applied chips show. */
export function locationFilterCount(f: Pick<DirectoryFilter, "governorateId" | "areaIds">): number {
  return (f.governorateId !== null ? 1 : 0) + f.areaIds.length;
}

export function activeFilterCount(f: DirectoryFilter): number {
  return locationFilterCount(f) + (f.world !== "all" ? 1 : 0) + (f.verifiedDeals ? 1 : 0) + (f.liveDrop ? 1 : 0) + (f.myStores ? 1 : 0) + (normalizeQuery(f.query).length > 0 ? 1 : 0);
}

/** CLDR plural bucket for counts (see i18n/plural.ts); suffixes One, Two, Few, Many, Other. */
export { pluralForm } from "../../i18n/plural";

/**
 * Which outlets-mode chrome may render. With no outlet data there is nothing to find, filter or visit, so only the honest
 * empty state shows: no "find your nearest store" hero (CPL 181/2018: no claim without data), no filter button, no location sheet.
 */
export function outletsChrome(outlets: boolean, hasOutletData: boolean): { readonly hero: boolean; readonly filterButton: boolean; readonly locationSheet: boolean } {
  const on = outlets && hasOutletData;
  return { hero: on, filterButton: on, locationSheet: on };
}

/* ---- location counts and selection (real counts from the loaded outlets, never invented) ---- */

export interface LocationCounts {
  readonly governorates: Readonly<Record<string, number>>;
  readonly areas: Readonly<Record<string, number>>;
}

/** Counts outlets per governorate and per area among those that pass every non-location filter. */
export function locationCounts(stores: readonly StoreSummary[], locations: OutletLocations, f: DirectoryFilter): LocationCounts {
  const base = filterStores(stores, { ...f, governorateId: null, areaIds: [] });
  const governorates: Record<string, number> = {};
  const areas: Record<string, number> = {};
  for (const s of base) {
    const loc = locations[s.id];
    if (loc?.governorateId !== null && loc?.governorateId !== undefined) governorates[loc.governorateId] = (governorates[loc.governorateId] ?? 0) + 1;
    if (loc?.areaId !== null && loc?.areaId !== undefined) areas[loc.areaId] = (areas[loc.areaId] ?? 0) + 1;
  }
  return { governorates, areas };
}

export type LocationSelection = Pick<DirectoryFilter, "governorateId" | "areaIds">;

/** Picking another governorate resets areas; picking the same one again keeps them. null = all governorates. */
export function selectGovernorate(sel: LocationSelection, id: string | null): LocationSelection {
  return id === sel.governorateId ? sel : { governorateId: id, areaIds: [] };
}

/** Toggles an area. An area from another governorate switches the governorate and restarts the area list. */
export function toggleArea(sel: LocationSelection, area: { readonly id: string; readonly governorateId: string }): LocationSelection {
  if (sel.governorateId !== area.governorateId) return { governorateId: area.governorateId, areaIds: [area.id] };
  return { governorateId: sel.governorateId, areaIds: sel.areaIds.includes(area.id) ? sel.areaIds.filter((x) => x !== area.id) : [...sel.areaIds, area.id] };
}

/* ---- multi-select ---- */

export type SelectionResult = { readonly ids: readonly string[]; readonly limitHit: boolean };

export function toggleSelection(ids: readonly string[], id: string, max: number = MAX_SELECTED_STORES): SelectionResult {
  if (ids.includes(id)) return { ids: ids.filter((x) => x !== id), limitHit: false };
  if (ids.length >= max) return { ids, limitHit: true };
  return { ids: [...ids, id], limitHit: false };
}

/** Drops ids no longer present in the loaded, active list. */
export function pruneSelected(ids: readonly string[], stores: readonly StoreSummary[]): readonly string[] {
  const known = new Set(stores.filter((s) => s.status === "active").map((s) => s.id));
  return ids.filter((id) => known.has(id));
}

/** Route for the catalogue: nothing selected = everything, one = the store filter, many = the multi-store filter. */
export function shopAllTarget(ids: readonly string[]): { pathname: "/shop-all"; params?: { store?: string; stores?: string } } {
  if (ids.length === 0) return { pathname: "/shop-all" };
  if (ids.length === 1 && ids[0] !== undefined) return { pathname: "/shop-all", params: { store: ids[0] } };
  return { pathname: "/shop-all", params: { stores: ids.join(",") } };
}

/** Parses the `stores` route param: unique, non-empty, capped. */
export function parseStoresParam(raw: string | undefined, max: number = MAX_SELECTED_STORES): readonly string[] {
  if (raw === undefined) return [];
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const id = part.trim();
    if (id.length > 0 && !out.includes(id)) out.push(id);
    if (out.length >= max) break;
  }
  return out;
}

/* ---- in-memory fake (development and tests only; synthetic data) ---- */

export class InMemoryStoresDirectoryPort implements StoresDirectoryPort {
  constructor(private readonly stores: readonly StoreSummary[] = FIXTURE_STORES, private failure: PortFailure | null = null) {}
  setFailure(f: PortFailure | null): void {
    this.failure = f;
  }
  async listStores(): Promise<readonly StoreSummary[]> {
    if (this.failure !== null) throw new PortError(this.failure);
    return this.stores;
  }
}

/* ---- one chooser page -> list ---- */

export type ShopMode = "online" | "inStore";
export type ShopScope = "local" | "global" | "both";
export const SHOP_SCOPES: readonly ShopScope[] = ["local", "global", "both"];

/** Route param for a scope; unknown or missing values mean "no scope chosen yet". */
export function parseScope(raw: string | undefined): ShopScope | null {
  return raw === "local" || raw === "global" || raw === "both" ? raw : null;
}

/** Maps the chosen scope onto the list filter world. */
export function scopeToWorld(scope: ShopScope): DirectoryWorld {
  return scope === "both" ? "all" : scope;
}

/** Where each choice goes. Online buttons carry the scope straight to the list; the in-store choice leads to the physical outlets list. */
export function nextRoute(choice: ShopMode, scope?: ShopScope):
  { pathname: "/stores/outlets" | "/stores/list"; params?: { scope: ShopScope } } {
  if (choice === "inStore") return { pathname: "/stores/outlets" };
  return { pathname: "/stores/list", params: { scope: scope ?? "both" } };
}

/** Whether to show the origin tag on a card: only when both scopes are mixed. */
export function showsOrigin(scope: ShopScope): boolean {
  return scope === "both";
}

/* ---- card view model ---- */

/** Fields the store model does not carry yet. When the data model gains them, pass them here; the card renders them only when non-null. */
export interface StoreCardExtras {
  readonly city?: string | null;
  readonly country?: string | null;
  /** Ready-made, localised "Open - Closes 10 PM" style text from the data source. */
  readonly hoursText?: string | null;
  readonly distanceKm?: number | null;
  readonly openNow?: boolean | null;
  /** Localised closing time, e.g. "10 PM". */
  readonly closesAt?: string | null;
  readonly photoUrl?: string | null;
  /** Dataset ids (egypt-areas.ts). Dev fixtures only until the backend carries outlet location. */
  readonly governorateId?: string | null;
  readonly areaId?: string | null;
}

export interface StoreCardView {
  readonly id: string;
  readonly name: string;
  readonly kind: "local" | "global";
  readonly locationLine: string | null;
  readonly hoursText: string | null;
  readonly distanceKm: number | null;
  readonly openNow: boolean | null;
  readonly closesAt: string | null;
  readonly photoUrl: string | null;
  readonly deliveryDays: number | null;
  readonly verifiedDiscountPct: number | null;
  readonly rating: number | null;
}

export function toCardView(s: StoreSummary, x: StoreCardExtras = {}): StoreCardView {
  const parts = [x.city, x.country].filter((p): p is string => typeof p === "string" && p.length > 0);
  return {
    id: s.id,
    name: s.name,
    kind: s.kind,
    locationLine: parts.length > 0 ? parts.join(", ") : null,
    hoursText: x.hoursText ?? null,
    distanceKm: x.distanceKm ?? null,
    openNow: x.openNow ?? null,
    closesAt: x.closesAt ?? null,
    photoUrl: x.photoUrl ?? null,
    deliveryDays: s.deliveryDays,
    verifiedDiscountPct: s.maxVerifiedDiscountPct,
    rating: s.rating,
  };
}
