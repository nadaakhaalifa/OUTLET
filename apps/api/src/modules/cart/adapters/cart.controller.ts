import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query, Req, Res } from "@nestjs/common";
import { sha256Hex } from "@outlet/idempotency";
import { z } from "zod";
import { AuthenticatedSelf, Authorize, Idempotent, RateLimit } from "../../../platform/decorators";
import { headerValue, type ApiRequest, type ApiResponse } from "../../../platform/http-types";
import { ProblemError, Problems } from "../../../platform/problem";
import { ZodPipe } from "../../../platform/zod.pipe";
import {
  CatalogUnavailableError,
  type AddLine,
  type BagView,
  type GetCart,
  type GetFreeDeliverySuggestions,
  type RemoveLine,
  type UpdateLine,
} from "../application/bag";
import type { LineSource } from "../domain/ports";
import {
  ADD_LINE,
  CART_LINE_RESOLVER,
  GET_CART,
  GET_SUGGESTIONS,
  REMOVE_LINE,
  UPDATE_LINE,
} from "./tokens";
import { cartWire, suggestionsWire } from "./wire";

const SOURCES = ["pdp", "search", "stylist", "wishlist", "feed", "bag_suggestion"] as const;
const Qty = z.number().int().min(1).max(10);

const AddBody = z
  .object({ sku_id: z.uuid(), qty: Qty, source: z.enum(SOURCES).optional() })
  .strict();
const UpdateBody = z
  .object({ qty: Qty.optional(), saved_for_later: z.boolean().optional() })
  .strict()
  .refine((b) => b.qty !== undefined || b.saved_for_later !== undefined, { message: "at least one field is required" });
const SuggestionQuery = z.object({ store_id: z.uuid() }).strict();

function etagOf(wire: unknown): string {
  return `"${sha256Hex(JSON.stringify(wire)).slice(0, 32)}"`;
}

function tokensOf(header: string): string[] {
  return header.split(",").map((t) => t.trim());
}

function matches(header: string | undefined, etag: string, weak: boolean): boolean {
  if (header === undefined) return false;
  return tokensOf(header).some((t) => t === etag || (weak && t === `W/${etag}`) || t === "*");
}

function userOf(req: ApiRequest): string {
  const id = req.principal?.actor.id;
  if (id === undefined) throw Problems.unauthenticated();
  return id;
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof CatalogUnavailableError) throw Problems.unavailable("catalog_unavailable");
    throw e;
  }
}

const conflict = () =>
  new ProblemError(409, "cart-conflict", "The bag changed on another device; reload and retry", { code: "cart_conflict" });
const unprocessable = (slug: string, title: string, code: string) => new ProblemError(422, slug, title, { code });

function sendCart(res: ApiResponse, view: BagView) {
  const wire = cartWire(view);
  res.setHeader("ETag", etagOf(wire));
  res.setHeader("Cache-Control", "private, no-cache");
  return wire;
}

@Controller("cart")
export class CartController {
  constructor(
    @Inject(GET_CART) private readonly getCart: GetCart,
    @Inject(ADD_LINE) private readonly addLine: AddLine,
    @Inject(UPDATE_LINE) private readonly updateLine: UpdateLine,
    @Inject(REMOVE_LINE) private readonly removeLine: RemoveLine,
    @Inject(GET_SUGGESTIONS) private readonly suggestions: GetFreeDeliverySuggestions,
  ) {}

  @Get()
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async read(@Req() req: ApiRequest, @Res({ passthrough: true }) res: ApiResponse) {
    const view = await guarded(() => this.getCart.execute(userOf(req)));
    const wire = sendCart(res, view);
    if (matches(headerValue(req, "if-none-match"), etagOf(wire), true)) {
      throw new ProblemError(304, "not-modified", "Not modified");
    }
    return wire;
  }

  @Post("lines")
  @AuthenticatedSelf()
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async add(
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: ApiResponse,
    @Body(new ZodPipe(AddBody)) body: z.infer<typeof AddBody>,
  ) {
    const r = await guarded(() =>
      this.addLine.execute({
        userId: userOf(req),
        skuId: body.sku_id,
        qty: body.qty,
        source: (body.source ?? null) as LineSource | null,
      }),
    );
    switch (r.kind) {
      case "ok":
        return sendCart(res, r.view);
      case "conflict":
        throw conflict();
      case "unknown_sku":
        throw unprocessable("unknown-sku", "The item does not exist", "unknown_sku");
      case "sku_unavailable":
        throw unprocessable("sku-unavailable", "The item is not available", "sku_unavailable");
      case "store_suspended":
        throw unprocessable("store-suspended", "The store is not selling right now", "store_suspended");
      case "line_limit_reached":
        throw unprocessable("line-limit-reached", "The bag holds at most 50 lines", "line_limit_reached");
      case "sku_unit_limit_reached":
        throw unprocessable("sku-unit-limit-reached", "At most 10 units of one item", "sku_unit_limit_reached");
    }
  }

  @Patch("lines/:lineId")
  @Authorize({ action: "update", resourceType: "cart", resolver: CART_LINE_RESOLVER, idParam: "lineId" })
  @Idempotent({ required: false })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async update(
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: ApiResponse,
    @Param("lineId") lineId: string,
    @Body(new ZodPipe(UpdateBody)) body: z.infer<typeof UpdateBody>,
  ) {
    const userId = userOf(req);
    const ifMatch = headerValue(req, "if-match");
    if (ifMatch === undefined) {
      throw new ProblemError(428, "precondition-required", "If-Match is required", { code: "precondition_required" });
    }
    const current = await guarded(() => this.getCart.execute(userId));
    if (!matches(ifMatch, etagOf(cartWire(current)), false)) {
      throw new ProblemError(412, "precondition-failed", "The bag changed; reload and retry", {
        code: "precondition_failed",
      });
    }
    const r = await guarded(() =>
      this.updateLine.execute({
        userId,
        lineId,
        ...(body.qty !== undefined ? { qty: body.qty } : {}),
        ...(body.saved_for_later !== undefined ? { savedForLater: body.saved_for_later } : {}),
      }),
    );
    if (r.kind === "ok") return sendCart(res, r.view);
    if (r.kind === "not_found") throw Problems.notFound();
    if (r.kind === "conflict") throw conflict();
    throw unprocessable("sku-unit-limit-reached", "At most 10 units of one item", "sku_unit_limit_reached");
  }

  @Delete("lines/:lineId")
  @Authorize({ action: "delete", resourceType: "cart", resolver: CART_LINE_RESOLVER, idParam: "lineId" })
  @Idempotent({ required: false })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async remove(@Req() req: ApiRequest, @Res({ passthrough: true }) res: ApiResponse, @Param("lineId") lineId: string) {
    const r = await guarded(() => this.removeLine.execute({ userId: userOf(req), lineId }));
    if (r.kind === "ok") return sendCart(res, r.view);
    if (r.kind === "conflict") throw conflict();
    throw Problems.notFound();
  }

  @Get("free-delivery-suggestions")
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async freeDelivery(
    @Req() req: ApiRequest,
    @Query(new ZodPipe(SuggestionQuery, "/query")) query: z.infer<typeof SuggestionQuery>,
  ) {
    const v = await guarded(() => this.suggestions.execute({ userId: userOf(req), storeId: query.store_id }));
    if (v === null) throw Problems.notFound();
    return suggestionsWire(v);
  }
}
