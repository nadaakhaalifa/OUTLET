import { expandKeyword, normalizeSearchText, tokenize } from "../domain/bridge";
import type { IndexedProduct, SearchRequest } from "../domain/ports";

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
  if (f.categoryIds !== undefined && !f.categoryIds.some((c) => doc.categoryIds.includes(c))) return false;
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

export const FACET_NOTE = "colors, materials, conditions and category_ids are 'any of' within a facet, AND across facets";
