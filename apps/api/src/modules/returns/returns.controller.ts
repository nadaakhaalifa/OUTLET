import { Controller, Get, HttpCode, Inject, Post, Req } from "@nestjs/common";
import { ReturnsError } from "@outlet/returns";
import { z } from "zod";
import { Authorize, Contract, Paginated, RateLimit } from "../../platform/decorators.js";
import { API_DEPS } from "../../platform/deps.js";
import type { ApiDeps } from "../../platform/deps.js";
import { headerValue } from "../../platform/http.js";
import type { ApiRequest, RequestState } from "../../platform/http.js";
import { Problems } from "../../platform/problem.js";
import { RATE_BUDGETS } from "../../platform/rate-limit/budgets.js";
import { activeStore, self } from "../../platform/resolvers.js";
import { Body, Ctx, Params, Query } from "../../platform/validation.js";
import { groupWire } from "../checkout/checkout.controller.js";
import { OrderGroup } from "../checkout/dto.js";
import {
  CancelInput, Dispute, EmptyBody, DisputeInput, InspectionInput, OrderGroupIdParams, REASON_TO_PACKAGE, ReturnIdParams, ReturnRequest, ReturnRequestInput, ReturnRequestPage, ReturnsQuery, SellerOrderIdParams,
} from "./dto.js";
import type { ReturnRow, ReturnsServices } from "./services.js";

const wire = (r: ReturnRow): ReturnRequest => ({
  id: r.id,
  seller_order_id: r.sellerOrderId,
  status: r.status as ReturnRequest["status"],
  reason_code: r.reasonCode,
  fault: r.fault as ReturnRequest["fault"],
  window_basis: r.windowBasis === "defect_30d" ? "defect" : "no_reason",
  delivered_at_snapshot: r.deliveredAtSnapshot.toISOString(),
  window_ends_at: r.windowEndsAt.toISOString(),
  method: r.method as ReturnRequest["method"],
  resolution: r.resolution === "exchange" ? "exchange" : "refund",
  lines: r.lines.map((l) => ({ id: l.id, order_line_id: l.orderLineId, qty: l.qty, item_unit_id: null, condition_received: l.conditionReceived, restock_decision: l.restockDecision })),
  rejection_reason: r.rejectionReason,
  received_at: r.receivedAt?.toISOString() ?? null,
  inspection_due_at: r.inspectionDueAt?.toISOString() ?? null,
  refund_due_at: r.refundDueAt?.toISOString() ?? null,
  created_at: r.createdAt.toISOString(),
});

/** Seller-order states from which a shopper may still cancel for free (before SHIPPED, section 20.1) and the terminal ones that do not block a group cancel. */
const CANCELLABLE = new Set(["PENDING_PAYMENT", "PAID", "CONFIRMED_COD", "ACCEPTED", "PACKED"]);
const SETTLED_UNSHIPPED = new Set(["CANCELLED", "REJECTED_BY_SELLER", "VOIDED"]);
const CANCELLABLE_GROUP = new Set(["PENDING_PAYMENT", "AWAITING_COD_CONFIRMATION", "PAID", "CONFIRMED_COD"]);

/**
 * Returns, disputes and shopper cancellation (shopper routes on the user context; seller routes on the store context with policy
 * return.read / return.inspect). The package decides eligibility; windows count from the courier-confirmed delivered_at.
 */
@Controller("v1/:market")
export class ReturnsController {
  constructor(@Inject(API_DEPS) private readonly deps: ApiDeps) {}

  private user(s: RequestState): { readonly userId: string; readonly marketId: string; readonly svc: ReturnsServices } {
    if (s.user === undefined) throw Problems.unauthenticated();
    if (s.marketId === undefined) throw Problems.notFound("unknown-market");
    return { userId: s.user.userId, marketId: s.marketId, svc: this.deps.returns(s.marketId) };
  }

  private store(s: RequestState): { readonly principal: NonNullable<RequestState["principal"]>; readonly storeId: string; readonly svc: ReturnsServices } {
    if (s.principal === undefined || s.storeId === undefined || s.marketId === undefined) throw Problems.internal("tenant-context-missing");
    return { principal: s.principal, storeId: s.storeId, svc: this.deps.returns(s.marketId) };
  }

  @Post("seller-orders/:seller_order_id/returns")
  @HttpCode(201)
  @Authorize("return.create", self)
  @RateLimit({ budget: RATE_BUDGETS.shopperWrite })
  @Contract({
    operationId: "createReturn",
    summary: "Request a return or exchange (window from the courier-confirmed delivered_at; photos required for defect and not-as-described)",
    tags: ["Returns"],
    params: SellerOrderIdParams,
    body: ReturnRequestInput,
    response: ReturnRequest,
    status: 201,
    maxQueries: 24,
  })
  async create(@Ctx() s: RequestState, @Req() req: ApiRequest, @Params() p: SellerOrderIdParams, @Body() b: z.infer<typeof ReturnRequestInput>): Promise<ReturnRequest> {
    const u = this.user(s);
    if (!(await u.svc.reader.linesBelong(u.userId, p.seller_order_id, b.lines.map((l) => l.order_line_id)))) throw Problems.notFound();
    const view = await u.svc.returns.request(u.userId, {
      items: b.lines.map((l) => ({ orderLineId: l.order_line_id, qty: l.qty })),
      reason: REASON_TO_PACKAGE[b.reason_code],
      method: b.method,
      evidenceMediaIds: b.evidence_media_ids ?? [],
      refundChoice: b.refund_preference ?? null,
      preferRefund: b.resolution === "refund",
      idempotencyKey: headerValue(req, "idempotency-key") ?? "",
    });
    const row = await u.svc.reader.getOwn(u.userId, view.id);
    if (row === null) throw Problems.internal("return-missing-after-create");
    return wire(row);
  }

  @Get("returns")
  @Paginated()
  @Authorize("return.read", self)
  @RateLimit({ budget: RATE_BUDGETS.shopperRead })
  @Contract({ operationId: "listMyReturns", summary: "My returns, newest first (keyset)", tags: ["Returns"], query: ReturnsQuery, response: ReturnRequestPage, maxQueries: 3 })
  async list(@Ctx() s: RequestState, @Query() q: z.infer<typeof ReturnsQuery>): Promise<ReturnRequestPage> {
    const u = this.user(s);
    const page = await u.svc.reader.listOwn(u.userId, { limit: q.limit, ...(q.cursor === undefined ? {} : { cursor: q.cursor }), ...(q.status === undefined ? {} : { status: q.status }) });
    return { items: page.items.map(wire), next_cursor: page.nextCursor };
  }

  @Get("returns/:return_id")
  @Authorize("return.read", self)
  @RateLimit({ budget: RATE_BUDGETS.shopperRead })
  @Contract({ operationId: "getMyReturn", summary: "One of my returns (another shopper's id is 404)", tags: ["Returns"], params: ReturnIdParams, response: ReturnRequest, maxQueries: 3 })
  async get(@Ctx() s: RequestState, @Params() p: ReturnIdParams): Promise<ReturnRequest> {
    const u = this.user(s);
    const row = await u.svc.reader.getOwn(u.userId, p.return_id);
    if (row === null) throw Problems.notFound();
    return wire(row);
  }

  @Post("returns/:return_id/cancel")
  @HttpCode(200)
  @Authorize("return.create", self)
  @RateLimit({ budget: RATE_BUDGETS.shopperWrite })
  @Contract({ operationId: "cancelMyReturn", summary: "Cancel a return before the parcel is handed over (409 afterwards)", tags: ["Returns"], params: ReturnIdParams, body: EmptyBody, response: ReturnRequest, maxQueries: 8 })
  async cancel(@Ctx() s: RequestState, @Params() p: ReturnIdParams): Promise<ReturnRequest> {
    const u = this.user(s);
    await u.svc.returns.cancel(u.userId, p.return_id);
    const row = await u.svc.reader.getOwn(u.userId, p.return_id);
    if (row === null) throw Problems.notFound();
    return wire(row);
  }

  @Post("returns/:return_id/dispute")
  @HttpCode(201)
  @Authorize("return.create", self)
  @RateLimit({ budget: RATE_BUDGETS.shopperWrite })
  @Contract({ operationId: "openReturnDispute", summary: "Dispute a rejected or stalled return (human review within 5 business days)", tags: ["Returns"], params: ReturnIdParams, body: DisputeInput, response: Dispute, status: 201, maxQueries: 8 })
  async dispute(@Ctx() s: RequestState, @Params() p: ReturnIdParams, @Body() b: z.infer<typeof DisputeInput>): Promise<Dispute> {
    const u = this.user(s);
    if ((b.media_ids?.length ?? 0) > 0) throw Problems.unprocessable("dispute-evidence-unsupported", [{ path: "/body/media_ids", code: "unsupported" }]);
    const row = await u.svc.reader.getOwn(u.userId, p.return_id);
    if (row === null) throw Problems.notFound();
    const d = await u.svc.returns.openDispute(u.userId, p.return_id, { reasonCode: b.reason_code ?? (row.status === "REJECTED" ? "rejection_unjustified" : "other"), note: b.statement });
    return { id: d.disputeId, return_request_id: p.return_id, status: "OPEN", sla_due_at: d.slaDueAt, created_at: this.deps.clock.now().toISOString(), resolved_at: null };
  }

  @Post("order-groups/:order_group_id/cancel")
  @HttpCode(200)
  @Authorize("order.cancel", self)
  @RateLimit({ budget: RATE_BUDGETS.shopperWrite })
  @Contract({
    operationId: "cancelOrderGroup",
    summary: "Cancel an order before it ships (409 once any store has shipped); 503 until the cancellation refund saga is configured",
    tags: ["Orders"],
    params: OrderGroupIdParams,
    body: CancelInput,
    response: OrderGroup,
    maxQueries: 8,
  })
  async cancelOrder(@Ctx() s: RequestState, @Params() p: OrderGroupIdParams, @Body() b: z.infer<typeof CancelInput>): Promise<OrderGroup> {
    const u = this.user(s);
    const orders = this.deps.checkout(u.marketId).orders;
    const g = await orders.detail(u.userId, p.order_group_id);
    if (g === null) throw Problems.notFound();
    if (g.sellerOrders.some((o) => !CANCELLABLE.has(o.status) && !SETTLED_UNSHIPPED.has(o.status))) throw Problems.conflict("cancel-after-shipping");
    if (!CANCELLABLE_GROUP.has(g.status) || !g.sellerOrders.some((o) => CANCELLABLE.has(o.status))) throw Problems.conflict("order-not-cancellable");
    await u.svc.cancellation.cancel({ userId: u.userId, orderGroupId: p.order_group_id, reasonCode: b.reason_code, refundPreference: b.refund_preference });
    const after = await orders.detail(u.userId, p.order_group_id);
    if (after === null) throw Problems.notFound();
    return groupWire(after);
  }

  @Get("seller/returns")
  @Paginated()
  @Authorize("return.read", activeStore, { tenant: "store" })
  @RateLimit({ budget: RATE_BUDGETS.sellerRead })
  @Contract({ operationId: "listSellerReturns", summary: "Returns of my store (RLS: only this store's)", tags: ["Seller Returns"], query: ReturnsQuery, response: ReturnRequestPage, maxQueries: 3 })
  async sellerList(@Ctx() s: RequestState, @Query() q: z.infer<typeof ReturnsQuery>): Promise<ReturnRequestPage> {
    const t = this.store(s);
    const page = await t.svc.reader.listStore(t.storeId, { limit: q.limit, ...(q.cursor === undefined ? {} : { cursor: q.cursor }), ...(q.status === undefined ? {} : { status: q.status }) });
    return { items: page.items.map(wire), next_cursor: page.nextCursor };
  }

  @Get("seller/returns/:return_id")
  @Authorize("return.read", activeStore, { tenant: "store" })
  @RateLimit({ budget: RATE_BUDGETS.sellerRead })
  @Contract({ operationId: "getSellerReturn", summary: "One return of my store (another store's id is 404)", tags: ["Seller Returns"], params: ReturnIdParams, response: ReturnRequest, maxQueries: 3 })
  async sellerGet(@Ctx() s: RequestState, @Params() p: ReturnIdParams): Promise<ReturnRequest> {
    const t = this.store(s);
    const row = await t.svc.reader.getStore(t.storeId, p.return_id);
    if (row === null) throw Problems.notFound();
    return wire(row);
  }

  @Post("seller/returns/:return_id/inspect")
  @HttpCode(200)
  @Authorize("return.inspect", activeStore, { tenant: "store" })
  @RateLimit({ budget: RATE_BUDGETS.sellerWrite })
  @Contract({ operationId: "inspectReturn", summary: "Inspect a received return (accept emits return.accepted; a rejection needs a reason; 409 unless RECEIVED)", tags: ["Seller Returns"], params: ReturnIdParams, body: InspectionInput, response: ReturnRequest, maxQueries: 20 })
  async inspect(@Ctx() s: RequestState, @Params() p: ReturnIdParams, @Body() b: z.infer<typeof InspectionInput>): Promise<ReturnRequest> {
    const t = this.store(s);
    if ((b.media_ids?.length ?? 0) > 0) throw Problems.unprocessable("inspection-evidence-unsupported", [{ path: "/body/media_ids", code: "unsupported" }]);
    const row = await t.svc.reader.getStore(t.storeId, p.return_id);
    if (row === null) throw Problems.notFound();
    const items = b.lines.map((l) => {
      const line = row.lines.find((x) => x.id === l.return_line_id);
      if (line === undefined) throw new ReturnsError("not_found");
      return { orderLineId: line.orderLineId, condition: l.condition_received, restock: l.restock_decision };
    });
    await t.svc.returns.inspect(t.principal, t.storeId, p.return_id, {
      result: b.result,
      ...(b.result === "rejected" ? { reasonCode: b.reason_code ?? "inspection_rejected" } : b.reason_code === undefined ? {} : { reasonCode: b.reason_code }),
      ...(b.notes === undefined ? {} : { notes: b.notes }),
      items,
    });
    const after = await t.svc.reader.getStore(t.storeId, p.return_id);
    if (after === null) throw Problems.notFound();
    return wire(after);
  }
}
