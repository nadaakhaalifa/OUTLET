import { Controller, Get, HttpCode, Inject, Post, Req } from "@nestjs/common";
import type { ClientAction } from "@outlet/checkout";
import { z } from "zod";
import { ACTIONS } from "../../platform/actions.js";
import { Authorize, Contract, NoIdempotency, Paginated, Public, RateLimit } from "../../platform/decorators.js";
import { API_DEPS } from "../../platform/deps.js";
import type { ApiDeps } from "../../platform/deps.js";
import { headerValue } from "../../platform/http.js";
import type { ApiRequest, RequestState } from "../../platform/http.js";
import { Problems } from "../../platform/problem.js";
import { RATE_BUDGETS } from "../../platform/rate-limit/budgets.js";
import { self } from "../../platform/resolvers.js";
import { Body, Ctx, Params, Query } from "../../platform/validation.js";
import {
  CheckoutBody, CheckoutResult, CodConfirmationBody, OrderGroup, OrderGroupId, OrderGroupsQuery, OrderGroupSummaryPage, ProviderParams, QuoteBody, QuoteResponse, WebhookAck,
} from "./dto.js";
import type { ClientActionDto as ClientActionWire } from "./dto.js";
import type { MoneyMinor, OrderGroupDetail } from "./ports.js";
import { readEcho, toContractMethod, toInternalMethod, wireQuote } from "./quote-wire.js";

const userOf = (s: RequestState): string => {
  if (s.user === undefined) throw Problems.unauthenticated();
  return s.user.userId;
};
const marketOf = (s: RequestState): string => {
  if (s.marketId === undefined) throw Problems.notFound("unknown-market");
  return s.marketId;
};
const mw = (m: MoneyMinor): { amount_minor: string; currency: string } => ({ amount_minor: m.amountMinor.toString(), currency: m.currency });

const actionWire = (a: ClientAction): ClientActionWire => {
  switch (a.kind) {
    case "redirect":
    case "iframe":
      return { kind: a.kind, url: a.url, reference: null, expires_at: null };
    case "sdk":
      return { kind: "sdk", url: null, reference: a.clientToken, expires_at: null };
    case "fawry_reference":
      return { kind: "fawry_reference", url: null, reference: a.reference, expires_at: a.expiresAt };
    case "instapay_request":
      return { kind: "instapay_qr", url: null, reference: a.reference, expires_at: a.expiresAt };
    case "cod_confirmation":
      return { kind: "cod_confirmation", url: null, reference: a.channel, expires_at: a.expiresAt };
    case "none":
      return { kind: "none", url: null, reference: null, expires_at: null };
  }
};

const groupWire = (g: OrderGroupDetail): OrderGroup => ({
  id: g.id,
  status: g.status,
  currency: g.currency,
  items_subtotal: mw(g.itemsSubtotal),
  discount: mw(g.discount),
  shipping: mw(g.shipping),
  vat: mw(g.vat),
  store_credit: mw(g.storeCredit),
  total: mw(g.total),
  payment_method: toContractMethod(g.paymentMethod as Parameters<typeof toContractMethod>[0]),
  payment_status: g.paymentStatus,
  client_action: g.clientAction === null ? null : actionWire(g.clientAction),
  placed_at: g.placedAt.toISOString(),
  paid_at: g.paidAt === null ? null : g.paidAt.toISOString(),
  seller_orders: g.sellerOrders.map((so) => ({
    id: so.id,
    store_id: so.storeId,
    store_display_name_ar: so.storeNameAr,
    status: so.status,
    items_subtotal: mw(so.itemsSubtotal),
    shipping: mw(so.shipping),
    vat: mw(so.vat),
    total: mw(so.total),
    lines: so.lines.map((l) => ({ id: l.id, sku_id: l.skuId, title_ar: l.titleAr, qty: l.qty, unit_price: mw(l.unitPrice) })),
    cancellable: false as const,
    returnable: false as const,
    tax_documents: [],
  })),
});

/** One bag, one payment. Shopper routes run on the outlet_app user context; the PSP callback on the worker role (job payments.webhook). */
@Controller("v1/:market")
export class CheckoutController {
  constructor(@Inject(API_DEPS) private readonly deps: ApiDeps) {}

  private rejectUnsupported(b: { voucher_codes?: readonly string[] | undefined; cart_line_ids?: readonly string[] | undefined; bnpl_provider?: string | undefined; payment_method?: string | undefined }): void {
    // payment_intents has CHECK (bnpl_provider IS NULL OR method = 'bnpl'): a lender on a non-BNPL method is a client error, not a 500.
    if (b.bnpl_provider !== undefined && b.payment_method !== undefined && b.payment_method !== "bnpl") throw Problems.unprocessable("bnpl-provider-mismatch");
    if ((b.voucher_codes?.length ?? 0) > 0) throw Problems.unprocessable("vouchers-unsupported");
    if ((b.cart_line_ids?.length ?? 0) > 0) throw Problems.unprocessable("partial-checkout-unsupported");
  }

  @Post("checkout/quote")
  @HttpCode(200)
  @Authorize(ACTIONS.checkout, self)
  @NoIdempotency("pure quote: reads the bag and signs a token, writes nothing")
  @RateLimit({ budget: RATE_BUDGETS.shopperWrite })
  @Contract({
    operationId: "quoteCheckout",
    summary: "Price the bag (pure): every fee on the first render, signed 10-minute price lock",
    tags: ["Checkout"],
    body: QuoteBody,
    response: QuoteResponse,
    status: 200,
    maxQueries: 20,
  })
  async quote(@Ctx() s: RequestState, @Body() b: z.infer<typeof QuoteBody>): Promise<z.infer<typeof QuoteResponse>> {
    this.rejectUnsupported(b);
    const r = await this.deps.checkout(marketOf(s)).checkout.quote(userOf(s), {
      addressRef: b.address_id,
      method: toInternalMethod(b.payment_method),
      ...(b.store_credit === undefined ? {} : { creditRequested: { amountMinor: BigInt(b.store_credit.amount_minor), currency: "EGP" } }),
      ...(b.bnpl_provider === undefined ? {} : { bnplProvider: b.bnpl_provider }),
    });
    return QuoteResponse.parse(wireQuote(r));
  }

  @Post("checkout")
  @HttpCode(201)
  @Authorize(ACTIONS.checkout, self)
  @RateLimit({ budget: RATE_BUDGETS.checkout })
  @Contract({
    operationId: "placeOrder",
    summary: "Place the order: re-quote, price-lock check, reserve stock, one payment intent; returns the client action",
    tags: ["Checkout"],
    body: CheckoutBody,
    response: CheckoutResult,
    status: 201,
    // Quote (cart, stock, credit), reservation (pool top-up on first use), order rows and idempotency: constant in the number of orders; grows with distinct stores and SKUs.
    maxQueries: 60,
  })
  async place(@Ctx() s: RequestState, @Req() req: ApiRequest, @Body() b: z.infer<typeof CheckoutBody>): Promise<z.infer<typeof CheckoutResult>> {
    this.rejectUnsupported(b);
    const m = marketOf(s);
    const userId = userOf(s);
    const quote = readEcho(b.quote_echo);
    if (quote === null) throw Problems.unprocessable("quote-token-invalid");
    const svc = this.deps.checkout(m);
    const placed = await svc.checkout.place(userId, {
      addressRef: b.address_id,
      method: toInternalMethod(b.payment_method),
      ...(b.store_credit === undefined ? {} : { creditRequested: { amountMinor: BigInt(b.store_credit.amount_minor), currency: "EGP" } }),
      ...(b.bnpl_provider === undefined ? {} : { bnplProvider: b.bnpl_provider }),
      idempotencyKey: headerValue(req, "idempotency-key") ?? "",
      quoteToken: b.quote_token,
      quote,
    });
    const g = await svc.orders.detail(userId, placed.orderGroupId);
    return {
      order_group_id: placed.orderGroupId,
      status: placed.status,
      client_action: actionWire(placed.clientAction),
      reservation_expires_at: g?.paymentExpiresAt?.toISOString() ?? null,
    };
  }

  @Get("order-groups")
  @Paginated()
  @Authorize(ACTIONS.orderRead, self)
  @RateLimit({ budget: RATE_BUDGETS.shopperRead })
  @Contract({ operationId: "listMyOrderGroups", summary: "My orders, newest first (keyset)", tags: ["Orders"], query: OrderGroupsQuery, response: OrderGroupSummaryPage, maxQueries: 1 })
  async list(@Ctx() s: RequestState, @Query() q: z.infer<typeof OrderGroupsQuery>): Promise<OrderGroupSummaryPage> {
    const page = await this.deps.checkout(marketOf(s)).orders.list(userOf(s), { limit: q.limit, ...(q.cursor === undefined ? {} : { cursor: q.cursor }), ...(q.status === undefined ? {} : { status: q.status }) });
    return { items: page.items.map((r) => ({ id: r.id, status: r.status, total: mw(r.total), store_count: r.storeCount, placed_at: r.placedAt.toISOString() })), next_cursor: page.nextCursor };
  }

  @Get("order-groups/:order_group_id")
  @Authorize(ACTIONS.orderRead, self)
  @RateLimit({ budget: RATE_BUDGETS.orderGroupRead })
  @Contract({ operationId: "getOrderGroup", summary: "One of my orders (poll after payment: the server is the source of truth)", tags: ["Orders"], params: OrderGroupId, response: OrderGroup, maxQueries: 4 })
  async get(@Ctx() s: RequestState, @Params() p: z.infer<typeof OrderGroupId>): Promise<OrderGroup> {
    const g = await this.deps.checkout(marketOf(s)).orders.detail(userOf(s), p.order_group_id);
    if (g === null) throw Problems.notFound();
    return groupWire(g);
  }

  @Post("order-groups/:order_group_id/cod-confirmation")
  @HttpCode(200)
  @Authorize(ACTIONS.orderConfirm, self)
  @RateLimit({ budget: RATE_BUDGETS.codConfirm })
  @Contract({
    operationId: "confirmCodOrder",
    summary: "Confirm a cash-on-delivery order with the code sent to the shopper (claims the reserved stock)",
    tags: ["Orders"],
    params: OrderGroupId,
    body: CodConfirmationBody,
    response: OrderGroup,
    status: 200,
    maxQueries: 40,
  })
  async confirmCod(@Ctx() s: RequestState, @Params() p: z.infer<typeof OrderGroupId>, @Body() b: z.infer<typeof CodConfirmationBody>): Promise<OrderGroup> {
    const svc = this.deps.checkout(marketOf(s));
    const userId = userOf(s);
    // Ownership first: a foreign or unknown id is 404 before the code is looked at (no oracle on codes of other people's orders).
    if ((await svc.orders.detail(userId, p.order_group_id)) === null) throw Problems.notFound();
    if (!(await svc.cod.verify({ userId, orderGroupId: p.order_group_id, code: b.code }))) throw Problems.unprocessable("cod-code-invalid");
    await svc.checkout.confirmCod(userId, p.order_group_id);
    const g = await svc.orders.detail(userId, p.order_group_id);
    if (g === null) throw Problems.notFound();
    return groupWire(g);
  }

  /**
   * PSP callback. Gates in order: source address (allow-list port), body cap (256 KB, in the preParsing hook), then the provider's HMAC over the
   * RAW bytes inside WebhookProcessor (signature before parse). Answers 2xx only after the event is durably stored; a database failure is a
   * 5xx so the provider retries. A verified event that does not match an order is acknowledged (the provider cannot fix it) and raised internally.
   */
  @Post("webhooks/psp/:provider")
  @HttpCode(200)
  @Public()
  @NoIdempotency("provider events are de-duplicated by (market, provider, provider_event_id) in payment_events_raw, not by a client key")
  @RateLimit({ budget: RATE_BUDGETS.pspWebhook })
  @Contract({
    operationId: "receivePspWebhook",
    summary: "Payment provider webhook (IP allow-list, HMAC over raw bytes, dedup by event id)",
    tags: ["Webhooks"],
    params: ProviderParams,
    body: z.record(z.string(), z.unknown()),
    response: WebhookAck,
    status: 200,
    maxQueries: 0,
  })
  async webhook(@Ctx() s: RequestState, @Req() req: ApiRequest, @Params() p: z.infer<typeof ProviderParams>): Promise<z.infer<typeof WebhookAck>> {
    const svc = this.deps.checkout(marketOf(s));
    if (svc.provider !== p.provider) throw Problems.notFound();
    if (!this.deps.webhookIps.allowed(p.provider, req.ip)) throw Problems.forbidden("webhook-source-denied");
    const raw = s.rawBody;
    if (raw === undefined) throw Problems.badRequest("malformed-request");
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k.toLowerCase()] = v;
    const query: Record<string, string> = {};
    for (const [k, v] of Object.entries((req.query ?? {}) as Record<string, unknown>)) if (typeof v === "string") query[k] = v;
    const out = await svc.webhooks.handle({ rawBody: raw, headers, query, receivedAt: this.deps.clock.now() });
    if (out.outcome === "rejected") {
      if (out.reason === "bad_signature" || out.reason === "stale_timestamp") throw Problems.unauthenticated("webhook-signature-invalid");
      if (out.reason === "malformed") throw Problems.badRequest("webhook-malformed");
    }
    return { received: true, duplicate: out.outcome === "duplicate" };
  }
}
