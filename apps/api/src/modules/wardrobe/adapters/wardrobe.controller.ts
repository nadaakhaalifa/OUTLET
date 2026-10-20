import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query, Req } from "@nestjs/common";
import { z } from "zod";
import { Authorize, AuthenticatedSelf, Idempotent, RateLimit } from "../../../platform/decorators";
import type { ApiRequest } from "../../../platform/http-types";
import { ProblemError, Problems } from "../../../platform/problem";
import { ZodPipe } from "../../../platform/zod.pipe";
import type { CompleteFromWardrobe, SuggestOwnedSlots } from "../application/complete";
import type {
  ClearWardrobe,
  CreateWardrobeItem,
  DeleteWardrobeItem,
  GetWardrobeImageUrl,
  GetWardrobeItem,
  IssueWardrobeUpload,
  ListWardrobeItems,
  SuggestWardrobeAttributes,
  UpdateWardrobeAttributes,
} from "../application/wardrobe";
import { AttributesSchema, PartialAttributesSchema } from "../domain/attributes";
import { EVENT_KINDS, SEASONS } from "../domain/bridge";
import { decodeCursor } from "./in-memory";
import {
  CLEAR_WARDROBE,
  COMPLETE_FROM_WARDROBE,
  CREATE_WARDROBE_ITEM,
  DELETE_WARDROBE_ITEM,
  GET_WARDROBE_IMAGE_URL,
  GET_WARDROBE_ITEM,
  ISSUE_WARDROBE_UPLOAD,
  LIST_WARDROBE_ITEMS,
  SUGGEST_OWNED_SLOTS,
  SUGGEST_WARDROBE_ATTRIBUTES,
  UPDATE_WARDROBE_ATTRIBUTES,
  WARDROBE_ITEM_RESOLVER,
} from "./tokens";
import { completeWire, itemWire, ownedSlotsWire } from "./wire";

const Uuid = z.uuid();
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const Piastres = z.string().regex(/^\d{1,12}$/);

/** Strict bodies: unknown fields are refused, never ignored (mass assignment, API3). */
const UploadBody = z
  .object({ content_type: z.enum(["image/jpeg", "image/png", "image/webp"]), size_bytes: z.number().int().min(1).max(MAX_IMAGE_BYTES) })
  .strict();
const CreateBody = z
  .object({
    upload_id: z.string().min(10).max(200).regex(/^wardrobe\/\d{4}\/\d{2}\/[0-9a-f-]{36}$/).optional(),
    attributes: PartialAttributesSchema.optional(),
  })
  .strict()
  .refine((b) => b.upload_id !== undefined || (b.attributes !== undefined && AttributesSchema.safeParse(b.attributes).success), {
    message: "an item needs a photo or complete attributes",
    path: ["attributes"],
  });
const PatchBody = z
  .object({ attributes: PartialAttributesSchema, expected_version: z.number().int().min(1).optional() })
  .strict()
  .refine((b) => Object.keys(b.attributes).length > 0, { message: "no attributes", path: ["attributes"] });
const ListQuery = z
  .object({ limit: z.coerce.number().int().min(1).max(50).default(25), cursor: z.string().min(1).max(200).optional() })
  .strict();
const OccasionFields = {
  kind: z.enum(EVENT_KINDS),
  season: z.enum(SEASONS).default("all"),
  modest: z.boolean().default(false),
  item_ids: z.array(Uuid).min(1).max(6).optional(),
};
const OwnedQuery = z
  .object({
    kind: z.enum(EVENT_KINDS),
    season: z.enum(SEASONS).default("all"),
    modest: z.enum(["true", "false"]).default("false"),
  })
  .strict();
const CompleteBody = z
  .object({ ...OccasionFields, budget_piastres: Piastres.optional(), use_remaining_budget: z.boolean().default(false) })
  .strict();

const principalOf = (req: ApiRequest) => {
  const p = req.principal;
  if (p === null || p === undefined) throw Problems.unauthenticated();
  return p;
};
const consentRequired = () =>
  new ProblemError(403, "consent-required", "The personalization consent is required for the wardrobe", { code: "consent_required" });
const disabled = () => Problems.unavailable("wardrobe_disabled");
const unconfigured = () => Problems.unavailable("wardrobe_storage_unconfigured");

@Controller("me/wardrobe")
export class WardrobeController {
  constructor(
    @Inject(ISSUE_WARDROBE_UPLOAD) private readonly issue: IssueWardrobeUpload,
    @Inject(CREATE_WARDROBE_ITEM) private readonly create: CreateWardrobeItem,
    @Inject(LIST_WARDROBE_ITEMS) private readonly list: ListWardrobeItems,
    @Inject(GET_WARDROBE_ITEM) private readonly get: GetWardrobeItem,
    @Inject(UPDATE_WARDROBE_ATTRIBUTES) private readonly update: UpdateWardrobeAttributes,
    @Inject(SUGGEST_WARDROBE_ATTRIBUTES) private readonly suggest: SuggestWardrobeAttributes,
    @Inject(DELETE_WARDROBE_ITEM) private readonly remove: DeleteWardrobeItem,
    @Inject(CLEAR_WARDROBE) private readonly clear: ClearWardrobe,
    @Inject(GET_WARDROBE_IMAGE_URL) private readonly imageUrl: GetWardrobeImageUrl,
    @Inject(SUGGEST_OWNED_SLOTS) private readonly ownedSlots: SuggestOwnedSlots,
    @Inject(COMPLETE_FROM_WARDROBE) private readonly complete: CompleteFromWardrobe,
  ) {}

  @Get("items")
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async items(@Req() req: ApiRequest, @Query(new ZodPipe(ListQuery, "/query")) q: z.infer<typeof ListQuery>) {
    if (q.cursor !== undefined && decodeCursor(q.cursor) === null) {
      throw Problems.validation([{ pointer: "/query/cursor", code: "invalid_cursor" }]);
    }
    const page = await this.list.execute({ userId: principalOf(req).actor.id, limit: q.limit, cursor: q.cursor ?? null });
    return { items: page.items.map(itemWire), next_cursor: page.nextCursor };
  }

  @Post("uploads")
  @HttpCode(201)
  @AuthenticatedSelf()
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 20, windowSeconds: 60 }])
  async upload(@Req() req: ApiRequest, @Body(new ZodPipe(UploadBody)) b: z.infer<typeof UploadBody>) {
    const r = await this.issue.execute({ userId: principalOf(req).actor.id, contentType: b.content_type, sizeBytes: b.size_bytes });
    switch (r.kind) {
      case "ok":
        return {
          upload_id: r.upload.uploadId,
          url: r.upload.url,
          method: "PUT",
          headers: r.upload.headers,
          expires_at: new Date(r.upload.expiresAtMs).toISOString(),
          max_bytes: MAX_IMAGE_BYTES,
        };
      case "disabled":
        throw disabled();
      case "consent_required":
        throw consentRequired();
      case "storage_unconfigured":
        throw unconfigured();
      case "too_many_pending":
        throw new ProblemError(409, "too-many-pending-uploads", "Too many uploads are waiting to be used", { code: "too_many_pending_uploads" });
    }
  }

  @Post("items")
  @HttpCode(201)
  @AuthenticatedSelf()
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async createItem(@Req() req: ApiRequest, @Body(new ZodPipe(CreateBody)) b: z.infer<typeof CreateBody>) {
    const r = await this.create.execute({ userId: principalOf(req).actor.id, uploadId: b.upload_id ?? null, attributes: b.attributes ?? {} });
    switch (r.kind) {
      case "ok":
        return itemWire(r.view);
      case "disabled":
        throw disabled();
      case "consent_required":
        throw consentRequired();
      case "limit_reached":
        throw new ProblemError(409, "wardrobe-full", "The wardrobe item limit has been reached", { code: "wardrobe_full" });
      case "upload_unavailable":
        throw new ProblemError(422, "upload-unavailable", "The upload is not available", { code: "upload_unavailable" });
      case "upload_rejected":
        throw new ProblemError(422, "upload-rejected", "The photo did not pass the safety scan", { code: "upload_rejected" });
    }
  }

  @Get("owned-slots")
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 30, windowSeconds: 60 }])
  async owned(@Req() req: ApiRequest, @Query(new ZodPipe(OwnedQuery, "/query")) q: z.infer<typeof OwnedQuery>) {
    const v = await this.ownedSlots.execute({
      userId: principalOf(req).actor.id,
      kind: q.kind,
      season: q.season,
      modest: q.modest === "true",
      itemIds: null,
    });
    return ownedSlotsWire(v);
  }

  @Post("complete")
  @HttpCode(200)
  @AuthenticatedSelf()
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 10, windowSeconds: 60 }])
  async completeLook(@Req() req: ApiRequest, @Body(new ZodPipe(CompleteBody)) b: z.infer<typeof CompleteBody>) {
    const userId = principalOf(req).actor.id;
    if (b.item_ids !== undefined) {
      for (const id of b.item_ids) {
        // Another shopper's item id is indistinguishable from a missing one.
        if ((await this.get.execute({ userId, itemId: id.toLowerCase() })) === null) throw Problems.notFound();
      }
    }
    const r = await this.complete.execute({
      userId,
      kind: b.kind,
      season: b.season,
      modest: b.modest,
      itemIds: b.item_ids === undefined ? null : b.item_ids.map((x) => x.toLowerCase()),
      typedBudgetPiastres: b.budget_piastres === undefined ? null : BigInt(b.budget_piastres),
      useRemainingBudget: b.use_remaining_budget,
    });
    switch (r.kind) {
      case "ok":
        return completeWire(r.view);
      case "disabled":
        throw disabled();
      case "consent_required":
        throw consentRequired();
      case "quota_exceeded":
        throw Problems.rateLimited(r.retryAfterMs / 1000);
      case "catalog_unavailable":
        throw Problems.unavailable("catalog_unavailable");
      case "nothing_owned":
        throw new ProblemError(422, "nothing-owned", "No wardrobe item fits this occasion", { code: "nothing_owned" });
    }
  }

  @Delete()
  @HttpCode(204)
  @AuthenticatedSelf()
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 5, windowSeconds: 60 }])
  async clearAll(@Req() req: ApiRequest): Promise<void> {
    await this.clear.execute({ userId: principalOf(req).actor.id });
  }

  @Get("items/:itemId")
  @Authorize({ action: "read", resourceType: "wishlist", resolver: WARDROBE_ITEM_RESOLVER, idParam: "itemId" })
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async one(@Req() req: ApiRequest, @Param("itemId") itemId: string) {
    const v = await this.get.execute({ userId: principalOf(req).actor.id, itemId: itemId.toLowerCase() });
    if (v === null) throw Problems.notFound();
    return itemWire(v);
  }

  @Patch("items/:itemId")
  @Authorize({ action: "update", resourceType: "wishlist", resolver: WARDROBE_ITEM_RESOLVER, idParam: "itemId" })
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async patch(@Req() req: ApiRequest, @Param("itemId") itemId: string, @Body(new ZodPipe(PatchBody)) b: z.infer<typeof PatchBody>) {
    const r = await this.update.execute({
      userId: principalOf(req).actor.id,
      itemId: itemId.toLowerCase(),
      patch: b.attributes,
      expectedVersion: b.expected_version ?? null,
    });
    switch (r.kind) {
      case "ok":
        return itemWire(r.view);
      case "not_found":
        throw Problems.notFound();
      case "conflict":
        throw new ProblemError(409, "version-conflict", "The item changed since you loaded it", { code: "version_conflict" });
    }
  }

  @Delete("items/:itemId")
  @HttpCode(204)
  @Authorize({ action: "delete", resourceType: "wishlist", resolver: WARDROBE_ITEM_RESOLVER, idParam: "itemId" })
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async del(@Req() req: ApiRequest, @Param("itemId") itemId: string): Promise<void> {
    const r = await this.remove.execute({ userId: principalOf(req).actor.id, itemId: itemId.toLowerCase() });
    if (r === "not_found") throw Problems.notFound();
  }

  @Get("items/:itemId/photo")
  @Authorize({ action: "read", resourceType: "wishlist", resolver: WARDROBE_ITEM_RESOLVER, idParam: "itemId" })
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async photo(@Req() req: ApiRequest, @Param("itemId") itemId: string) {
    const r = await this.imageUrl.execute({ userId: principalOf(req).actor.id, itemId: itemId.toLowerCase() });
    switch (r.kind) {
      case "ok":
        return { url: r.url, expires_at: new Date(r.expiresAtMs).toISOString() };
      case "not_found":
        throw Problems.notFound();
      case "not_ready":
        throw new ProblemError(409, "photo-not-ready", "The photo is still being checked", { code: "photo_not_ready" });
      case "storage_unconfigured":
        throw unconfigured();
    }
  }

  @Post("items/:itemId/suggest-attributes")
  @HttpCode(200)
  @Authorize({ action: "update", resourceType: "wishlist", resolver: WARDROBE_ITEM_RESOLVER, idParam: "itemId" })
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 20, windowSeconds: 60 }])
  async suggestAttributes(@Req() req: ApiRequest, @Param("itemId") itemId: string) {
    const r = await this.suggest.execute({ userId: principalOf(req).actor.id, itemId: itemId.toLowerCase() });
    switch (r.kind) {
      case "ok":
        return itemWire(r.view);
      case "not_found":
        throw Problems.notFound();
      case "disabled":
        throw disabled();
      case "consent_required":
        throw consentRequired();
      case "vision_disabled":
        throw Problems.unavailable("wardrobe_vision_disabled");
      case "vision_unconfigured":
        throw Problems.unavailable("wardrobe_vision_unconfigured");
      case "external_consent_required":
        throw new ProblemError(403, "consent-required", "The cross_border_ml consent is required", { code: "consent_required" });
      case "no_photo":
        throw new ProblemError(422, "no-photo", "This item has no photo", { code: "no_photo" });
      case "photo_not_ready":
        throw new ProblemError(409, "photo-not-ready", "The photo is still being checked", { code: "photo_not_ready" });
      case "already_edited":
        throw new ProblemError(409, "attributes-edited", "The attributes were edited by you", { code: "attributes_edited" });
      case "no_suggestion":
        throw new ProblemError(422, "no-suggestion", "No suggestion could be made from this photo", { code: "no_suggestion" });
    }
  }
}
