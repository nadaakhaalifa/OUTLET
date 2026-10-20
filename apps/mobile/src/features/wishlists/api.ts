import { collectPages, dataOf, type schemas } from "../../services/api-client";
import { etagOf, guard, money, ms, msOrNull, pick, toMoney, type AdapterContext } from "../../services/wire";
import { COOL_OFF_MS, type NewWishlistDraft, type SaveItemHint, type ShareLink, type Wishlist, type WishlistIntent, type WishlistItem, type WishlistsPort } from "./model";

const TO_WIRE: Readonly<Record<WishlistIntent, schemas.WishlistIntent>> = {
  need: "need", want: "want", treat: "treat", laterThisMonth: "buy_later_this_month", birthday: "birthday",
  eidRamadan: "eid_ramadan", gift: "gift_for_someone", custom: "custom",
};
const FROM_WIRE: Readonly<Record<schemas.WishlistIntent, WishlistIntent>> = {
  need: "need", want: "want", treat: "treat", buy_later_this_month: "laterThisMonth", birthday: "birthday",
  eid_ramadan: "eidRamadan", gift_for_someone: "gift", custom: "custom",
};

function toShare(s: schemas.ShareLink): ShareLink {
  return { url: s.url, expiresAtMs: msOrNull(s.expires_at) };
}

/** /v1/me/wishlists. The list endpoint has no items, so each list is expanded with GET /v1/me/wishlists/{id}. */
export class ApiWishlistsPort implements WishlistsPort {
  constructor(private readonly ctx: AdapterContext) {}

  private map(w: schemas.Wishlist | schemas.WishlistDetail): Wishlist {
    const lang = this.ctx.locale();
    const items: readonly schemas.WishlistItem[] = "items" in w ? w.items : [];
    return {
      id: w.id,
      intent: FROM_WIRE[w.intent],
      title: w.title,
      targetDate: w.target_date ?? null,
      budget: w.budget !== undefined ? money(w.budget) : null,
      recipientNickname: w.gift_for?.nickname ?? null,
      occasion: w.gift_for?.occasion ?? null,
      coolOffEnabled: w.cool_off_enabled ?? false,
      // The wire exposes only visibility, not the share url/expiry of an existing link (gap).
      share: null,
      items: items.map((i): WishlistItem => ({
        id: i.id,
        productId: i.product_id,
        title: i.product !== undefined ? pick(i.product.title, lang) : "",
        addedPrice: money(i.added_price),
        currentPrice: i.current_price !== undefined && i.current_price !== null ? money(i.current_price) : null,
        status: i.state === "active" ? "listed" : "delisted",
        note: i.note ?? null,
        storeName: i.product !== undefined ? pick(i.product.store.name, lang) : null,
        storeVerified: i.product?.store.verified_badge === true,
        skuPref: i.sku_pref ?? null,
        coolOffStartedAtMs: i.cool_off_until !== undefined && i.cool_off_until !== null ? ms(i.cool_off_until) - COOL_OFF_MS : null,
      })),
    };
  }

  list(): Promise<readonly Wishlist[]> {
    return guard(async () => {
      const lists = await collectPages((cursor) => this.ctx.client.listWishlists({ query: { limit: 50, ...(cursor !== undefined ? { cursor } : {}) } }), 10);
      const details = await Promise.all(lists.map(async (l) => dataOf(await this.ctx.client.getWishlist({ path: { wishlistId: l.id } }))));
      return details.map((d) => this.map(d));
    });
  }

  create(draft: NewWishlistDraft): Promise<Wishlist> {
    return guard(async () => {
      const body: schemas.WishlistInput = {
        intent: TO_WIRE[draft.intent],
        title: draft.title,
        ...(draft.targetDate !== null ? { target_date: draft.targetDate } : {}),
        ...(draft.budget !== null ? { budget: toMoney(draft.budget) } : {}),
        ...(draft.recipientNickname !== null
          ? { gift_for: { nickname: draft.recipientNickname, ...(draft.occasion !== null ? { occasion: draft.occasion } : {}) } }
          : {}),
      };
      return this.map(dataOf(await this.ctx.client.createWishlist({ body })));
    });
  }

  setCoolOff(listId: string, enabled: boolean): Promise<void> {
    return guard(async () => {
      const current = await this.ctx.client.getWishlist({ path: { wishlistId: listId } });
      dataOf(await this.ctx.client.updateWishlist({ path: { wishlistId: listId }, headers: { "If-Match": etagOf(current) }, body: { cool_off_enabled: enabled } }));
    });
  }

  createShare(listId: string, expiresAtMs: number | null, hidePricesFromOwner = false): Promise<ShareLink> {
    return guard(async () => {
      const body: schemas.ShareLinkRequest = {
        ...(expiresAtMs !== null ? { expires_at: new Date(expiresAtMs).toISOString() } : {}),
        ...(hidePricesFromOwner ? { hide_prices_from_owner: true } : {}),
      };
      return toShare(dataOf(await this.ctx.client.createWishlistShareLink({ path: { wishlistId: listId }, body })));
    });
  }

  revokeShare(listId: string): Promise<void> {
    return guard(async () => {
      dataOf(await this.ctx.client.revokeWishlistShareLink({ path: { wishlistId: listId } }));
    });
  }

  /** No endpoint starts a cool-off window on the first Buy press (gap): the server owns cool_off_until. */
  startCoolOff(_listId: string, _itemId: string, _nowMs: number): Promise<void> {
    return guard(async () => {
      throw new Error("unsupported by the API contract: start cool-off (wishlists)");
    });
  }

  removeItem(listId: string, itemId: string): Promise<void> {
    return guard(async () => {
      await this.ctx.client.removeWishlistItem({ path: { wishlistId: listId, itemId } });
    });
  }

  addToBag(skuId: string): Promise<void> {
    return guard(async () => {
      dataOf(await this.ctx.client.addCartLine({ body: { sku_id: skuId, qty: 1, source: "wishlist" } }));
    });
  }

  bagProductIds(): Promise<readonly string[]> {
    return guard(async () => {
      const cart = dataOf(await this.ctx.client.getCart());
      return cart.groups.flatMap((g) => g.lines.map((l) => l.product_id));
    });
  }

  saveItem(productId: string, intent: WishlistIntent, hint: SaveItemHint): Promise<void> {
    return guard(async () => {
      const lists = await this.list();
      let target = lists.find((l) => l.intent === intent);
      if (target === undefined) {
        target = await this.create({ intent, title: intent, targetDate: null, budget: null, recipientNickname: null, occasion: null });
      }
      if (target.items.some((i) => i.productId === productId)) return;
      dataOf(await this.ctx.client.addWishlistItem({ path: { wishlistId: target.id }, body: { product_id: productId, ...(hint.skuId !== undefined ? { sku_pref: hint.skuId } : {}) } }));
    });
  }
}
