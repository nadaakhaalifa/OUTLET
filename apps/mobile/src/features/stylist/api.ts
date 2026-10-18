import { dataOf, type schemas } from "../../services/api-client";
import { guard, piastres, unsupported, type AdapterContext } from "../../services/wire";
import {
  SLOTS, type AddOutfitResult, type FeedbackSignal, type Occasion, type Outfit, type OutfitBagPort, type OutfitItem, type OutfitRequest,
  type OutfitResult, type RejectedItem, type RejectReason, type Slot, type StylistPort,
} from "./model";

const OCCASION: Readonly<Record<Occasion, NonNullable<schemas.StylistOutfitsRequest["occasion"]>>> = {
  work: "work", weddingGuest: "wedding_guest", date: "date", eid: "eid", beach: "beach", gym: "gym", university: "university",
};

function slotOf(s: string): Slot | null {
  return SLOTS.find((x) => x === s) ?? null;
}

function reasonOf(r: string): RejectReason {
  return r.includes("pause") ? "paused" : r.includes("price") ? "priceChanged" : "soldOut";
}

/**
 * /v1/stylist/*. Item title, store name, size label and per-store delivery fee are not on StylistOutfit (gap):
 * they are left empty / zero rather than invented. The server already writes accepted items into the bag, so
 * this adapter is its own OutfitBagPort and must NOT be wrapped by BagBackedStylist (that would add twice).
 */
export class ApiStylistPort implements StylistPort, OutfitBagPort {
  constructor(private readonly ctx: AdapterContext) {}

  private mapOutfit(o: schemas.StylistOutfit): Outfit {
    const items: OutfitItem[] = [];
    for (const i of o.items) {
      const slot = slotOf(i.slot);
      if (slot === null) continue;
      items.push({ skuId: i.item_id, slot, title: "", storeId: i.store_id, storeName: "", sizeLabel: "", unitPrice: piastres(i.price_piastres) });
    }
    return {
      id: o.id,
      items,
      deliveries: o.per_store.map((s) => ({ storeId: s.store_id, storeName: "", fee: 0n })),
      missing: o.missing.flatMap((m) => {
        const slot = slotOf(m.slot);
        return slot === null ? [] : [{ slot, shortfall: m.add_piastres !== null ? piastres(m.add_piastres) : 0n }];
      }),
    };
  }

  generate(req: OutfitRequest): Promise<OutfitResult> {
    return guard(async () => {
      const body: schemas.StylistOutfitsRequest = {
        occasion: OCCASION[req.occasion],
        modest: req.modest,
        ...(req.budget !== null ? { budget_piastres: req.budget.toString() } : {}),
      };
      const r = dataOf(await this.ctx.client.generateStylistOutfits({ body }));
      return { outfits: r.outfits.map((o) => this.mapOutfit(o)), source: r.source.includes("rule") || r.fallback_reason !== null ? "rules" : "ai" };
    });
  }

  async swap(_outfitId: string, _skuId: string): Promise<Outfit> {
    throw unsupported("stylist swap (only swap_in/swap_out feedback exists, no endpoint returns the swapped outfit)");
  }

  feedback(outfitId: string, skuId: string, signal: FeedbackSignal): Promise<void> {
    return guard(async () => {
      dataOf(await this.ctx.client.submitStylistFeedback({ body: { outfit_id: outfitId, item_id: skuId, signal } }));
    });
  }

  addOutfit(outfitId: string, idempotencyKey: string): Promise<AddOutfitResult> {
    return guard(async () => {
      const r = dataOf(await this.ctx.client.addStylistOutfitToBag({ path: { outfitId } }, { idempotencyKey }));
      const changed = new Map(r.price_changes.map((c) => [c.item_id, piastres(c.to_piastres)]));
      const rejected: RejectedItem[] = r.unavailable.map((u) => ({ skuId: u.item_id, reason: reasonOf(u.reason), currentPrice: null }));
      for (const [skuId, price] of changed) rejected.push({ skuId, reason: "priceChanged", currentPrice: price });
      return { added: r.added || r.already_added ? r.item_ids.filter((id) => !changed.has(id)) : [], rejected };
    });
  }
}
