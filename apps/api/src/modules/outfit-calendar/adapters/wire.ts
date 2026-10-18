import type { Feasibility, MissingSlot } from "../domain/bridge";
import type { GeneratedOutfit, GenerateOutfitsView } from "../application/outfits";
import type { EventView } from "../application/shared";
import type { PriceChange, UnavailableItem } from "../application/bag";

const iso = (ms: number): string => new Date(ms).toISOString();
const hhmm = (minute: number): string => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

export function eventWire(v: EventView) {
  const e = v.event;
  return {
    id: e.id,
    kind: e.kind,
    starts_at: iso(e.startsAtMs),
    local_date: e.localDate,
    local_time: hhmm(v.localMinute),
    note: e.note,
    modesty: e.modesty,
    season_band: e.seasonBand,
    budget_piastres: e.budgetPiastres === null ? null : e.budgetPiastres.toString(),
    owned_slots: [...e.ownedSlots],
    source: e.source,
    reminders_enabled: e.remindersEnabled,
    status: v.archived ? ("archived" as const) : ("active" as const),
    outfit_status: v.outfitStatus,
    outfits: v.links.map((l) => ({ outfit_id: l.outfitId, status: l.status })),
    version: e.version,
    created_at: iso(e.createdAtMs),
  };
}

/** Estimate only: `guaranteed` is always false and no delivery date is promised (CPL 181/2018). */
export const deliveryWire = (f: Feasibility) => ({
  status: f.status,
  order_by_date: f.orderByDateKey,
  guaranteed: false as const,
});

const missingWire = (m: MissingSlot) => ({
  slot: m.slot,
  reason: m.reason,
  add_piastres: m.addPiastres === null ? null : m.addPiastres.toString(),
});

/** Money is integer piastres as strings. Every outfit carries the "AI suggestions" label (LLM09). */
export function gapOutfitWire(o: GeneratedOutfit) {
  const perStore = new Map<string, bigint>();
  for (const i of o.record.items) perStore.set(i.storeId, (perStore.get(i.storeId) ?? 0n) + i.pricePiastres);
  return {
    outfit_id: o.record.id,
    source: o.record.source,
    complete: o.record.complete,
    ai_suggestion: true as const,
    currency: "EGP" as const,
    total_piastres: o.record.totalPiastres.toString(),
    owned_slots: [...o.gap.ownedSlots],
    items: o.record.items.map((i) => ({
      item_id: i.itemId,
      store_id: i.storeId,
      slot: i.slot,
      price_piastres: i.pricePiastres.toString(),
      verified_discount_pct: i.verifiedDiscountPct,
    })),
    per_store: [...perStore].sort(([a], [b]) => (a < b ? -1 : 1)).map(([store_id, v]) => ({ store_id, subtotal_piastres: v.toString() })),
    missing: o.record.missing.map(missingWire),
    budget_fit: {
      budget_piastres: o.record.budgetPiastres === null ? null : o.record.budgetPiastres.toString(),
      remaining_piastres: o.gap.remainingBudgetPiastres === null ? null : o.gap.remainingBudgetPiastres.toString(),
      within_budget: true as const,
    },
    delivery: deliveryWire(o.feasibility),
  };
}

export function generateWire(v: GenerateOutfitsView) {
  return {
    ai_notice: "AI suggestions" as const,
    event: eventWire(v.event),
    outfits: v.outfits.map(gapOutfitWire),
    owned_only: v.ownedOnly,
    shortfall: v.shortfall.map(missingWire),
    source: v.source,
    fallback_reason: v.fallbackReason,
    quota: { remaining_today: v.remainingToday },
  };
}

export const unavailableWire = (u: UnavailableItem) => ({ item_id: u.itemId, slot: u.slot, reason: u.reason });
export const priceChangeWire = (c: PriceChange) => ({
  item_id: c.itemId,
  from_piastres: c.fromPiastres.toString(),
  to_piastres: c.toPiastres.toString(),
});
