import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from "@nestjs/common";
import { z } from "zod";
import { Authorize, Idempotent, RateLimit } from "../../../platform/decorators";
import type { ApiRequest } from "../../../platform/http-types";
import { ProblemError, Problems } from "../../../platform/problem";
import { ZodPipe } from "../../../platform/zod.pipe";
import type { DispatchHubParcel, GetHubTracking, RecordHubReceipt } from "../application/hub";
import { RECEIPT_CONDITIONS } from "../domain/bridge";
import type { HubStore } from "../domain/ports";
import { HUB_ADMIN_RESOLVER, HUB_SELLER_RESOLVER, HUB_STORE, DISPATCH_HUB_PARCEL, GET_HUB_TRACKING, HUB_GROUP_RESOLVER, HUB_LEG_RESOLVER, HUB_PARCEL_RESOLVER, RECORD_HUB_RECEIPT } from "./tokens";
import { hubIdsOf, storeIdsOf } from "./resolvers";

const Id = z.uuid();
const ReceiptBody = z.object({ seller_order_id: Id, condition: z.enum(RECEIPT_CONDITIONS).default("ok") }).strict();
const ParcelParam = z.object({ id: Id }).strict();
const GroupParam = z.object({ orderGroupId: Id }).strict();

const ADMIN_ROLES = ["ops", "finance", "trust_safety", "super_admin"] as const;
const Limit = z.coerce.number().int().min(1).max(50).default(50);
const AdminQuery = z.object({ limit: Limit, cursor: z.string().min(1).max(200).optional() }).strict();
const SellerQuery = z.object({ limit: Limit, cursor: z.string().min(1).max(200).optional(), order_group_id: Id.optional() }).strict();
const AdminCursor = z.object({ t: z.number().int(), id: Id }).strict();
const invalidCursor = (): ProblemError => Problems.validation([{ pointer: "/query/cursor", code: "invalid_cursor" }]);
const enc = (o: object): string => Buffer.from(JSON.stringify(o)).toString("base64url");
function dec<T>(raw: string, schema: z.ZodType<T>): T {
  try {
    return schema.parse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
  } catch {
    throw invalidCursor();
  }
}
const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

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
    @Inject(HUB_STORE) private readonly store: HubStore,
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

  @Get("admin/hub/consolidations")
  @Authorize({ audience: "admin_api", action: "read", resourceType: "admin_console", resolver: HUB_ADMIN_RESOLVER, idParam: "none" })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async adminList(@Req() req: ApiRequest, @Query(new ZodPipe(AdminQuery, "/query")) q: z.infer<typeof AdminQuery>) {
    const ok = principalOf(req).actor.grants.some((g) => g.kind === "admin" && (ADMIN_ROLES as readonly string[]).includes(g.role));
    if (!ok) throw Problems.forbidden();
    const c = q.cursor === undefined ? null : dec(q.cursor, AdminCursor);
    const rows = await this.store.listParcelsPage(q.limit + 1, c === null ? null : { createdAtMs: c.t, id: c.id.toLowerCase() });
    const items = rows.slice(0, q.limit);
    const last = items[items.length - 1];
    const next = rows.length > q.limit && last !== undefined ? enc({ t: last.createdAtMs, id: last.id }) : null;
    return {
      items: items.map((p) => ({
        id: p.id,
        order_group_id: p.orderGroupId,
        hub_id: p.hubId,
        status: p.status,
        awb: p.awb,
        courier: p.courierCode,
        seller_order_count: p.sellerOrderIds.length,
        shopper_fee: { amount_minor: p.shopperFee.toString(), currency: "EGP" },
        gco2e_estimate: p.gCo2e === null ? null : p.gCo2e.toString(),
        is_estimate: true,
        created_at: iso(p.createdAtMs),
        dispatched_at: iso(p.dispatchedAtMs),
      })),
      page: { next_cursor: next, has_more: next !== null },
    };
  }

  /** Seller view: the caller's own seller orders only; no buyer name, phone or address ever (spec). */
  @Get("seller/hub/consolidations")
  @Authorize({ audience: "seller_api", action: "read", resourceType: "store_order", resolver: HUB_SELLER_RESOLVER, idParam: "none" })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async sellerList(@Req() req: ApiRequest, @Query(new ZodPipe(SellerQuery, "/query")) q: z.infer<typeof SellerQuery>) {
    const afterId = q.cursor === undefined ? null : dec(q.cursor, z.object({ id: Id }).strict()).id.toLowerCase();
    const rows = await this.store.listLegsForStores({
      storeIds: storeIdsOf(principalOf(req).actor),
      orderGroupId: q.order_group_id === undefined ? null : q.order_group_id.toLowerCase(),
      limit: q.limit + 1,
      afterId,
    });
    const legs = rows.slice(0, q.limit);
    const items = await Promise.all(
      legs.map(async (l) => {
        const parcel = l.consolidationId === null ? null : await this.store.getParcel(l.consolidationId);
        return {
          seller_order_id: l.sellerOrderId,
          order_group_id: l.orderGroupId,
          store_id: l.storeId,
          state: l.state,
          handoff_due_at: iso(l.handoffDueAtMs),
          parcel: parcel === null ? null : { id: parcel.id, status: parcel.status, awb: parcel.awb, courier: parcel.courierCode },
        };
      }),
    );
    const last = legs[legs.length - 1];
    const next = rows.length > q.limit && last !== undefined ? enc({ id: last.sellerOrderId }) : null;
    return { items, page: { next_cursor: next, has_more: next !== null } };
  }
}
