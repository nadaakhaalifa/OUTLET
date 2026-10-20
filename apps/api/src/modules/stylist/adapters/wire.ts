import type { MissingSlot } from "../domain/bridge";
import type { OutfitRecord } from "../domain/ports";
import type { GenerateView } from "../application/generate";

const iso = (ms: number): string => new Date(ms).toISOString();

const missingWire = (m: MissingSlot) => ({
  slot: m.slot,
  reason: m.reason,
  add_piastres: m.addPiastres === null ? null : m.addPiastres.toString(),
});

/** Money is integer piastres as strings. Every payload carries the "AI suggestions" label (LLM09). */
export function outfitWire(o: OutfitRecord) {
  const perStore = new Map<string, bigint>();
  for (const i of o.items) perStore.set(i.storeId, (perStore.get(i.storeId) ?? 0n) + i.pricePiastres);
  return {
    id: o.id,
    kind: o.kind,
    source: o.source,
    complete: o.complete,
    ai_suggestion: true as const,
    currency: "EGP" as const,
    total_piastres: o.totalPiastres.toString(),
    budget_piastres: o.budgetPiastres === null ? null : o.budgetPiastres.toString(),
    items: o.items.map((i) => ({
      item_id: i.itemId,
      store_id: i.storeId,
      slot: i.slot,
      price_piastres: i.pricePiastres.toString(),
      verified_discount_pct: i.verifiedDiscountPct,
    })),
    per_store: [...perStore].sort(([a], [b]) => (a < b ? -1 : 1)).map(([store_id, v]) => ({ store_id, subtotal_piastres: v.toString() })),
    missing: o.missing.map(missingWire),
    added_to_bag: o.addedToBagAtMs !== null,
    created_at: iso(o.createdAtMs),
  };
}

export function generateWire(v: GenerateView) {
  return {
    ai_notice: "AI suggestions" as const,
    outfits: v.outfits.map(outfitWire),
    source: v.source,
    fallback_reason: v.fallbackReason,
    explanation: v.explanation,
    quota: { remaining_today: v.remainingToday },
  };
}
