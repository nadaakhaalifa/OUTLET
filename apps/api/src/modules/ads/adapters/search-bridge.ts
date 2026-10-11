import type { SearchPage } from "../../search";
import type { SponsoredSelection } from "../application/selection";

type Hit = SearchPage["hits"][number];

/**
 * Integration with search through its PUBLIC index only (`SearchPage` type): marks the hits that
 * the auction won as `sponsored: true`. Sponsored products that are not already in the organic page
 * are NOT injected (they must pass the same filters, which the search engine already applied).
 *
 * The search module's own cap (at most 2 sponsored in the first 10 global-ranked results) stays
 * authoritative and is applied after this bridge; the number of auction slots is configured at or
 * below that cap so the two rules agree.
 */
export function markSponsored(page: SearchPage, selections: readonly SponsoredSelection[]): SearchPage {
  const won = new Set(selections.map((s) => s.productId));
  const hits: Hit[] = page.hits.map((h) => (won.has(h.productId) ? { ...h, sponsored: true } : h));
  return { ...page, hits };
}

/** Selections whose product is present in the organic page, in auction order. Others never serve. */
export function servableSelections(page: SearchPage, selections: readonly SponsoredSelection[]): readonly SponsoredSelection[] {
  const present = new Set(page.hits.map((h) => h.productId));
  return selections.filter((s) => present.has(s.productId));
}
