import type { schemas } from "../../services/api-client";
import { guard, money, pick, toMoney, type AdapterContext } from "../../services/wire";
import type { Condition, FacetCounts, SearchFilter, SearchItem, SearchPage, SearchPort, SuggestionInput } from "./model";

const CONDITION_WIRE: Readonly<Record<Condition, "new_with_tags" | "new_without_tags" | "sample" | "minor_defect">> = {
  newWithTags: "new_with_tags",
  newWithoutTags: "new_without_tags",
  sample: "sample",
  minorDefect: "minor_defect",
};
/** Query-parameter `sort` allow-list of GET /v1/search (relevance is the server default and is not sent). */
export const SORT_WIRE: Readonly<Record<NonNullable<SearchFilter["sort"]>, "price_asc" | "price_desc" | "biggest_verified_discount">> = {
  priceLow: "price_asc", priceHigh: "price_desc", discount: "biggest_verified_discount",
};

export function filterToWire(f: SearchFilter): schemas.SearchFilter {
  return {
    ...(f.budgetMax !== null ? { budget_max: toMoney(f.budgetMax) } : {}),
    ...(f.mySizeOnly ? { my_size_only: true } : {}),
    ...(f.conditions.length > 0 ? { conditions: f.conditions.map((c) => CONDITION_WIRE[c]) } : {}),
    ...(f.verifiedDiscountOnly ? { verified_discount_only: true } : {}),
    ...(f.installmentsAvailable ? { installments_available: true } : {}),
    ...(f.payableWithCredit ? { payable_with_store_credit: true } : {}),
    ...(f.storeIds !== undefined && f.storeIds.length > 0 ? { store_ids: f.storeIds.slice(0, 30) } : {}),
    ...(f.world !== undefined ? { world: f.world } : {}),
    ...(f.categoryIds !== undefined && f.categoryIds.length > 0 ? { category_ids: f.categoryIds.slice(0, 30) } : {}),
    ...(f.priceMin !== undefined ? { price_min: toMoney(f.priceMin) } : {}),
    ...(f.priceMax !== undefined ? { price_max: toMoney(f.priceMax) } : {}),
    ...(f.department !== undefined ? { departments: [f.department] } : {}),
    ...(f.minVerifiedDiscountPct !== undefined && Number.isInteger(f.minVerifiedDiscountPct) && f.minVerifiedDiscountPct >= 5 && f.minVerifiedDiscountPct <= 100 ? { min_verified_discount_pct: f.minVerifiedDiscountPct } : {}),
    ...(f.lowest30dOnly === true ? { lowest_30d_only: true } : {}),
    ...(f.freeDeliveryEligible === true ? { free_delivery_eligible: true } : {}),
    ...(f.newArrivals === true ? { new_arrivals: true } : {}),
  };
}
/** GET /v1/search and /v1/search/suggestions. */
export class ApiSearchPort implements SearchPort {
  constructor(private readonly ctx: AdapterContext) {}

  suggest(query: string): Promise<readonly string[]> {
    return guard(async () => {
      if (query.trim().length === 0) return [];
      const r = await this.suggestWire(query);
      return r.notModified ? [] : r.data.queries;
    });
  }

  suggestGrouped(query: string): Promise<SuggestionInput> {
    return guard(async () => {
      if (query.trim().length === 0) return { queries: [], stores: [], categories: [] };
      const r = await this.suggestWire(query);
      if (r.notModified) return { queries: [], stores: [], categories: [] };
      const loc = this.ctx.locale();
      return {
        queries: r.data.queries,
        stores: r.data.stores.map((s) => ({ id: s.id, name: pick(s.name, loc) })),
        categories: r.data.categories.map((c) => ({ id: c.id, name: pick(c.name, loc) })),
      };
    });
  }

  /** Signed out: the public suggestions route (prefix only, no bearer). */
  private async suggestWire(query: string) {
    const q = { query: { q: query.slice(0, 100) } };
    return (await this.ctx.isGuest?.()) === true ? this.ctx.client.suggestSearchPublic(q) : this.ctx.client.suggestSearch(q);
  }

  private async fetch(query: string, filter: SearchFilter, cursor: string | null, limit: number) {
    const wire = filterToWire(filter);
    const hasFilters = Object.keys(wire).length > 0;
    const args = {
      query: {
        ...(query.length > 0 ? { q: query } : {}),
        ...(hasFilters ? { filters: JSON.stringify(wire) } : {}),
        ...(filter.sort !== undefined ? { sort: SORT_WIRE[filter.sort] } : {}),
        ...(cursor !== null ? { cursor } : {}),
        limit,
      },
    };
    // Signed out: GET /v1/public/search (no bearer, never personalised).
    const r = (await this.ctx.isGuest?.()) === true ? await this.ctx.client.searchPublic(args) : await this.ctx.client.search(args);
    if (r.notModified) throw new Error("unexpected 304");
    return r.data;
  }

  search(query: string, filter: SearchFilter, cursor: string | null): Promise<SearchPage> {
    return guard(async () => {
      const d = await this.fetch(query, filter, cursor, 20);
      const items = d.items.map((p): SearchItem => ({
        id: p.id,
        title: pick(p.title, this.ctx.locale()),
        storeName: pick(p.store.name, this.ctx.locale()),
        price: money(p.price.price),
        verifiedDiscountPct: p.price.badge === "verified_discount" ? (p.price.discount_pct ?? null) : null,
        referencePrice: p.price.badge === "verified_discount" && p.price.reference_price !== null && p.price.reference_price !== undefined ? money(p.price.reference_price) : null,
        sponsored: p.sponsored,
        storeId: p.store.id,
        ...(p.department !== undefined ? { department: p.department } : {}),
      }));
      const facetCounts = readFacetCounts(d.facet_counts);
      return { ...(facetCounts !== undefined ? { facetCounts } : {}), items, total: d.total_estimate ?? items.length, ...(d.total_estimate !== undefined ? { totalEstimate: d.total_estimate } : {}), nextCursor: d.page.next_cursor };
    });
  }

  count(query: string, filter: SearchFilter): Promise<number> {
    return guard(async () => {
      const d = await this.fetch(query, filter, null, 1);
      return d.total_estimate ?? d.items.length;
    });
  }
}

function countMap(buckets: readonly schemas.FacetBucket[]): Readonly<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const b of buckets) out[b.id] = b.count;
  return out;
}

/**
 * Maps the typed `facet_counts` ([{id,count}] lists) to id-to-count records. Absent (degraded, later pages, live-only filters)
 * stays undefined: no numbers, never zeros.
 */
export function readFacetCounts(raw: schemas.FacetCounts | undefined): FacetCounts | undefined {
  if (raw === undefined) return undefined;
  return { categoryIds: countMap(raw.category_ids), storeIds: countMap(raw.store_ids) };
}
