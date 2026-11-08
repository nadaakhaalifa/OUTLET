import { Controller, Get, HttpCode, Inject, Post, Req } from "@nestjs/common";
import { z } from "zod";
import { Authorize, Contract, NoIdempotency, Public, RateLimit } from "../../platform/decorators.js";
import { API_DEPS } from "../../platform/deps.js";
import type { ApiDeps } from "../../platform/deps.js";
import type { ApiRequest, RequestState } from "../../platform/http.js";
import { Problems } from "../../platform/problem.js";
import { RATE_BUDGETS } from "../../platform/rate-limit/budgets.js";
import { self } from "../../platform/resolvers.js";
import { Ctx, Params } from "../../platform/validation.js";
import { CourierParams, CourierWebhookAck, OrderGroupIdParams, OrderTracking } from "./dto.js";

const marketOf = (s: RequestState): string => {
  if (s.marketId === undefined) throw Problems.notFound("unknown-market");
  return s.marketId;
};

/** Key of the courier in the shared IP allow-list (PSP codes live in the same map; the prefix keeps them apart). */
export const courierIpKey = (code: string): string => `courier:${code}`;

@Controller("v1/:market")
export class TrackingController {
  constructor(@Inject(API_DEPS) private readonly deps: ApiDeps) {}

  @Get("order-groups/:order_group_id/tracking")
  @Authorize("order.read", self)
  @RateLimit({ budget: RATE_BUDGETS.orderGroupRead })
  @Contract({ operationId: "getOrderTracking", summary: "Shipments of one of my orders with their normalised status (no courier raw data)", tags: ["Orders"], params: OrderGroupIdParams, response: OrderTracking, maxQueries: 3 })
  async tracking(@Ctx() s: RequestState, @Params() p: OrderGroupIdParams): Promise<OrderTracking> {
    if (s.user === undefined) throw Problems.unauthenticated();
    const rows = await this.deps.tracking(marketOf(s)).tracking.forOrderGroup(s.user.userId, p.order_group_id);
    if (rows === null) throw Problems.notFound();
    return {
      order_group_id: p.order_group_id,
      shipments: rows.map((r) => ({
        id: r.id,
        seller_order_ids: [...r.sellerOrderIds],
        courier: r.courier,
        awb: r.awb,
        status: r.status as OrderTracking["shipments"][number]["status"],
        attempts: r.attempts,
        delivered_at: r.deliveredAt?.toISOString() ?? null,
        latest_event: r.lastEventAt === null ? null : { status: r.status, occurred_at: r.lastEventAt.toISOString() },
      })),
      server_time: this.deps.clock.now().toISOString(),
    };
  }

  /**
   * Courier tracking callback. Gates in order: courier code (404), source address (allow-list port, 403), body cap (256 KB, preParsing hook),
   * then the courier's signature over the RAW bytes inside CourierWebhookProcessor (bad signature: the body is stored flagged, nothing else
   * changes, 401). Events are de-duplicated by the courier event id, so a replay changes no state.
   */
  @Post("webhooks/couriers/:courier_code")
  @HttpCode(200)
  @Public()
  @NoIdempotency("courier events are de-duplicated by (courier, courier_event_id) in courier_events_raw, not by a client key")
  @RateLimit({ budget: RATE_BUDGETS.pspWebhook })
  @Contract({
    operationId: "receiveCourierWebhook",
    summary: "Courier tracking webhook (IP allow-list, signature over raw bytes, dedup by event id)",
    tags: ["Webhooks"],
    params: CourierParams,
    body: z.record(z.string(), z.unknown()),
    response: CourierWebhookAck,
    status: 200,
    maxQueries: 0,
  })
  async webhook(@Ctx() s: RequestState, @Req() req: ApiRequest, @Params() p: CourierParams): Promise<CourierWebhookAck> {
    const svc = this.deps.tracking(marketOf(s));
    if (svc.courierCode !== p.courier_code) throw Problems.notFound();
    if (!this.deps.webhookIps.allowed(courierIpKey(p.courier_code), req.ip)) throw Problems.forbidden("webhook-source-denied");
    const raw = s.rawBody;
    if (raw === undefined) throw Problems.badRequest("malformed-request");
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k.toLowerCase()] = v;
    const out = await svc.webhooks.handle(Buffer.from(raw).toString("utf8"), headers);
    if (!out.accepted) throw Problems.unauthenticated("webhook-signature-invalid");
    return { received: true, duplicate: out.outcomes.length > 0 && out.outcomes.every((o) => o.outcome === "duplicate") };
  }
}
