import { Controller, Delete, Get, HttpCode, Inject, Patch, Post, Req } from "@nestjs/common";
import { freeDeliverySuggestionsInput } from "@outlet/cart";
import type { CartView } from "@outlet/cart";
import { z } from "zod";
import { ACTIONS } from "../../platform/actions.js";
import { Authorize, Contract, Paginated, RateLimit } from "../../platform/decorators.js";
import { API_DEPS } from "../../platform/deps.js";
import type { ApiDeps } from "../../platform/deps.js";
import { headerValue } from "../../platform/http.js";
import type { ApiRequest, RequestState } from "../../platform/http.js";
import { wireMoney } from "../../platform/money-wire.js";
import { Problems } from "../../platform/problem.js";
import { RATE_BUDGETS } from "../../platform/rate-limit/budgets.js";
import { self } from "../../platform/resolvers.js";
import { Body, Ctx, Params, Query } from "../../platform/validation.js";
import { Cart, CartLineId, CartLineInput, CartLinePatch, SuggestionPage, SuggestionsQuery } from "./dto.js";

const userOf = (s: RequestState): string => {
  if (s.user === undefined) throw Problems.unauthenticated();
  return s.user.userId;
};
const marketOf = (s: RequestState): string => {
  if (s.marketId === undefined) throw Problems.notFound("unknown-market");
  return s.marketId;
};

const toCart = (v: CartView, market: string): Cart => ({
  id: v.id,
  currency: v.currency,
  version: v.version,
  groups: v.groups.map((g) => ({
    store_id: g.storeId,
    store_slug: g.slug ?? "",
    display_name_ar: g.nameAr ?? "متجر غير متاح",
    subtotal: wireMoney(g.subtotal),
    free_delivery_threshold: wireMoney({ amountMinor: g.freeDelivery.thresholdMinor, currency: g.subtotal.currency }),
    remaining_for_free_delivery: wireMoney({ amountMinor: g.freeDelivery.remainingMinor, currency: g.subtotal.currency }),
    lines: g.lines.map((l) => ({
      id: l.line.id,
      sku_id: l.line.skuId,
      product_id: l.line.productId,
      store_id: l.line.storeId,
      qty: l.line.qty,
      price_at_add: wireMoney({ amountMinor: l.line.priceAtAddMinor, currency: l.line.currency }),
      current_price: { current_price: wireMoney(l.current), claim_type: "plain", price_proof_path: `/v1/${market}/products/${l.line.productId}` },
      // The bag service does not read defect cards yet; the acknowledgement route is still to be built (openapi.todo.json).
      defect_ack_required: false,
      saved_for_later: false,
      available: l.state !== "unavailable" && l.state !== "store_locked",
      source: l.line.source,
      added_at: l.line.addedAt,
    })),
  })),
  items_subtotal: wireMoney(v.itemsSubtotal),
  notices: v.notices.map((n) => ({ code: n.code, line_id: n.lineId })),
});

/** The shopper's bag. User context (RLS app.current_user_id); a foreign line id is invisible, hence 404. */
@Controller("v1/:market")
export class CartController {
  constructor(@Inject(API_DEPS) private readonly deps: ApiDeps) {}

  private async view(s: RequestState): Promise<Cart> {
    const m = marketOf(s);
    return toCart(await this.deps.cart(m).cart.get(userOf(s)), s.market?.id ?? m.toLowerCase());
  }

  @Get("cart")
  @Authorize(ACTIONS.cartRead, self)
  @RateLimit({ budget: RATE_BUDGETS.shopperRead })
  @Contract({ operationId: "getCart", summary: "My bag grouped by store, live prices, free-delivery progress", tags: ["Cart"], response: Cart, maxQueries: 4 })
  getCart(@Ctx() s: RequestState): Promise<Cart> {
    return this.view(s);
  }

  @Post("cart/lines")
  @HttpCode(201)
  @Authorize(ACTIONS.cartWrite, self)
  @RateLimit({ budget: RATE_BUDGETS.cartWrite })
  @Contract({ operationId: "addCartLine", summary: "Add a SKU to the bag (merges quantities; max 50 lines, 10 units per SKU)", tags: ["Cart"], body: CartLineInput, response: Cart, status: 201, maxQueries: 20 })
  async addLine(@Ctx() s: RequestState, @Req() req: ApiRequest, @Body() b: z.infer<typeof CartLineInput>): Promise<Cart> {
    // The same client key drives the service's own transactional idempotency record (route cart.addLine).
    const key = headerValue(req, "idempotency-key") ?? "";
    await this.deps.cart(marketOf(s)).cart.addLine(userOf(s), { skuId: b.sku_id, qty: b.qty, ...(b.source === undefined ? {} : { source: b.source }) }, key);
    return this.view(s);
  }

  @Patch("cart/lines/:cart_line_id")
  @Authorize(ACTIONS.cartWrite, self)
  @RateLimit({ budget: RATE_BUDGETS.cartWrite })
  @Contract({ operationId: "updateCartLine", summary: "Change a line's quantity", tags: ["Cart"], params: CartLineId, body: CartLinePatch, response: Cart, maxQueries: 12 })
  async updateLine(@Ctx() s: RequestState, @Params() p: z.infer<typeof CartLineId>, @Body() b: z.infer<typeof CartLinePatch>): Promise<Cart> {
    // Save-for-later is not stored by the bag service: refuse instead of acknowledging a change that did not happen.
    if (b.saved_for_later !== undefined) throw Problems.unprocessable("saved-for-later-unsupported");
    if (b.qty === undefined) throw Problems.unprocessable("nothing-to-update");
    await this.deps.cart(marketOf(s)).cart.updateQty(userOf(s), p.cart_line_id, b.qty);
    return this.view(s);
  }

  @Delete("cart/lines/:cart_line_id")
  @Authorize(ACTIONS.cartWrite, self)
  @RateLimit({ budget: RATE_BUDGETS.cartWrite })
  @Contract({ operationId: "deleteCartLine", summary: "Remove a line", tags: ["Cart"], params: CartLineId, response: Cart, maxQueries: 12 })
  async deleteLine(@Ctx() s: RequestState, @Params() p: z.infer<typeof CartLineId>): Promise<Cart> {
    await this.deps.cart(marketOf(s)).cart.removeLine(userOf(s), p.cart_line_id);
    return this.view(s);
  }

  @Get("cart/free-delivery-suggestions")
  @Paginated()
  @Authorize(ACTIONS.cartRead, self)
  @RateLimit({ budget: RATE_BUDGETS.shopperRead })
  @Contract({ operationId: "listFreeDeliverySuggestions", summary: "Items from one store that would unlock free delivery (empty until the suggestion engine exists)", tags: ["Cart"], query: SuggestionsQuery, response: SuggestionPage, maxQueries: 4 })
  async suggestions(@Ctx() s: RequestState, @Query() q: z.infer<typeof SuggestionsQuery>): Promise<SuggestionPage> {
    const m = marketOf(s);
    const svc = this.deps.cart(m);
    const view = await svc.cart.get(userOf(s));
    const group = view.groups.find((g) => g.storeId === q.store_id);
    // A store that is not in the bag, is locked or already unlocked has nothing to suggest.
    const input = group === undefined ? null : freeDeliverySuggestionsInput(group);
    if (input === null) return { items: [], next_cursor: null };
    const found = await svc.suggestions.suggest({ userId: userOf(s), storeId: input.storeId, remainingMinor: input.remainingMinor, excludeSkuIds: input.excludeSkuIds, limit: q.limit });
    return { items: found.map((f) => ({ product_id: f.productId })), next_cursor: null };
  }
}
