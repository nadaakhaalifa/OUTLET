/**
 * Wishlists port for a signed-out shopper (spec guest-browsing §8, ADR-0055). Items live in the device store, one list per
 * intent. Titles and live prices come from the public product read; if it fails the last price seen on this phone is kept.
 * No server write ever happens here. Sharing and custom lists need an account, so they are absent (the screen hides them).
 */
import type { GuestStorePort, SavedIntent } from "../guest";
import type { BagPort } from "../bag/model";
import {
  PortError,
  type NewWishlistDraft, type SaveItemHint, type ShareLink, type Wishlist, type WishlistIntent, type WishlistItem, type WishlistsPort,
} from "./model";

export interface SavedProductInfo {
  readonly title: string;
  readonly storeId: string;
  readonly storeName: string;
  readonly storeVerified: boolean;
  readonly price: bigint;
  /** False only when the product is gone (404) or paused; unknown reads are simply absent from the map. */
  readonly listed: boolean;
  readonly sizes: ReadonlyMap<string, { readonly label: string; readonly price: bigint }>;
}
/** Public read of product display data by id (no bearer). Missing ids are absent from the map. */
export interface SavedProductReader { read(productIds: readonly string[]): Promise<ReadonlyMap<string, SavedProductInfo>> }

const TO_GUEST: Readonly<Record<WishlistIntent, SavedIntent>> = {
  need: "need", want: "want", treat: "treat", laterThisMonth: "later",
  // The phone keeps four lists; the account-only intents fall into "later" instead of being lost.
  birthday: "later", eidRamadan: "later", gift: "later", custom: "later",
};
const FROM_GUEST: Readonly<Record<SavedIntent, WishlistIntent>> = { need: "need", want: "want", treat: "treat", later: "laterThisMonth" };
const ORDER: readonly SavedIntent[] = ["need", "want", "treat", "later"];
const listId = (i: SavedIntent): string => `guest-${i}`;
const itemId = (i: SavedIntent, productId: string): string => `${i}:${productId}`;

export class GuestWishlistsPort implements WishlistsPort {
    private readonly coolStarted = new Map<string, number>();
  private readonly info = new Map<string, SavedProductInfo>();
  private readonly hintTitle = new Map<string, string>();

  constructor(
    private readonly store: GuestStorePort,
    private readonly bag: BagPort,
    private readonly reader: SavedProductReader | null,
    private readonly titleOf: (intent: WishlistIntent) => string,
    private readonly nowMs: () => number = () => Date.now(),
  ) {}

  async isGuest(): Promise<boolean> { return true; }

  async list(): Promise<readonly Wishlist[]> {
    await this.store.hydrate();
    const saved = this.store.getState().saved;
    let read: ReadonlyMap<string, SavedProductInfo> = new Map();
    if (this.reader !== null && saved.length > 0) {
      try { read = await this.reader.read([...new Set(saved.map((s) => s.productId))]); } catch { /* last seen price stays */ }
    }
    for (const [k, v] of read) this.info.set(k, v);
    const out: Wishlist[] = [];
    for (const intent of ORDER) {
      const mine = saved.filter((s) => s.intent === intent).sort((a, b) => b.addedAt - a.addedAt);
      if (mine.length === 0) continue;
      const wl = FROM_GUEST[intent];
      const items = mine.map((s): WishlistItem => {
        const live = read.get(s.productId) ?? this.info.get(s.productId);
        const seen = BigInt(s.seenPricePiastres);
        const delisted = live !== undefined && !live.listed;
        const sizePrice = s.skuId !== null ? live?.sizes.get(s.skuId)?.price : undefined;
        return {
          id: itemId(intent, s.productId), productId: s.productId,
          title: live !== undefined && live.title.length > 0 ? live.title : (this.hintTitle.get(s.productId) ?? ""),
          addedPrice: seen, currentPrice: delisted ? null : (sizePrice ?? live?.price ?? null),
          status: delisted ? "delisted" : "listed", note: null,
          storeName: live?.storeName ?? null, storeVerified: live?.storeVerified === true,
          skuPref: s.skuId, coolOffStartedAtMs: this.coolStarted.get(itemId(intent, s.productId)) ?? null,
        };
      });
      out.push({ id: listId(intent), intent: wl, title: this.titleOf(wl), targetDate: null, budget: null, recipientNickname: null, occasion: null, coolOffEnabled: intent === "want" && this.store.getState().settings.coolOff, share: null, items });
    }
    return out;
  }

  async create(_draft: NewWishlistDraft): Promise<Wishlist> { throw new PortError("failed"); }

  async setCoolOff(_listId: string, enabled: boolean): Promise<void> { await this.store.hydrate(); this.store.setCoolOff(enabled); }

  async createShare(_listId: string, _expiresAtMs: number | null, _hide?: boolean): Promise<ShareLink> { throw new PortError("failed"); }
  async revokeShare(_listId: string): Promise<void> { /* nothing is ever shared from a phone */ }

  async startCoolOff(_listId: string, id: string, nowMs: number): Promise<void> {
    if (!this.coolStarted.has(id)) this.coolStarted.set(id, nowMs);
  }

  async removeItem(_listId: string, id: string): Promise<void> {
    await this.store.hydrate();
    const [intent, ...rest] = id.split(":");
    const productId = rest.join(":");
    if (!ORDER.includes(intent as SavedIntent) || productId.length === 0) throw new PortError("failed");
    const r = this.store.unsave(productId, intent as SavedIntent);
    if (!r.ok) throw new PortError("failed");
    this.coolStarted.delete(id);
  }

  /** Adds one unit of the saved size to the guest bag (device only). The size must have been saved with a SKU. */
  async addToBag(skuId: string): Promise<void> {
    await this.store.hydrate();
    const item = this.store.getState().saved.find((s) => s.skuId === skuId);
    const live = item !== undefined ? this.info.get(item.productId) : undefined;
    if (item === undefined || live === undefined) throw new PortError("failed");
    const size = live.sizes.get(skuId);
    await this.bag.addLine(skuId, {
      productId: item.productId, storeId: live.storeId, storeName: live.storeName, title: live.title,
      sizeLabel: size?.label ?? null, unitPrice: size?.price ?? live.price,
    });
  }

  async bagProductIds(): Promise<readonly string[]> {
    await this.store.hydrate();
    return this.store.getState().bag.map((l) => l.productId);
  }

  async saveItem(productId: string, intent: WishlistIntent, hint: SaveItemHint): Promise<void> {
    await this.store.hydrate();
    this.hintTitle.set(productId, hint.title);
    const mapped = TO_GUEST[intent];
    if (this.store.getState().saved.some((x) => x.productId === productId && x.intent === mapped)) return; // keeps the price first seen, like the server
    const r = this.store.save({ productId, skuId: hint.skuId ?? null, intent: mapped, seenPricePiastres: hint.price.toString() });
    if (!r.ok) throw new PortError("failed");
  }
}
