import { Controller, Get, HttpCode, Inject, Post } from "@nestjs/common";
import { Authorize, Contract, Paginated, RateLimit } from "../../platform/decorators.js";
import { API_DEPS } from "../../platform/deps.js";
import type { ApiDeps, SellerOrdersServices } from "../../platform/deps.js";
import type { RequestState } from "../../platform/http.js";
import { Problems } from "../../platform/problem.js";
import { RATE_BUDGETS } from "../../platform/rate-limit/budgets.js";
import { activeStore } from "../../platform/resolvers.js";
import { Body, Ctx, Params, Query } from "../../platform/validation.js";
import { EmptyBody, RejectInput, SellerCancelInput, SellerOrder, SellerOrderIdParams, SellerOrderSummaryPage, SellerOrdersQuery, Shipment, ShipmentCreateInput } from "./dto.js";
import type { Principal } from "@outlet/policy";

interface Tenant { readonly principal: Principal; readonly storeId: string; readonly svc: SellerOrdersServices["orders"] }

/**
 * Seller Center orders (store tenant: X-Store-Id, passkey session, role from @outlet/policy SELLER_POLICY: order.read for the
 * list and detail, order.fulfill for accept, reject, pack and ship; finance and support are read-only).
 */
@Controller("v1/:market/seller")
export class SellerOrdersController {
  constructor(@Inject(API_DEPS) private readonly deps: ApiDeps) {}

  private tenant(s: RequestState): Tenant {
    if (s.principal === undefined || s.storeId === undefined || s.marketId === undefined) throw Problems.internal("tenant-context-missing");
    return { principal: s.principal, storeId: s.storeId, svc: this.deps.sellerOrders(s.marketId).orders };
  }

  @Get("orders")
  @Paginated()
  @Authorize("order.read", activeStore, { tenant: "store" })
  @RateLimit({ budget: RATE_BUDGETS.sellerRead })
  @Contract({ operationId: "listSellerOrders", summary: "Orders for my store (status, date filters)", tags: ["Seller Orders"], query: SellerOrdersQuery, response: SellerOrderSummaryPage, maxQueries: 2 })
  list(@Ctx() s: RequestState, @Query() q: SellerOrdersQuery): Promise<SellerOrderSummaryPage> {
    const t = this.tenant(s);
    return t.svc.list(t.principal, t.storeId, q);
  }

  @Get("orders/:seller_order_id")
  @Authorize("order.read", activeStore, { tenant: "store" })
  @RateLimit({ budget: RATE_BUDGETS.sellerRead })
  @Contract({ operationId: "getSellerOrder", summary: "One order (delivery data only while the access window is open, phone masked)", tags: ["Seller Orders"], params: SellerOrderIdParams, response: SellerOrder, maxQueries: 6 })
  get(@Ctx() s: RequestState, @Params() p: SellerOrderIdParams): Promise<SellerOrder> {
    const t = this.tenant(s);
    return t.svc.get(t.principal, t.storeId, p.seller_order_id);
  }

  @Post("orders/:seller_order_id/accept")
  @HttpCode(200)
  @Authorize("order.fulfill", activeStore, { tenant: "store" })
  @RateLimit({ budget: RATE_BUDGETS.sellerWrite })
  @Contract({ operationId: "acceptSellerOrder", summary: "Accept (PAID or CONFIRMED_COD to ACCEPTED); starts the 48 h dispatch SLA", tags: ["Seller Orders"], params: SellerOrderIdParams, body: EmptyBody, response: SellerOrder, maxQueries: 14 })
  accept(@Ctx() s: RequestState, @Params() p: SellerOrderIdParams): Promise<SellerOrder> {
    const t = this.tenant(s);
    return t.svc.accept(t.principal, t.storeId, p.seller_order_id);
  }

  @Post("orders/:seller_order_id/reject")
  @HttpCode(200)
  @Authorize("order.fulfill", activeStore, { tenant: "store" })
  @RateLimit({ budget: RATE_BUDGETS.sellerWrite })
  @Contract({ operationId: "rejectSellerOrder", summary: "Reject (REJECTED_BY_SELLER); emits seller_order.rejected for the partial-refund saga", tags: ["Seller Orders"], params: SellerOrderIdParams, body: RejectInput, response: SellerOrder, maxQueries: 14 })
  reject(@Ctx() s: RequestState, @Params() p: SellerOrderIdParams, @Body() body: RejectInput): Promise<SellerOrder> {
    const t = this.tenant(s);
    return t.svc.reject(t.principal, t.storeId, p.seller_order_id, body);
  }

  @Post("orders/:seller_order_id/cancel")
  @HttpCode(200)
  @Authorize("order.fulfill", activeStore, { tenant: "store" })
  @RateLimit({ budget: RATE_BUDGETS.sellerWrite })
  @Contract({ operationId: "cancelSellerOrder", summary: "Cancel before shipping (PAID to PACKED); fixed reason code; refunds the shopper and cancels a created AWB", tags: ["Seller Orders"], params: SellerOrderIdParams, body: SellerCancelInput, response: SellerOrder, maxQueries: 30 })
  cancel(@Ctx() s: RequestState, @Params() p: SellerOrderIdParams, @Body() body: SellerCancelInput): Promise<SellerOrder> {
    const t = this.tenant(s);
    return t.svc.cancel(t.principal, t.storeId, p.seller_order_id, body);
  }

  @Post("orders/:seller_order_id/pack")
  @HttpCode(200)
  @Authorize("order.fulfill", activeStore, { tenant: "store" })
  @RateLimit({ budget: RATE_BUDGETS.sellerWrite })
  @Contract({ operationId: "packSellerOrder", summary: "Mark packed (ACCEPTED to PACKED)", tags: ["Seller Orders"], params: SellerOrderIdParams, body: EmptyBody, response: SellerOrder, maxQueries: 14 })
  pack(@Ctx() s: RequestState, @Params() p: SellerOrderIdParams): Promise<SellerOrder> {
    const t = this.tenant(s);
    return t.svc.pack(t.principal, t.storeId, p.seller_order_id);
  }

  @Post("shipments")
  @HttpCode(201)
  @Authorize("order.fulfill", activeStore, { tenant: "store" })
  @RateLimit({ budget: RATE_BUDGETS.sellerWrite })
  @Contract({
    operationId: "createShipment",
    summary: "Create the shipment and request the AWB (PACKED to SHIPPED); 503 while no courier is configured",
    tags: ["Seller Shipments"],
    body: ShipmentCreateInput,
    response: Shipment,
    status: 201,
    maxQueries: 22,
  })
  ship(@Ctx() s: RequestState, @Body() body: ShipmentCreateInput): Promise<Shipment> {
    const t = this.tenant(s);
    return t.svc.ship(t.principal, t.storeId, body);
  }
}
