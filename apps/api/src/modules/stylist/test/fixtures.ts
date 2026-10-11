import type { Slot } from "../domain/bridge";
import type { OutfitRecord, StylistCandidate } from "../domain/ports";

export const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const IDEM = (n: number): string => `0192f3a4-5b6c-7d8e-9f01-${String(n).padStart(12, "0")}`;

export const STORES = [U(9001), U(9002), U(9003)] as const;
export const START_MS = 1_800_000_000_000;

let seq = 0;
export const sku = (n: number): string => U(70_000 + n);

export const item = (slot: Slot, n: number, priceEgp: number, over: Partial<StylistCandidate> = {}): StylistCandidate => ({
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

/** A catalog with 4 candidates per slot across 3 stores, spread over price points. */
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

export const record = (n: number, userId: string, over: Partial<OutfitRecord> = {}): OutfitRecord => ({
  id: U(100 + n),
  generationId: U(200 + Math.floor(n / 10)),
  userId,
  kind: "outfit",
  source: "ml",
  complete: true,
  items: [
    { itemId: sku(1), storeId: STORES[0], slot: "top", pricePiastres: 25_000n, verifiedDiscountPct: 10 },
    { itemId: sku(2), storeId: STORES[1], slot: "shoes", pricePiastres: 40_000n, verifiedDiscountPct: 0 },
  ],
  missing: [],
  score: 1234,
  totalPiastres: 65_000n,
  budgetPiastres: 100_000n,
  request: { occasion: "work", season: "all", modest: false, world: "everything", budgetSource: "user" },
  createdAtMs: START_MS + ++seq * 1000,
  addedToBagAtMs: null,
  ...over,
});
