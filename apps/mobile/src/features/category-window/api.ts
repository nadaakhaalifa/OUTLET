import type { SearchPort } from "../search/model";
import type { CategoryCounts } from "./model";

/**
 * Category counts from `facet_counts.category_ids` on one `GET /v1/search` (limit 1). Resolves undefined until the server ships
 * facet counts (WP-API) or when it sends none: the window then shows no numbers. Never N calls, never an estimate.
 */
export async function loadCategoryCounts(search: SearchPort, scope: { readonly world?: "local" | "global" | "everything"; readonly storeIds?: readonly string[] }): Promise<CategoryCounts | undefined> {
  try {
    const page = await search.search("", {
      budgetMax: null, mySizeOnly: false, conditions: [], verifiedDiscountOnly: false, installmentsAvailable: false, payableWithCredit: false,
      ...(scope.world !== undefined ? { world: scope.world } : {}),
      ...(scope.storeIds !== undefined && scope.storeIds.length > 0 ? { storeIds: scope.storeIds } : {}),
    }, null);
    return page.facetCounts?.categoryIds;
  } catch {
    return undefined;
  }
}
