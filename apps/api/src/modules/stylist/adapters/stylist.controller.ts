import { Body, Controller, HttpCode, Inject, Param, Post, Req } from "@nestjs/common";
import { z } from "zod";
import { Authorize, AuthenticatedSelf, Idempotent, RateLimit } from "../../../platform/decorators";
import type { ApiRequest } from "../../../platform/http-types";
import { ProblemError, Problems } from "../../../platform/problem";
import { ZodPipe } from "../../../platform/zod.pipe";
import type { AddOutfitToBag } from "../application/bag";
import type { SubmitFeedback } from "../application/feedback";
import type { CompleteLook, GenerateInput, GenerateOutcome, GenerateOutfits, PlanCapsule } from "../application/generate";
import type { Scope } from "../domain/ports";
import {
  ADD_OUTFIT_TO_BAG,
  COMPLETE_LOOK,
  GENERATE_OUTFITS,
  PLAN_CAPSULE,
  STYLIST_OUTFIT_RESOLVER,
  SUBMIT_FEEDBACK,
} from "./tokens";
import { generateWire } from "./wire";

const Uuid = z.uuid();
const Piastres = z.string().regex(/^\d{1,12}$/);
const OCCASIONS = ["work", "wedding_guest", "date", "eid", "beach", "gym", "university", "casual"] as const;
const SEASONS = ["summer", "winter", "spring", "autumn", "all"] as const;

const ScopeBody = z
  .object({ world: z.enum(["local", "global", "everything", "my_stores"]), store_ids: z.array(Uuid).max(30).default([]) })
  .strict();

const Common = {
  occasion: z.enum(OCCASIONS).optional(),
  season: z.enum(SEASONS).default("all"),
  modest: z.boolean().default(false),
  formality: z.number().int().min(0).max(4).optional(),
  budget_piastres: Piastres.optional(),
  use_remaining_budget: z.boolean().default(false),
  scope: ScopeBody.optional(),
  note: z.string().max(200).optional(),
};

const OutfitsBody = z.object({ ...Common, wishlist_only: z.boolean().default(false) }).strict();
const CompleteLookBody = z.object({ ...Common, anchor_item_id: Uuid }).strict();
const CapsuleBody = z
  .object({ ...Common, pieces: z.number().int().min(3).max(12).default(10), outfits: z.number().int().min(1).max(30).default(20) })
  .strict();
const FeedbackBody = z
  .object({ outfit_id: Uuid, item_id: Uuid, signal: z.enum(["like", "dislike", "swap_in", "swap_out"]) })
  .strict();

const principalOf = (req: ApiRequest) => {
  const p = req.principal;
  if (p === null || p === undefined) throw Problems.unauthenticated();
  return p;
};

const DEFAULT_SCOPE: Scope = { world: "everything", storeIds: [] };

function inputOf(userId: string, b: z.infer<z.ZodObject<typeof Common>>, wishlistOnly: boolean): GenerateInput {
  return {
    userId,
    occasion: b.occasion ?? null,
    season: b.season,
    modest: b.modest,
    formality: b.formality ?? null,
    typedBudget: b.budget_piastres === undefined ? null : BigInt(b.budget_piastres),
    useRemainingBudget: b.use_remaining_budget,
    scope: b.scope === undefined ? DEFAULT_SCOPE : { world: b.scope.world, storeIds: b.scope.store_ids },
    wishlistOnly,
    note: b.note ?? null,
  };
}

function unwrap(r: GenerateOutcome) {
  switch (r.kind) {
    case "ok":
      return generateWire(r.view);
    case "quota_exceeded":
      throw Problems.rateLimited(r.retryAfterMs / 1000);
    case "catalog_unavailable":
      throw Problems.unavailable("catalog_unavailable");
    case "anchor_unavailable":
      throw new ProblemError(422, "anchor-unavailable", "The selected item is not available in your size", { code: "anchor_unavailable" });
  }
}

@Controller("stylist")
export class StylistController {
  constructor(
    @Inject(GENERATE_OUTFITS) private readonly generate: GenerateOutfits,
    @Inject(COMPLETE_LOOK) private readonly completeLook: CompleteLook,
    @Inject(PLAN_CAPSULE) private readonly capsule: PlanCapsule,
    @Inject(ADD_OUTFIT_TO_BAG) private readonly addToBag: AddOutfitToBag,
    @Inject(SUBMIT_FEEDBACK) private readonly feedback: SubmitFeedback,
  ) {}

  @Post("outfits")
  @HttpCode(200)
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 10, windowSeconds: 60 }])
  async outfits(@Req() req: ApiRequest, @Body(new ZodPipe(OutfitsBody)) b: z.infer<typeof OutfitsBody>) {
    const userId = principalOf(req).actor.id;
    return unwrap(await this.generate.execute(inputOf(userId, b, b.wishlist_only)));
  }

  @Post("complete-look")
  @HttpCode(200)
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 10, windowSeconds: 60 }])
  async look(@Req() req: ApiRequest, @Body(new ZodPipe(CompleteLookBody)) b: z.infer<typeof CompleteLookBody>) {
    const userId = principalOf(req).actor.id;
    return unwrap(await this.completeLook.execute({ ...inputOf(userId, b, false), anchorItemId: b.anchor_item_id }));
  }

  @Post("capsule")
  @HttpCode(200)
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 5, windowSeconds: 60 }])
  async plan(@Req() req: ApiRequest, @Body(new ZodPipe(CapsuleBody)) b: z.infer<typeof CapsuleBody>) {
    const userId = principalOf(req).actor.id;
    const r = await this.capsule.execute({ ...inputOf(userId, b, false), pieces: b.pieces, outfitTarget: b.outfits });
    const wire = unwrap(r);
    return { ...wire, outfit_count: "outfitCount" in r ? (r.outfitCount ?? 0) : 0 };
  }

  @Post("outfits/:outfitId/add-to-bag")
  @HttpCode(200)
  @Authorize({ action: "update", resourceType: "wishlist", resolver: STYLIST_OUTFIT_RESOLVER, idParam: "outfitId" })
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 20, windowSeconds: 60 }])
  async add(@Req() req: ApiRequest, @Param("outfitId") outfitId: string) {
    const key = req.headers["idempotency-key"];
    const idempotencyKey = Array.isArray(key) ? (key[0] ?? "") : (key ?? "");
    const r = await this.addToBag.execute({ userId: principalOf(req).actor.id, outfitId: outfitId.toLowerCase(), idempotencyKey });
    switch (r.kind) {
      case "not_found":
        throw Problems.notFound();
      case "already_added":
        return { added: false, already_added: true, item_ids: [], unavailable: [], price_changes: [] };
      case "nothing_available":
        throw new ProblemError(409, "nothing-available", "None of the items are available any more", {
          code: "nothing_available",
        });
      case "budget_exceeded":
        throw new ProblemError(409, "budget-exceeded", "Current prices put this outfit over your budget", {
          code: "budget_exceeded",
          extensions: { total_piastres: r.totalPiastres.toString(), budget_piastres: r.budgetPiastres.toString() },
        });
      case "added":
        return {
          added: true,
          already_added: false,
          item_ids: r.itemIds,
          total_piastres: r.totalPiastres.toString(),
          unavailable: r.unavailable.map((u) => ({ item_id: u.itemId, slot: u.slot, reason: u.reason })),
          price_changes: r.priceChanges.map((c) => ({
            item_id: c.itemId,
            from_piastres: c.fromPiastres.toString(),
            to_piastres: c.toPiastres.toString(),
          })),
        };
    }
  }

  @Post("feedback")
  @HttpCode(200)
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async feedbackRoute(@Req() req: ApiRequest, @Body(new ZodPipe(FeedbackBody)) b: z.infer<typeof FeedbackBody>) {
    const r = await this.feedback.execute({
      userId: principalOf(req).actor.id,
      outfitId: b.outfit_id.toLowerCase(),
      itemId: b.item_id.toLowerCase(),
      signal: b.signal,
    });
    switch (r.kind) {
      case "not_found":
        throw Problems.notFound(); // another user's outfit is indistinguishable from a missing one
      case "not_recorded":
        return { recorded: false, reason: r.reason };
      case "recorded":
        return { recorded: true, style_updated: r.styleUpdated };
    }
  }
}
