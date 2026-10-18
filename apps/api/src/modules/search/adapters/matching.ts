import { departmentMatches, expandKeyword, normalizeSearchText, tokenize } from "../domain/bridge";
import type { FacetBucket, FacetCountFacet, IndexedProduct, SearchRequest, SearchSort } from "../domain/ports";

const FOURTEEN_DAYS_MS = 14 * 86_400_000;

/** One OR-group of normalized index-side forms per keyword. AND across groups. */
export function termGroups(keywords: string): string[][] {
  return tokenize(normalizeSearchText(keywords))
    .map((t) => expandKeyword(t).filter((f) => /^[\p{L}\p{N}]+$/u.test(f)))
    .filter((g) => g.length > 0);
}

/** Reference semantics for the engine filters; the SQL adapter must agree with this function. */
export function docMatches(doc: IndexedProduct, req: SearchRequest): boolean {
  const f = req.filter;
  if (!doc.inStock) return false;
  if (req.storeScope !== null && !req.storeScope.includes(doc.storeId)) return false;
  if (f.storeIds !== undefined && !f.storeIds.includes(doc.storeId)) return false;
  if ((f.world === "local" || f.world === "global") && doc.world !== f.world) return false;
  if (f.priceMin !== undefined && doc.priceAmount < f.priceMin) return false;
  if (f.priceMax !== undefined && doc.priceAmount > f.priceMax) return false;
  if (f.budgetMax !== undefined && doc.priceAmount > f.budgetMax) return false;
  if (f.colors !== undefined && !f.colors.some((c) => doc.colors.includes(c))) return false;
  if (f.materials !== undefined && !f.materials.some((m) => doc.materials.includes(m))) return false;
  if (f.conditions !== undefined && !f.conditions.includes(doc.condition)) return false;
  if (f.departments !== undefined && !departmentMatches(f.departments, doc.department ?? "unisex")) return false;
  if (f.categoryIds !== undefined && !f.categoryIds.some((c) => doc.categoryIds.includes(c))) return false;
  if (f.brandIds !== undefined && !(doc.brandId !== undefined && doc.brandId !== null && f.brandIds.includes(doc.brandId))) return false;
  if (f.verifiedDiscountOnly === true && doc.verifiedDiscountPct === null) return false;
  if (f.minVerifiedDiscountPct !== undefined && (doc.verifiedDiscountPct ?? 0) < f.minVerifiedDiscountPct) return false;
  if (f.lowest30dOnly === true && !doc.lowest30d) return false;
  if (f.newArrivals === true && doc.listedAtMs < req.nowMs - FOURTEEN_DAYS_MS) return false;
  if (f.minRating !== undefined && (doc.rating === null || doc.rating < f.minRating)) return false;
  if (f.freeDeliveryEligible === true && !doc.freeDeliveryEligible) return false;
  const words = tokenize(normalizeSearchText(doc.searchText));
  for (const group of termGroups(req.keywords)) {
    if (!group.some((form) => words.some((w) => w.startsWith(form)))) return false;
  }
  return true;
}

export const FACET_NOTE = "colors, materials, conditions, departments and category_ids are 'any of' within a facet, AND across facets (women/men also match unisex)";

type SortDoc = Pick<IndexedProduct, "priceAmount" | "verifiedDiscountPct" | "listedAtMs" | "productId">;

/** Reference ordering for every engine; the SQL adapter must agree. Verified discounts only; null sorts last. */
export function compareDocs(sort: SearchSort, a: SortDoc, b: SortDoc): number {
  let primary = 0;
  if (sort === "price_asc") primary = a.priceAmount < b.priceAmount ? -1 : a.priceAmount > b.priceAmount ? 1 : 0;
  else if (sort === "price_desc") primary = a.priceAmount > b.priceAmount ? -1 : a.priceAmount < b.priceAmount ? 1 : 0;
  else if (sort === "biggest_verified_discount") primary = (b.verifiedDiscountPct ?? -1) - (a.verifiedDiscountPct ?? -1);
  if (primary !== 0) return primary;
  return b.listedAtMs - a.listedAtMs || (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0);
}

/** Counts by facet over already-matching docs. Pure; shared by the in-memory index and tests. */
export function bucketize(docs: readonly IndexedProduct[], facet: FacetCountFacet, cap: number): FacetBucket[] {
  const counts = new Map<string, number>();
  for (const d of docs) {
    const ids = facet === "stores" ? [d.storeId] : [...new Set(d.categoryIds)];
    for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([id, count]) => ({ id, count }))
    .sort((a, b) => b.count - a.count || (a.id < b.id ? -1 : 1))
    .slice(0, cap);
}
