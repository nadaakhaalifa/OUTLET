import { piastres } from "../../services/wire";
import { SLOTS, type MissingSlot, type Outfit, type OutfitItem, type Slot } from "./model";

/** The subset of the stylist, calendar and wardrobe outfit wire shapes the app reads (they share these fields). */
export interface WireOutfitLike {
  readonly id: string;
  readonly items: readonly { readonly item_id: string; readonly store_id: string; readonly slot: string; readonly price_piastres: string }[];
  readonly per_store: readonly { readonly store_id: string }[];
  readonly missing: readonly { readonly slot: string; readonly add_piastres: string | null }[];
}

export function slotOf(s: string): Slot | null {
  return SLOTS.find((x) => x === s) ?? null;
}

/**
 * Title, store name, size label and delivery fee are not on the wire (docs/plan/api-client-gap.md): they stay
 * empty / zero here and are never invented.
 */
export function outfitFromWire(o: WireOutfitLike): Outfit {
  const items: OutfitItem[] = [];
  for (const i of o.items) {
    const slot = slotOf(i.slot);
    if (slot === null) continue;
    items.push({ skuId: i.item_id, slot, title: "", storeId: i.store_id, storeName: "", sizeLabel: "", unitPrice: piastres(i.price_piastres) });
  }
  const missing: MissingSlot[] = [];
  for (const m of o.missing) {
    const slot = slotOf(m.slot);
    if (slot !== null) missing.push({ slot, shortfall: m.add_piastres !== null ? piastres(m.add_piastres) : 0n });
  }
  return { id: o.id, items, deliveries: o.per_store.map((s) => ({ storeId: s.store_id, storeName: "", fee: 0n })), missing };
}
