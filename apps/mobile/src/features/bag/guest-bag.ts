/**
 * Bag port for a signed-out shopper (spec guest-browsing F2, §8): lines come from the device store, prices from the
 * public SKU read. No server write ever happens here. The price at add time is what the phone saw; the live price
 * moves the line honestly in both directions. If the live read fails the line keeps its last seen price.
 */
import { MAX_UNITS_PER_ITEM, type GuestBagLine, type GuestStorePort } from "../guest";
import {
  BagCapError, PortError,
  type AddLineHint, type Availability, type BagLine, type BagPort, type BagSnapshot, type BagStore, type Suggestion,
} from "./model";

export interface LiveSku { readonly unitPrice: bigint; readonly available: boolean; readonly storeOpen: boolean }
/** Public read of price and availability by SKU id (G-2). Missing ids are absent from the map. */
export interface SkuLiveReader { read(skuIds: readonly string[]): Promise<ReadonlyMap<string, LiveSku>> }

export class GuestBagPort implements BagPort {
  constructor(private readonly store: GuestStorePort, private readonly live: SkuLiveReader | null = null) {}

  async load(): Promise<BagSnapshot> {
    await this.store.hydrate();
    const bag = this.store.getState().bag;
    let liveBySku: ReadonlyMap<string, LiveSku> = new Map();
    let readFailed = false;
    if (this.live !== null && bag.length > 0) {
      try { liveBySku = await this.live.read([...new Set(bag.map((l) => l.skuId))]); } catch { readFailed = true; /* the last seen price stays, marked stale */ }
    }
    const stores = new Map<string, BagStore>();
    const lines: BagLine[] = bag.map((l) => {
      const lv = liveBySku.get(l.skuId);
      const open = lv?.storeOpen ?? true;
      const prev = stores.get(l.storeId);
      if (prev === undefined || (prev.status === "active" && !open)) {
        // Free-delivery progress needs the store threshold, which the SKU read does not carry: 0n hides it ("Delivery calculated at checkout").
        stores.set(l.storeId, { id: l.storeId, name: l.seen.storeName, status: open ? "active" : "suspended", freeDeliveryThreshold: 0n });
      }
      return toLine(l, lv, readFailed);
    });
    return { stores: [...stores.values()], lines, isPlusMember: false, guest: true, ...(readFailed ? { offline: true } : {}) };
  }

  async inSizeSuggestions(_storeId: string): Promise<readonly Suggestion[]> {
    return []; // no in-size suggestions for guests (spec §8)
  }

  async setSavedForLater(lineId: string, saved: boolean): Promise<void> {
    await this.store.hydrate();
    this.check(this.store.setLineSavedForLater(lineId, saved));
  }

  async setQuantity(lineId: string, qty: number): Promise<void> {
    await this.store.hydrate();
    if (qty > MAX_UNITS_PER_ITEM) throw new BagCapError("units");
    this.check(this.store.setQty(lineId, qty));
  }

  async removeLine(lineId: string): Promise<void> {
    await this.store.hydrate();
    this.check(this.store.removeLine(lineId));
  }

  async addLine(skuId: string, hint: AddLineHint): Promise<void> {
    await this.store.hydrate();
    this.check(this.store.addToBag({
      skuId, productId: hint.productId ?? skuId, storeId: hint.storeId, qty: 1,
      seen: { unitPricePiastres: hint.unitPrice.toString(), title: hint.title, sizeLabel: hint.sizeLabel, storeName: hint.storeName, imageUrl: hint.imageUrl ?? null },
    }));
  }

  private check(r: { readonly ok: true } | { readonly ok: false; readonly error: string }): void {
    if (r.ok) return;
    if (r.error === "lines_cap") throw new BagCapError("lines");
    if (r.error === "units_cap") throw new BagCapError("units");
    throw new PortError("failed");
  }
}

function toLine(l: GuestBagLine, lv: LiveSku | undefined, stale: boolean): BagLine {
  const seen = BigInt(l.seen.unitPricePiastres);
  const availability: Availability = lv !== undefined && !lv.available ? "soldOut" : "available";
  return {
    id: l.id, storeId: l.storeId, title: l.seen.title, sizeLabel: l.seen.sizeLabel, qty: l.qty,
    unitPrice: lv?.unitPrice ?? seen, priceAtAdd: seen, availability, savedForLater: l.savedForLater,
    ...(stale ? { priceStale: true, seenAt: l.touchedAt } : {}),
    ...(l.seen.imageUrl !== null ? { imageUrl: l.seen.imageUrl } : {}),
  };
}
