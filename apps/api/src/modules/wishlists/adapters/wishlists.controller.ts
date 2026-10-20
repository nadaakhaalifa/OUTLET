import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query, Req, Res } from "@nestjs/common";
import { sha256Hex } from "@outlet/idempotency";
import { MoneySchema, UuidSchema, moneyToWire, type MoneyWire } from "@outlet/validation";
import { z } from "zod";
import { AuthenticatedSelf, Authorize, Idempotent, Public, RateLimit } from "../../../platform/decorators";
import { headerValue, type ApiRequest, type ApiResponse } from "../../../platform/http-types";
import { ProblemError, Problems } from "../../../platform/problem";
import { ZodPipe } from "../../../platform/zod.pipe";
import type { WishlistDetailView, WishlistView, ItemView } from "../application/read-model";
import type { CreateShareLink, GetSharedWishlist, RevokeShareLink, SharedWishlistView } from "../application/sharing";
import type {
  AddItemFailure,
  AddWishlistItem,
  CreateWishlist,
  DeleteWishlist,
  ListWishlists,
  RemoveWishlistItem,
  UpdateWishlist,
  WishlistDetails,
} from "../application/wishlists";
import { WISHLIST_INTENTS, type Money, type WishlistRuleViolation } from "../domain/types";
import {
  ADD_WISHLIST_ITEM,
  CREATE_SHARE_LINK,
  CREATE_WISHLIST,
  DELETE_WISHLIST,
  GET_SHARED_WISHLIST,
  LIST_WISHLISTS,
  REMOVE_WISHLIST_ITEM,
  REVOKE_SHARE_LINK,
  UPDATE_WISHLIST,
  WISHLIST_DETAILS,
  WISHLIST_RESOLVER,
} from "./tokens";

// ---- Schemas (strict allow-lists, API3) -------------------------------------------------------

const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");

const WishlistInputSchema = z
  .object({
    intent: z.enum(WISHLIST_INTENTS),
    title: z.string().min(1).max(80),
    target_date: DateOnly.optional(),
    budget: MoneySchema.optional(),
    gift_for: z
      .object({
        nickname: z.string().min(1).max(40),
        occasion: z.string().max(40).optional(),
        date: DateOnly.optional(),
      })
      .strict()
      .optional(),
    cool_off_enabled: z.boolean().optional(),
  })
  .strict();

const WishlistUpdateSchema = z
  .object({
    title: z.string().min(1).max(80).optional(),
    target_date: DateOnly.optional(),
    budget: MoneySchema.optional(),
    cool_off_enabled: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "at least one property is required" });

const ItemCreateSchema = z
  .object({ product_id: UuidSchema, sku_pref: UuidSchema.optional(), note: z.string().max(200).optional() })
  .strict();

const ShareRequestSchema = z
  .object({ expires_at: z.iso.datetime({ offset: true }).optional(), hide_prices_from_owner: z.boolean().optional() })
  .strict();

const ListQuerySchema = z
  .object({
    cursor: z.string().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();

const SharedParamsSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{22,64}$/) }).strict();

// ---- Wire mapping -----------------------------------------------------------------------------

const iso = (ms: number): string => new Date(ms).toISOString();
const money = (m: Money): MoneyWire => moneyToWire(m);

function wishlistWire(v: WishlistView) {
  const l = v.list;
  return {
    id: l.id,
    intent: l.intent,
    title: l.title,
    ...(l.targetDate !== null ? { target_date: l.targetDate } : {}),
    ...(l.budget !== null ? { budget: money(l.budget) } : {}),
    ...(l.giftFor !== null
      ? {
          gift_for: {
            nickname: l.giftFor.nickname,
            ...(l.giftFor.occasion !== null ? { occasion: l.giftFor.occasion } : {}),
            ...(l.giftFor.date !== null ? { date: l.giftFor.date } : {}),
          },
        }
      : {}),
    cool_off_enabled: l.coolOffEnabled,
    visibility: v.visibility,
    item_count: v.itemCount,
    created_at: iso(l.createdAtMs),
  };
}

function itemWire(v: ItemView) {
  const i = v.item;
  return {
    id: i.id,
    product_id: i.productId,
    ...(i.skuPref !== null ? { sku_pref: i.skuPref } : {}),
    added_price: money(i.addedPrice),
    current_price: v.currentPrice === null ? null : money(v.currentPrice),
    ...(i.note !== null ? { note: i.note } : {}),
    state: v.state,
    cool_off_until: v.coolOffUntilMs === null ? null : iso(v.coolOffUntilMs),
    ...(v.product !== null ? { product: v.product } : {}),
  };
}

function detailWire(v: WishlistDetailView) {
  return { ...wishlistWire(v), items: v.items.map(itemWire) };
}

function sharedWire(v: SharedWishlistView) {
  return {
    title: v.title,
    intent: v.intent,
    ...(v.ownerNickname !== null ? { owner_nickname: v.ownerNickname } : {}),
    ...(v.targetDate !== null ? { target_date: v.targetDate } : {}),
    items: v.items.map((i) => ({ product: i.product, price_hidden: i.priceHidden })),
  };
}

const etagOf = (wire: unknown): string => `"${sha256Hex(JSON.stringify(wire)).slice(0, 32)}"`;

function tagMatches(header: string, etag: string): boolean {
  return header.split(",").some((t) => {
    const tag = t.trim();
    return tag === "*" || tag === etag || tag === `W/${etag}`;
  });
}

const RULE_TITLES: Readonly<Record<WishlistRuleViolation, string>> = {
  title_invalid: "The title is not valid",
  target_date_invalid: "The target date is not a valid calendar date",
  target_date_in_past: "The target date is in the past",
  budget_invalid: "The budget must be a positive EGP amount within the allowed range",
  gift_for_required: "gift_for is required for a gift list",
  gift_for_not_allowed: "gift_for is only allowed for a gift list",
  gift_for_invalid: "gift_for is not valid",
  cool_off_requires_want: "Cool-off is only available on Want lists",
  note_invalid: "The note is not valid",
  share_expiry_invalid: "The expiry must be in the future and within one year",
};

const unprocessable = (code: string, title: string) => new ProblemError(422, code.replace(/_/g, "-"), title, { code });
const ruleProblem = (v: WishlistRuleViolation) => unprocessable(v, RULE_TITLES[v]);

const ADD_TITLES: Readonly<Record<AddItemFailure, string>> = {
  product_unavailable: "The product is not available to save",
  sku_not_in_product: "The size does not belong to this product",
  duplicate_item: "This item is already on the list",
  item_limit_reached: "The list is full",
  note_invalid: "The note is not valid",
  catalog_unavailable: "The catalog is temporarily unavailable",
};

function userIdOf(req: ApiRequest): string {
  const id = req.principal?.actor.id;
  if (id === undefined) throw Problems.unauthenticated();
  return id;
}

const OWN = (action: "read" | "update" | "delete") =>
  Authorize({ action, resourceType: "wishlist", resolver: WISHLIST_RESOLVER, idParam: "wishlistId" });

@Controller()
export class WishlistsController {
  constructor(
    @Inject(CREATE_WISHLIST) private readonly createWishlist: CreateWishlist,
    @Inject(LIST_WISHLISTS) private readonly listWishlists: ListWishlists,
    @Inject(WISHLIST_DETAILS) private readonly details: WishlistDetails,
    @Inject(UPDATE_WISHLIST) private readonly updateWishlist: UpdateWishlist,
    @Inject(DELETE_WISHLIST) private readonly deleteWishlist: DeleteWishlist,
    @Inject(ADD_WISHLIST_ITEM) private readonly addItem: AddWishlistItem,
    @Inject(REMOVE_WISHLIST_ITEM) private readonly removeItem: RemoveWishlistItem,
    @Inject(CREATE_SHARE_LINK) private readonly createShare: CreateShareLink,
    @Inject(REVOKE_SHARE_LINK) private readonly revokeShare: RevokeShareLink,
    @Inject(GET_SHARED_WISHLIST) private readonly getShared: GetSharedWishlist,
  ) {}

  @Get("me/wishlists")
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async list(@Req() req: ApiRequest, @Query(new ZodPipe(ListQuerySchema, "/query")) q: z.infer<typeof ListQuerySchema>) {
    const r = await this.listWishlists.execute(userIdOf(req), { cursor: q.cursor, limit: q.limit });
    if (r.kind === "invalid_cursor") {
      throw new ProblemError(400, "validation-failed", "Request validation failed", {
        code: "invalid_cursor",
        errors: [{ pointer: "/query/cursor", code: "invalid_cursor" }],
      });
    }
    return { items: r.items.map(wishlistWire), page: { next_cursor: r.nextCursor, has_more: r.nextCursor !== null } };
  }

  @Post("me/wishlists")
  @AuthenticatedSelf()
  @Idempotent({ required: false })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async create(@Req() req: ApiRequest, @Body(new ZodPipe(WishlistInputSchema)) b: z.infer<typeof WishlistInputSchema>) {
    const r = await this.createWishlist.execute(userIdOf(req), {
      intent: b.intent,
      title: b.title,
      targetDate: b.target_date ?? null,
      budget: b.budget ?? null,
      giftFor:
        b.gift_for === undefined
          ? null
          : { nickname: b.gift_for.nickname, occasion: b.gift_for.occasion ?? null, date: b.gift_for.date ?? null },
      coolOffEnabled: b.cool_off_enabled ?? false,
    });
    switch (r.kind) {
      case "created":
        return wishlistWire(r.view);
      case "limit_reached":
        throw unprocessable("wishlist_limit_reached", "You have reached the maximum number of lists");
      case "rule":
        throw ruleProblem(r.violation);
    }
  }

  @Get("me/wishlists/:wishlistId")
  @OWN("read")
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async get(
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: ApiResponse,
    @Param("wishlistId") wishlistId: string,
  ) {
    const d = await this.details.forOwner(userIdOf(req), wishlistId);
    if ("kind" in d) throw Problems.notFound();
    const wire = detailWire(d);
    const etag = etagOf(wire);
    res.setHeader("ETag", etag);
    res.setHeader("Cache-Control", "private, no-cache");
    const inm = headerValue(req, "if-none-match");
    if (inm !== undefined && tagMatches(inm, etag)) throw new ProblemError(304, "not-modified", "Not modified");
    return wire;
  }

  @Patch("me/wishlists/:wishlistId")
  @HttpCode(200)
  @OWN("update")
  @Idempotent({ required: false })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async update(
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: ApiResponse,
    @Param("wishlistId") wishlistId: string,
    @Body(new ZodPipe(WishlistUpdateSchema)) b: z.infer<typeof WishlistUpdateSchema>,
  ) {
    const ifMatch = headerValue(req, "if-match");
    if (ifMatch === undefined || ifMatch.trim() === "") {
      throw new ProblemError(428, "precondition-required", "If-Match is required for this update", {
        code: "precondition_required",
      });
    }
    const r = await this.updateWishlist.execute(
      userIdOf(req),
      wishlistId,
      {
        ...(b.title !== undefined ? { title: b.title } : {}),
        ...(b.target_date !== undefined ? { targetDate: b.target_date } : {}),
        ...(b.budget !== undefined ? { budget: b.budget } : {}),
        ...(b.cool_off_enabled !== undefined ? { coolOffEnabled: b.cool_off_enabled } : {}),
      },
      (current) => tagMatches(ifMatch, etagOf(detailWire(current))),
    );
    switch (r.kind) {
      case "updated": {
        const full = detailWire(r.view);
        res.setHeader("ETag", etagOf(full));
        return wishlistWire(r.view);
      }
      case "not_found":
        throw Problems.notFound();
      case "precondition_failed":
        throw new ProblemError(412, "precondition-failed", "The list changed; reload and try again", {
          code: "precondition_failed",
        });
      case "rule":
        throw ruleProblem(r.violation);
    }
  }

  @Delete("me/wishlists/:wishlistId")
  @HttpCode(204)
  @OWN("delete")
  @Idempotent({ required: false })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async remove(@Req() req: ApiRequest, @Param("wishlistId") wishlistId: string): Promise<void> {
    const r = await this.deleteWishlist.execute(userIdOf(req), wishlistId);
    if (r.kind === "not_found") throw Problems.notFound();
  }

  @Post("wishlists/:wishlistId/items")
  @OWN("update")
  @Idempotent({ required: false })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async add(
    @Req() req: ApiRequest,
    @Param("wishlistId") wishlistId: string,
    @Body(new ZodPipe(ItemCreateSchema)) b: z.infer<typeof ItemCreateSchema>,
  ) {
    const r = await this.addItem.execute(userIdOf(req), wishlistId, {
      productId: b.product_id,
      skuPref: b.sku_pref ?? null,
      note: b.note,
    });
    switch (r.kind) {
      case "added":
        return itemWire(r.view);
      case "not_found":
        throw Problems.notFound();
      case "rejected":
        if (r.reason === "catalog_unavailable") throw Problems.unavailable("catalog_unavailable");
        throw unprocessable(r.reason, ADD_TITLES[r.reason]);
    }
  }

  @Delete("wishlists/:wishlistId/items/:itemId")
  @HttpCode(204)
  @OWN("update")
  @Idempotent({ required: false })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async removeOne(
    @Req() req: ApiRequest,
    @Param("wishlistId") wishlistId: string,
    @Param("itemId") itemId: string,
  ): Promise<void> {
    const r = await this.removeItem.execute(userIdOf(req), wishlistId, itemId);
    if (r.kind === "not_found") throw Problems.notFound();
  }

  @Post("me/wishlists/:wishlistId/share")
  @OWN("update")
  @Idempotent({ required: false })
  @RateLimit([{ dimension: "user", limit: 10, windowSeconds: 3600 }])
  async share(
    @Req() req: ApiRequest,
    @Param("wishlistId") wishlistId: string,
    @Body(new ZodPipe(ShareRequestSchema)) b: z.infer<typeof ShareRequestSchema>,
  ) {
    const r = await this.createShare.execute(userIdOf(req), wishlistId, {
      expiresAtMs: b.expires_at === undefined ? null : Date.parse(b.expires_at),
      hidePrices: b.hide_prices_from_owner ?? false,
    });
    switch (r.kind) {
      case "created":
        return {
          url: r.url,
          expires_at: r.expiresAtMs === null ? null : iso(r.expiresAtMs),
          created_at: iso(r.createdAtMs),
        };
      case "not_found":
        throw Problems.notFound();
      case "invalid_expiry":
        throw ruleProblem("share_expiry_invalid");
    }
  }

  @Delete("me/wishlists/:wishlistId/share")
  @HttpCode(204)
  @OWN("update")
  @Idempotent({ required: false })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async unshare(@Req() req: ApiRequest, @Param("wishlistId") wishlistId: string): Promise<void> {
    const r = await this.revokeShare.execute(userIdOf(req), wishlistId);
    if (r.kind === "not_found") throw Problems.notFound();
  }

  @Get("shared/wishlists/:token")
  @Public()
  // Enumeration surface: fail closed when the limiter is down.
  @RateLimit([{ dimension: "ip", limit: 20, windowSeconds: 60 }], "closed")
  async shared(@Param(new ZodPipe(SharedParamsSchema, "/params")) p: z.infer<typeof SharedParamsSchema>) {
    const v = await this.getShared.execute(p.token);
    if (v === null) throw Problems.notFound();
    return sharedWire(v);
  }
}
