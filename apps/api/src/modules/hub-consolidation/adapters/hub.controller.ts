import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req } from "@nestjs/common";
import { z } from "zod";
import { Authorize, Idempotent, RateLimit } from "../../../platform/decorators";
import type { ApiRequest } from "../../../platform/http-types";
import { ProblemError, Problems } from "../../../platform/problem";
import { ZodPipe } from "../../../platform/zod.pipe";
import type { DispatchHubParcel, GetHubTracking, RecordHubReceipt } from "../application/hub";
import { RECEIPT_CONDITIONS } from "../domain/bridge";
import { DISPATCH_HUB_PARCEL, GET_HUB_TRACKING, HUB_GROUP_RESOLVER, HUB_LEG_RESOLVER, HUB_PARCEL_RESOLVER, RECORD_HUB_RECEIPT } from "./tokens";
import { hubIdsOf } from "./resolvers";

const Id = z.uuid();
const ReceiptBody = z.object({ seller_order_id: Id, condition: z.enum(RECEIPT_CONDITIONS).default("ok") }).strict();
const ParcelParam = z.object({ id: Id }).strict();
const GroupParam = z.object({ orderGroupId: Id }).strict();

const principalOf = (req: ApiRequest) => {
  const p = req.principal;
  if (p === null || p === undefined) throw Problems.unauthenticated();
  return p;
};

/**
 * Hub operators sign in on the admin audience with a `courier` grant carrying their hub (there is
 * no separate hub audience yet; see the module spec build notes).
 */
@Controller()
export class HubController {
  constructor(
    @Inject(RECORD_HUB_RECEIPT) private readonly receipt: RecordHubReceipt,
    @Inject(DISPATCH_HUB_PARCEL) private readonly dispatch: DispatchHubParcel,
    @Inject(GET_HUB_TRACKING) private readonly tracking: GetHubTracking,
  ) {}

  @Post("hub/receipts")
  @HttpCode(200)
  @Authorize({ audience: "admin_api", action: "update", resourceType: "courier_task", resolver: HUB_LEG_RESOLVER, idParam: "none" })
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async record(@Req() req: ApiRequest, @Body(new ZodPipe(ReceiptBody)) b: z.infer<typeof ReceiptBody>) {
    const actor = principalOf(req).actor;
    const r = await this.receipt.execute({
      sellerOrderId: b.seller_order_id.toLowerCase(),
      operatorId: actor.id,
      hubIds: hubIdsOf(actor),
      condition: b.condition,
    });
    switch (r.kind) {
      case "recorded":
        return { seller_order_id: b.seller_order_id.toLowerCase(), state: r.state, duplicate: r.duplicate, consolidation_id: r.parcelId };
      case "not_found":
        throw Problems.notFound();
      case "wrong_state":
        throw new ProblemError(409, "invalid-transition", "The seller order is not expected at the hub", { code: "invalid_transition" });
      case "conflict":
        throw new ProblemError(409, "conflict", "The seller order changed; retry", { code: "conflict" });
    }
  }

  @Post("hub/consolidations/:id/dispatch")
  @HttpCode(200)
  @Authorize({ audience: "admin_api", action: "update", resourceType: "courier_task", resolver: HUB_PARCEL_RESOLVER, idParam: "id" })
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async dispatchParcel(@Param(new ZodPipe(ParcelParam, "/params")) p: z.infer<typeof ParcelParam>) {
    const r = await this.dispatch.execute(p.id.toLowerCase());
    switch (r.kind) {
      case "dispatched":
        return {
          id: r.parcel.id,
          status: "dispatched",
          awb: r.parcel.awb,
          courier: r.parcel.courierCode,
          gco2e_estimate: r.parcel.gCo2e === null ? null : r.parcel.gCo2e.toString(),
          is_estimate: true,
        };
      case "not_found":
      case "no_facts":
        throw Problems.notFound();
      case "courier_unavailable":
        throw Problems.unavailable("courier_unavailable");
      case "courier_rejected":
        throw new ProblemError(422, "courier-rejected", "The courier rejected the parcel", { code: r.code });
    }
  }

  @Get("me/orders/:orderGroupId/tracking")
  @Authorize({ action: "read", resourceType: "order", resolver: HUB_GROUP_RESOLVER, idParam: "orderGroupId" })
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async track(@Param(new ZodPipe(GroupParam, "/params")) p: z.infer<typeof GroupParam>) {
    const v = await this.tracking.execute(p.orderGroupId.toLowerCase());
    if (v === null) throw Problems.notFound();
    return {
      order_group_id: v.orderGroupId,
      delivery_fee_piastres: v.deliveryFee.toString(),
      waiting_seller_orders: v.waitingSellerOrders,
      parcels: v.parcels.map((x) => ({
        id: x.id,
        status: x.status,
        awb: x.awb,
        courier: x.courierCode,
        seller_order_count: x.sellerOrderCount,
        fee_charged_piastres: x.shopperFee.toString(),
      })),
    };
  }
}
