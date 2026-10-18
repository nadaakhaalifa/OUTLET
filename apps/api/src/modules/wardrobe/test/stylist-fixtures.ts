import type { StylistCandidate } from "../../stylist";

type Slot = StylistCandidate["slot"];

export const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const STORES = [U(9001), U(9002), U(9003)] as const;
export const sku = (n: number): string => U(70_000 + n);

const item = (slot: Slot, n: number, priceEgp: number, over: Partial<StylistCandidate> = {}): StylistCandidate => ({
  itemId: sku(n),
  storeId: STORES[n % 3] as string,
  slot,
  pricePiastres: BigInt(priceEgp) * 100n,
  verifiedDiscountPct: 0,
  colors: ["black"],
  formality: 2,
  seasons: ["all"],
  coverage: { sleeve: "long", neckline: "high", length: "maxi" },
  popularity: 400,
  inSize: true,
  title: `Item ${n}`,
  ...over,
});

/** A catalog with 4 candidates per slot across 3 stores (local copy: modules may not import another module's test files). */
export function catalog(): StylistCandidate[] {
  const out: StylistCandidate[] = [];
  let n = 1;
  for (const slot of ["top", "bottom", "dress", "shoes", "bag", "accessory"] as const) {
    for (let i = 0; i < 4; i++) {
      out.push(item(slot, n, 150 + i * 120, { popularity: 300 + i * 100 }));
      n++;
    }
  }
  return out;
}
