import { dataOf } from "../../services/api-client";
import { etagOf, guard, money, pick, type AdapterContext } from "../../services/wire";
import type { AddLineHint, BagPort, BagSnapshot, Suggestion } from "./model";

/** GET/POST/PATCH /v1/cart. The server prices everything; the add hint is ignored. */
export class ApiBagPort implements BagPort {
  constructor(private readonly ctx: AdapterContext) {}

  load(): Promise<BagSnapshot> {
    return guard(async () => {
      const cart = dataOf(await this.ctx.client.getCart());
      const lang = this.ctx.locale();
      return {
        stores: cart.groups.map((g) => ({
          id: g.store.id,
          name: pick(g.store.name, lang),
          status: g.status === "open" ? ("active" as const) : ("suspended" as const),
          freeDeliveryThreshold: money(g.free_delivery.threshold),
        })),
        lines: cart.groups.flatMap((g) =>
          g.lines.map((l) => ({
            id: l.id,
            storeId: g.store.id,
            title: pick(l.title, lang),
            sizeLabel: l.size_label ?? null,
            qty: l.qty,
            unitPrice: money(l.unit_price),
            priceAtAdd: money(l.price_at_add),
            // The wire has one "unavailable" value: sold out and paused are indistinguishable (gap).
            availability: l.availability === "available" ? ("available" as const) : ("soldOut" as const),
            savedForLater: l.saved_for_later ?? false,
          })),
        ),
        isPlusMember: cart.groups.some((g) => g.free_delivery.plus_member === true),
      };
    });
  }

  /**
   * GET /v1/cart/free-delivery-suggestions. Each suggestion carries the in-size `sku_id`; one without a
   * `size_label` is dropped (the bag shows the size it adds, never a guess).
   */
  inSizeSuggestions(storeId: string): Promise<readonly Suggestion[]> {
    return guard(async () => {
      const r = dataOf(await this.ctx.client.getFreeDeliverySuggestions({ query: { store_id: storeId } }));
      const lang = this.ctx.locale();
      return r.suggestions.flatMap((p) =>
        p.size_label === undefined ? [] : [{ skuId: p.sku_id, title: pick(p.title, lang), sizeLabel: p.size_label, unitPrice: money(p.price.price) }],
      );
    });
  }

  setSavedForLater(lineId: string, saved: boolean): Promise<void> {
    return guard(async () => {
      // PATCH needs the cart's ETag in If-Match; the port has no concurrency token, so read it first.
      const current = await this.ctx.client.getCart();
      dataOf(await this.ctx.client.updateCartLine({ path: { lineId }, headers: { "If-Match": etagOf(current) }, body: { saved_for_later: saved } }));
    });
  }

  setQuantity(lineId: string, qty: number): Promise<void> {
    return guard(async () => {
      const current = await this.ctx.client.getCart();
      dataOf(await this.ctx.client.updateCartLine({ path: { lineId }, headers: { "If-Match": etagOf(current) }, body: { qty } }));
    });
  }

  removeLine(lineId: string): Promise<void> {
    return guard(async () => {
      await this.ctx.client.removeCartLine({ path: { lineId } });
    });
  }

  addLine(skuId: string, _hint: AddLineHint): Promise<void> {
    return guard(async () => {
      dataOf(await this.ctx.client.addCartLine({ body: { sku_id: skuId, qty: 1, source: "pdp" } }));
    });
  }
}
