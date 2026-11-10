/** Data structure only (no ads module). Sponsored items are labelled, capped at 2 in the top 10, and must pass the same filters. */
export const SPONSORED_CAP = 2;
export const SPONSORED_WINDOW = 10;
/** 0-based slots inside the top 10 (3rd and 7th), spread out so they never sit together. */
export const SPONSORED_SLOTS = [2, 6] as const;

export interface Placeable {
  readonly productId: string;
  readonly sponsored: boolean;
}

/** Removes sponsored ids from organic, then inserts at most SPONSORED_CAP of them into the top-10 slots (fewer if the page is short). */
export const placeSponsored = <T extends Placeable>(organic: readonly T[], sponsored: readonly T[]): T[] => {
  const ids = new Set(sponsored.map((s) => s.productId));
  const rest = organic.filter((o) => !ids.has(o.productId));
  const out = [...rest];
  let placed = 0;
  for (const s of sponsored) {
    if (placed >= SPONSORED_CAP) break;
    const slot = SPONSORED_SLOTS[placed] ?? SPONSORED_WINDOW - 1;
    out.splice(Math.min(slot, out.length), 0, { ...s, sponsored: true });
    placed += 1;
  }
  return out;
};
