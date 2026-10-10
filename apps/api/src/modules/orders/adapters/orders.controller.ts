import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req, Res } from "@nestjs/common";
import { sha256Hex } from "@outlet/idempotency";
import { z } from "zod";
import { Authorize, AuthenticatedSelf, Idempotent, RateLimit } from "../../../platform/decorators";
import { headerValue, type ApiRequest, type ApiResponse } from "../../../platform/http-types";
import { ProblemError, Problems } from "../../../platform/problem";
import { ZodPipe } from "../../../platform/zod.pipe";
import { REJECT_REASONS, SELLER_ORDER_STATES, SHOPPER_CANCEL_REASONS } from "../domain/bridge";
import type { CommandResult, OrderCommands } from "../application/commands";
import type { GetOrderGroup, GetSellerOrder, ListSellerOrders } from "../application/queries";
import type { OrderScope, StoreLookupPort } from "../domain/ports";
import { OrderStoreAccess } from "./store-access";
import {
  GET_ORDER_GROUP,
  GET_SELLER_ORDER,
  LIST_SELLER_ORDERS,
  ORDER_COMMANDS,
  ORDER_GROUP_RESOLVER,
  ORDER_STORE_LOOKUP,
  ORDERS_NOW,
  SELLER_ORDER_RESOLVER,
  SHOPPER_ORDER_RESOLVER,
} from "./tokens";
import { orderGroupWire, sellerOrderViewWire, shopperSellerOrderWire } from "./wire";

const IdParam = z.object({ id: z.uuid() }).strict();
const RejectBody = z
  .object({ reason: z.enum(REJECT_REASONS), note: z.string().max(500).optional() })
  .strict();
const CancelBody = z
  .object({ reason: z.enum(SHOPPER_CANCEL_REASONS), note: z.string().max(500).optional() })
  .strict();
const ListQuery = z
  .object({
    status: z.enum(SELLER_ORDER_STATES).optional(),
    cursor: z.string().max(512).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();
const CursorBody = z.object({ c: z.number().int().nonnegative().max(8.64e15), i: z.uuid() }).strict();

const etagOf = (wire: unknown): string => `"${sha256Hex(JSON.stringify(wire)).slice(0, 32)}"`;
const matches = (header: string | undefined, etag: string): boolean =>
  header !== undefined && header.split(",").map((t) => t.trim()).some((t) => t === etag || t === `W/${etag}` || t === "*");

function principalOf(req: ApiRequest) {
  const p = req.principal;
  if (p === null || p === undefined) throw Problems.unauthenticated();
  return p;
}

function requireKey(req: ApiRequest): string {
  const k = headerValue(req, "idempotency-key");
  if (k === undefined) throw Problems.invalidIdempotencyKey();
  return k;
}

const conflict = (slug: string, title: string, code: string) => new ProblemError(409, slug, title, { code });

/** Maps a command outcome to its HTTP problem, or returns the order. */
function unwrap(r: CommandResult) {
  switch (r.kind) {
    case "ok":
      return r;
    case "not_found":
      throw Problems.notFound();
    case "conflict":
      throw conflict("order-conflict", "The order changed; reload and retry", "order_conflict");
    case "invalid_transition":
      throw conflict("invalid-transition", "That action is not possible for this order's status", "invalid_transition");
    case "accept_window_elapsed":
      throw conflict("accept-window-elapsed", "The acceptance window has elapsed", "accept_window_elapsed");
    case "not_cancellable":
      throw conflict("not-cancellable", "The order can no longer be cancelled", "not_cancellable");
  }
}

function decodeCursor(raw: string | undefined): { createdAtMs: number; id: string } | null {
  if (raw === undefined) return null;
  try {
    const parsed = CursorBody.parse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
    return { createdAtMs: parsed.c, id: parsed.i };
  } catch {
    throw Problems.validation([{ pointer: "/query/cursor", code: "invalid_cursor" }]);
  }
}
const encodeCursor = (c: { createdAtMs: number; id: string }): string =>
  Buffer.from(JSON.stringify({ c: c.createdAtMs, i: c.id })).toString("base64url");

// --------------------------------------------------------------------------- shopper

@Controller()
export class ShopperOrdersController {
  constructor(
    @Inject(GET_ORDER_GROUP) private readonly getGroup: GetOrderGroup,
    @Inject(ORDER_COMMANDS) private readonly commands: OrderCommands,
    @Inject(ORDER_STORE_LOOKUP) private readonly storeLookup: StoreLookupPort,
  ) {}

  @Get("order-groups/:id")
  @Authorize({ action: "read", resourceType: "order", resolver: ORDER_GROUP_RESOLVER, idParam: "id" })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async group(
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: ApiResponse,
    @Param(new ZodPipe(IdParam, "/params")) params: z.infer<typeof IdParam>,
  ) {
    const g = await this.getGroup.execute({ userId: principalOf(req).actor.id, groupId: params.id });
    if (g === null) throw Problems.notFound();
    const stores = await this.storeLookup.summaries([...new Set(g.sellerOrders.map((o) => o.storeId))]);
    const wire = orderGroupWire(g, stores);
    const etag = etagOf(wire);
    res.setHeader("ETag", etag);
    res.setHeader("Cache-Control", "private, no-cache");
    if (matches(headerValue(req, "if-none-match"), etag)) throw new ProblemError(304, "not-modified", "Not modified");
    return wire;
  }

  @Post("seller-orders/:id/cancel")
  @HttpCode(200)
  @Authorize({ action: "update", resourceType: "order", resolver: SHOPPER_ORDER_RESOLVER, idParam: "id" })
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 10, windowSeconds: 60 }])
  async cancel(
    @Req() req: ApiRequest,
    @Param(new ZodPipe(IdParam, "/params")) params: z.infer<typeof IdParam>,
    @Body(new ZodPipe(CancelBody)) body: z.infer<typeof CancelBody>,
  ) {
    const userId = principalOf(req).actor.id;
    const r = unwrap(
      await this.commands.cancelByShopper({
        sellerOrderId: params.id,
        userId,
        idempotencyKey: requireKey(req),
        reason: body.reason,
      }),
    );
    const stores = await this.storeLookup.summaries([r.order.storeId]);
    return shopperSellerOrderWire(r.order, stores);
  }
}

// --------------------------------------------------------------------------- seller

@Controller("seller/orders")
export class SellerOrdersController {
  constructor(
    @Inject(OrderStoreAccess) private readonly access: OrderStoreAccess,
    @Inject(LIST_SELLER_ORDERS) private readonly list: ListSellerOrders,
    @Inject(GET_SELLER_ORDER) private readonly getOrder: GetSellerOrder,
    @Inject(ORDER_COMMANDS) private readonly commands: OrderCommands,
    @Inject(ORDERS_NOW) private readonly now: () => number,
  ) {}

  private scopeOf(req: ApiRequest): OrderScope {
    const actor = principalOf(req).actor;
    const storeIds = [...new Set(actor.grants.flatMap((g) => (g.kind === "brand" ? [g.storeId] : [])))];
    return { kind: "seller", userId: actor.id, storeIds };
  }

  @Get()
  @AuthenticatedSelf("seller_api")
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async index(@Req() req: ApiRequest, @Query(new ZodPipe(ListQuery, "/query")) q: z.output<typeof ListQuery>) {
    const actor = principalOf(req).actor;
    const storeIds = await this.access.readableStores(actor);
    const page = await this.list.execute({
      scope: { kind: "seller", userId: actor.id, storeIds },
      storeIds,
      ...(q.status !== undefined ? { status: q.status } : {}),
      after: decodeCursor(q.cursor),
      limit: q.limit,
    });
    const nowMs = this.now();
    return {
      items: page.items.map((o) => sellerOrderViewWire(o, nowMs)),
      page: { next_cursor: page.next === null ? null : encodeCursor(page.next), has_more: page.next !== null },
    };
  }

  @Get(":id")
  @Authorize({ audience: "seller_api", action: "read", resourceType: "store_order", resolver: SELLER_ORDER_RESOLVER, idParam: "id" })
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async one(
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: ApiResponse,
    @Param(new ZodPipe(IdParam, "/params")) params: z.infer<typeof IdParam>,
  ) {
    const o = await this.getOrder.execute({ scope: this.scopeOf(req), sellerOrderId: params.id });
    if (o === null) throw Problems.notFound();
    const wire = sellerOrderViewWire(o, this.now());
    const etag = etagOf(wire);
    res.setHeader("ETag", etag);
    res.setHeader("Cache-Control", "private, no-cache");
    if (matches(headerValue(req, "if-none-match"), etag)) throw new ProblemError(304, "not-modified", "Not modified");
    return wire;
  }

  @Post(":id/accept")
  @HttpCode(200)
  @Authorize({ audience: "seller_api", action: "update", resourceType: "store_order", resolver: SELLER_ORDER_RESOLVER, idParam: "id" })
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async accept(@Req() req: ApiRequest, @Param(new ZodPipe(IdParam, "/params")) params: z.infer<typeof IdParam>) {
    const r = unwrap(
      await this.commands.accept({
        sellerOrderId: params.id,
        scope: this.scopeOf(req),
        actorId: principalOf(req).actor.id,
        idempotencyKey: requireKey(req),
      }),
    );
    return sellerOrderViewWire(r.order, this.now());
  }

  @Post(":id/pack")
  @HttpCode(200)
  @Authorize({ audience: "seller_api", action: "update", resourceType: "store_order", resolver: SELLER_ORDER_RESOLVER, idParam: "id" })
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async pack(@Req() req: ApiRequest, @Param(new ZodPipe(IdParam, "/params")) params: z.infer<typeof IdParam>) {
    const r = unwrap(
      await this.commands.pack({
        sellerOrderId: params.id,
        scope: this.scopeOf(req),
        actorId: principalOf(req).actor.id,
        idempotencyKey: requireKey(req),
      }),
    );
    return sellerOrderViewWire(r.order, this.now());
  }

  @Post(":id/reject")
  @HttpCode(200)
  @Authorize({ audience: "seller_api", action: "update", resourceType: "store_order", resolver: SELLER_ORDER_RESOLVER, idParam: "id" })
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async reject(
    @Req() req: ApiRequest,
    @Param(new ZodPipe(IdParam, "/params")) params: z.infer<typeof IdParam>,
    @Body(new ZodPipe(RejectBody)) body: z.infer<typeof RejectBody>,
  ) {
    const r = unwrap(
      await this.commands.reject({
        sellerOrderId: params.id,
        scope: this.scopeOf(req),
        actorId: principalOf(req).actor.id,
        idempotencyKey: requireKey(req),
        reason: body.reason,
      }),
    );
    return sellerOrderViewWire(r.order, this.now());
  }
}
