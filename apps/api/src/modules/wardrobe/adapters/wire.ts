import type { ItemView } from "../application/shared";
import type { CompleteView, OwnedSlotsView } from "../application/complete";
import type { PartialAttributes } from "../domain/attributes";

const iso = (ms: number): string => new Date(ms).toISOString();

const attributesWire = (a: PartialAttributes) => ({
  ...(a.category === undefined ? {} : { category: a.category }),
  ...(a.palette === undefined ? {} : { palette: [...a.palette] }),
  ...(a.pattern === undefined ? {} : { pattern: a.pattern }),
  ...(a.formality === undefined ? {} : { formality: a.formality }),
  ...(a.seasons === undefined ? {} : { seasons: [...a.seasons] }),
  ...(a.material === undefined ? {} : { material: a.material }),
  ...(a.modest === undefined ? {} : { modest: a.modest }),
});

/**
 * One wardrobe item. The object-store key is never exposed (it is a capability handle): a photo is
 * only reachable through the signed GET route, and only once it is scanned clean.
 */
export const itemWire = (v: ItemView) => ({
  id: v.item.id,
  attributes: attributesWire(v.item.attributes),
  attributes_source: v.item.attributesSource,
  complete: v.complete,
  needs_review: v.needsReview,
  photo: { state: v.item.imageState === "infected" ? "rejected" : v.item.imageState },
  vision_model_version: v.item.visionModelVersion,
  version: v.item.version,
  created_at: iso(v.item.createdAtMs),
  updated_at: iso(v.item.updatedAtMs),
});

export const ownedSlotsWire = (v: OwnedSlotsView) => ({
  owned: v.picks.map((p) => ({ slot: p.slot, wardrobe_item_id: p.itemId })),
  owned_slots: v.picks.map((p) => p.slot),
  incomplete_items: v.incompleteCount,
});

export const completeWire = (v: CompleteView) => ({
  owned: v.owned.map((p) => ({ slot: p.slot, wardrobe_item_id: p.itemId })),
  owned_only: v.ownedOnly,
  source: v.source,
  fallback_reason: v.fallbackReason,
  remaining_today: v.remainingToday,
  shortfall: v.shortfall.map((m) => ({ slot: m.slot, reason: m.reason, add_piastres: m.addPiastres === null ? null : m.addPiastres.toString() })),
  outfits: v.outfits.map((o) => ({
    outfit_id: o.record.id,
    complete: o.gap.complete,
    source: o.gap.source,
    total_piastres: o.gap.totalPiastres.toString(),
    remaining_budget_piastres: o.gap.remainingBudgetPiastres === null ? null : o.gap.remainingBudgetPiastres.toString(),
    owned_slots: [...o.gap.ownedSlots],
    items: o.gap.items.map((i) => ({
      item_id: i.itemId,
      store_id: i.storeId,
      slot: i.slot,
      price_piastres: i.pricePiastres.toString(),
      verified_discount_pct: i.verifiedDiscountPct,
    })),
    missing: o.gap.missing.map((m) => ({ slot: m.slot, reason: m.reason, add_piastres: m.addPiastres === null ? null : m.addPiastres.toString() })),
  })),
});
