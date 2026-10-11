import { checkOutfit, type Candidate } from "../domain/bridge";
import type { OutfitRecord } from "../domain/ports";
import type { StylistDeps } from "./shared";

export interface UnavailableItem {
  readonly itemId: string;
  readonly slot: string;
  readonly reason: "sold_out" | "not_in_size" | "removed";
}
export interface PriceChange {
  readonly itemId: string;
  readonly fromPiastres: bigint;
  readonly toPiastres: bigint;
}

export type AddToBagOutcome =
  | { readonly kind: "not_found" }
  | {
      readonly kind: "added";
      readonly itemIds: readonly string[];
      readonly unavailable: readonly UnavailableItem[];
      readonly priceChanges: readonly PriceChange[];
      readonly totalPiastres: bigint;
    }
  | { readonly kind: "already_added" }
  | { readonly kind: "budget_exceeded"; readonly totalPiastres: bigint; readonly budgetPiastres: bigint; readonly priceChanges: readonly PriceChange[] }
  | { readonly kind: "nothing_available"; readonly unavailable: readonly UnavailableItem[] };

/**
 * POST /v1/stylist/outfits/{id}/add-to-bag. Runs only on a user tap (LLM06). Every item is
 * re-validated against live price and stock: unavailable items are REPORTED, not silently dropped;
 * a price rise that breaks the budget the shopper typed blocks the add and asks again.
 */
export class AddOutfitToBag {
  constructor(private readonly d: StylistDeps, private readonly bag: { addLines(u: string, ids: readonly string[], key: string): Promise<void> }) {}

  async execute(input: { readonly userId: string; readonly outfitId: string; readonly idempotencyKey: string }): Promise<AddToBagOutcome> {
    const d = this.d;
    const outfit = await d.store.getOutfit(input.outfitId);
    if (outfit === null || outfit.userId !== input.userId) return { kind: "not_found" };
    if (outfit.addedToBagAtMs !== null) return { kind: "already_added" };

    const live = await d.live.current(outfit.items.map((i) => i.itemId));
    const unavailable: UnavailableItem[] = [];
    const priceChanges: PriceChange[] = [];
    const keep: OutfitRecord["items"][number][] = [];
    let total = 0n;
    for (const it of outfit.items) {
      const l = live.get(it.itemId);
      if (l === undefined) {
        unavailable.push({ itemId: it.itemId, slot: it.slot, reason: "removed" });
        continue;
      }
      if (!l.inStockInSize) {
        unavailable.push({ itemId: it.itemId, slot: it.slot, reason: "sold_out" });
        continue;
      }
      if (l.pricePiastres !== it.pricePiastres) {
        priceChanges.push({ itemId: it.itemId, fromPiastres: it.pricePiastres, toPiastres: l.pricePiastres });
      }
      keep.push({ ...it, pricePiastres: l.pricePiastres, storeId: l.storeId });
      total += l.pricePiastres;
    }
    if (keep.length === 0) return { kind: "nothing_available", unavailable };
    if (outfit.budgetPiastres !== null && total > outfit.budgetPiastres) {
      return { kind: "budget_exceeded", totalPiastres: total, budgetPiastres: outfit.budgetPiastres, priceChanges };
    }
    // Defence in depth: the re-priced set must still satisfy the hard rules.
    const asCandidates: Candidate[] = keep.map((i) => ({
      itemId: i.itemId,
      storeId: i.storeId,
      slot: i.slot,
      pricePiastres: i.pricePiastres,
      verifiedDiscountPct: i.verifiedDiscountPct,
      colors: [],
      formality: 2,
      seasons: ["all"],
      coverage: { sleeve: "n/a", neckline: "n/a", length: "n/a" },
      popularity: 0,
      inSize: true,
    }));
    const violations = checkOutfit(asCandidates, {
      budgetPiastres: outfit.budgetPiastres,
      occasionFormality: 2,
      season: "all",
      modest: false,
      scopedToSingleStore: outfit.request.world === "my_stores",
      freeDeliveryThresholdPiastres: 0n,
      styleVector: null,
      locked: [],
    });
    if (violations.includes("over_budget")) {
      return { kind: "budget_exceeded", totalPiastres: total, budgetPiastres: outfit.budgetPiastres ?? 0n, priceChanges };
    }

    const marked = await d.store.markAddedToBag(outfit.id, input.userId, d.clock.nowMs(), [
      { type: "outfit.added_to_bag", outfitId: outfit.id, userId: input.userId, itemCount: keep.length },
    ]);
    if (marked === "already") return { kind: "already_added" };
    await this.bag.addLines(input.userId, keep.map((i) => i.itemId), input.idempotencyKey);
    return { kind: "added", itemIds: keep.map((i) => i.itemId), unavailable, priceChanges, totalPiastres: total };
  }
}
