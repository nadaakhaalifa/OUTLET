import { feasibilityFor, type CalendarDeps } from "./shared";
import type { Feasibility } from "../domain/bridge";

export interface UnavailableItem {
  readonly itemId: string;
  readonly slot: string;
  readonly reason: "sold_out" | "removed";
}
export interface PriceChange {
  readonly itemId: string;
  readonly fromPiastres: bigint;
  readonly toPiastres: bigint;
}

export type AddGapOutcome =
  | { readonly kind: "not_found" }
  | { readonly kind: "already_added" }
  | { readonly kind: "nothing_available"; readonly unavailable: readonly UnavailableItem[] }
  | { readonly kind: "budget_exceeded"; readonly totalPiastres: bigint; readonly budgetPiastres: bigint; readonly priceChanges: readonly PriceChange[] }
  | {
      readonly kind: "added";
      readonly itemIds: readonly string[];
      readonly unavailable: readonly UnavailableItem[];
      readonly priceChanges: readonly PriceChange[];
      readonly totalPiastres: bigint;
      readonly feasibility: Feasibility;
    };

/**
 * POST /v1/me/calendar/events/{id}/add-gap-to-bag. Runs only on the shopper's tap (LLM06). Every
 * item is re-validated against live price and stock: unavailable items are reported, never dropped
 * silently, and a price rise that breaks the budget blocks the add.
 */
export class AddGapToBag {
  constructor(private readonly d: CalendarDeps) {}

  async execute(input: {
    readonly userId: string;
    readonly eventId: string;
    readonly outfitId: string;
    readonly idempotencyKey: string;
  }): Promise<AddGapOutcome> {
    const d = this.d;
    const s = d.stylist;
    const now = d.clock.nowMs();
    const event = await d.store.getEvent(input.eventId);
    if (event === null || event.userId !== input.userId) return { kind: "not_found" };
    const link = ((await d.store.linksFor([event.id])).get(event.id) ?? []).find((l) => l.outfitId === input.outfitId);
    if (link === undefined) return { kind: "not_found" };
    if (link.status !== "planned") return { kind: "already_added" };
    const outfit = await s.outfits.getOutfit(input.outfitId);
    if (outfit === null || outfit.userId !== input.userId) return { kind: "not_found" };

    const live = await s.live.current(outfit.items.map((i) => i.itemId));
    const unavailable: UnavailableItem[] = [];
    const priceChanges: PriceChange[] = [];
    const keep: { itemId: string; storeId: string; pricePiastres: bigint }[] = [];
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
      keep.push({ itemId: it.itemId, storeId: l.storeId, pricePiastres: l.pricePiastres });
      total += l.pricePiastres;
    }
    if (keep.length === 0) return { kind: "nothing_available", unavailable };
    // The stricter of the budget on the event now and the budget the outfit was built for.
    const budgets = [event.budgetPiastres, outfit.budgetPiastres].filter((b): b is bigint => b !== null);
    const cap = budgets.length === 0 ? null : budgets.reduce((m, b) => (b < m ? b : m));
    if (cap !== null && total > cap) return { kind: "budget_exceeded", totalPiastres: total, budgetPiastres: cap, priceChanges };

    // Claim first (compare-and-set), then write the bag; a failed write releases the claim.
    const claimed = await d.store.transitionLink(event.id, input.outfitId, "planned", "in_bag", now, [
      { type: "calendar.gap_added_to_bag", eventId: event.id, userId: input.userId, outfitId: input.outfitId, itemCount: keep.length },
    ]);
    if (!claimed) return { kind: "already_added" };
    try {
      await s.bag.addLines(input.userId, keep.map((i) => i.itemId), input.idempotencyKey);
    } catch (e) {
      await d.store.transitionLink(event.id, input.outfitId, "in_bag", "planned", d.clock.nowMs(), []);
      throw e;
    }
    try {
      await s.outfits.markAddedToBag(input.outfitId, input.userId, now, [
        { type: "outfit.added_to_bag", outfitId: input.outfitId, userId: input.userId, itemCount: keep.length },
      ]);
    } catch {
      // Bookkeeping on the stylist side only; the bag write already succeeded and is idempotent.
    }
    return {
      kind: "added",
      itemIds: keep.map((i) => i.itemId),
      unavailable,
      priceChanges,
      totalPiastres: total,
      feasibility: await feasibilityFor(d, input.userId, event, keep.map((i) => i.storeId)),
    };
  }
}
