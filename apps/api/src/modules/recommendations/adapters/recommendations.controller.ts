import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from "@nestjs/common";
import { z } from "zod";
import { AuthenticatedSelf, Public, RateLimit } from "../../../platform/decorators";
import type { ApiRequest } from "../../../platform/http-types";
import { Problems } from "../../../platform/problem";
import { ZodPipe } from "../../../platform/zod.pipe";
import type {
  BuildFeed,
  PriceDroppedOnViewed,
  RecItem,
  RecordRecommendationClick,
  RestockReminders,
  SimilarProducts,
} from "../application/recommendations";
import {
  BUILD_FEED,
  PRICE_DROPPED_ON_VIEWED,
  RECORD_RECOMMENDATION_CLICK,
  RESTOCK_REMINDERS,
  SIMILAR_PRODUCTS,
} from "./tokens";

const REC_MODULES = ["feed", "similar", "similar_for_less", "goes_with", "restock", "price_drop", "exploration"] as const;
const BoolParam = z.enum(["true", "false"]).transform((v) => v === "true");
const FeedQuery = z
  .object({
    personalized: BoolParam.optional(),
    affordable: BoolParam.optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();
const SimilarQuery = z
  .object({
    mode: z.enum(["similar", "for_less", "goes_with"]).default("similar"),
    limit: z.coerce.number().int().min(1).max(50).default(12),
  })
  .strict();
const SimilarParams = z.object({ productId: z.uuid() }).strict();
const ModuleQuery = z.object({ limit: z.coerce.number().int().min(1).max(50).default(12) }).strict();
const ClickBody = z
  .object({ module: z.enum(REC_MODULES), product_id: z.uuid(), model_version: z.string().min(1).max(40) })
  .strict();

/**
 * A "% off" is only ever emitted when price integrity allowed the claim. Prices are piastres as
 * strings (bigint). No user id, no score, no feature value leaves the API.
 */
export const itemWire = (i: RecItem) => ({
  product_id: i.candidate.productId,
  store_id: i.candidate.storeId,
  price_piastres: i.candidate.priceMinor.toString(),
  verified_discount_pct: i.candidate.claimAllowed ? i.candidate.verifiedDiscountPct : null,
  reason: i.reason,
  sponsored: false as const,
  ...(i.priceDrop === undefined
    ? {}
    : {
        price_drop: {
          seen_price_piastres: i.priceDrop.seenMinor.toString(),
          drop_piastres: i.priceDrop.dropMinor.toString(),
        },
      }),
});

const principalOf = (req: ApiRequest) => {
  const p = req.principal;
  if (p === null || p === undefined) throw Problems.unauthenticated();
  return p;
};

@Controller()
export class RecommendationsController {
  constructor(
    @Inject(BUILD_FEED) private readonly feed: BuildFeed,
    @Inject(SIMILAR_PRODUCTS) private readonly similar: SimilarProducts,
    @Inject(RESTOCK_REMINDERS) private readonly restock: RestockReminders,
    @Inject(PRICE_DROPPED_ON_VIEWED) private readonly drops: PriceDroppedOnViewed,
    @Inject(RECORD_RECOMMENDATION_CLICK) private readonly click: RecordRecommendationClick,
  ) {}

  @Get("feed")
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async getFeed(@Req() req: ApiRequest, @Query(new ZodPipe(FeedQuery, "/query")) q: z.infer<typeof FeedQuery>) {
    const r = await this.feed.execute({
      userId: principalOf(req).actor.id,
      personalizedParam: q.personalized,
      affordable: q.affordable ?? false,
      limit: q.limit,
    });
    return {
      items: r.items.map(itemWire),
      personalized: r.personalized,
      personalization_reason: r.reason,
      model_version: r.modelVersion,
      degraded: r.degraded,
      affordability_applied: r.affordabilityApplied,
    };
  }

  @Get("products/:productId/similar")
  @Public()
  @RateLimit([{ dimension: "ip", limit: 60, windowSeconds: 60 }])
  async getSimilar(
    @Param(new ZodPipe(SimilarParams, "/params")) params: z.infer<typeof SimilarParams>,
    @Query(new ZodPipe(SimilarQuery, "/query")) q: z.infer<typeof SimilarQuery>,
  ) {
    const r = await this.similar.execute({ productId: params.productId.toLowerCase(), mode: q.mode, limit: q.limit });
    if (r.kind === "not_found") throw Problems.notFound();
    return { items: r.items.map(itemWire), degraded: r.degraded, model_version: r.modelVersion };
  }

  @Get("me/recommendations/restock")
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async getRestock(@Req() req: ApiRequest, @Query(new ZodPipe(ModuleQuery, "/query")) q: z.infer<typeof ModuleQuery>) {
    const r = await this.restock.execute(principalOf(req).actor.id, q.limit);
    return { items: r.items.map(itemWire), personalized: r.personalized };
  }

  @Get("me/recommendations/price-drops")
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async getDrops(@Req() req: ApiRequest, @Query(new ZodPipe(ModuleQuery, "/query")) q: z.infer<typeof ModuleQuery>) {
    const r = await this.drops.execute(principalOf(req).actor.id, q.limit);
    return { items: r.items.map(itemWire), personalized: r.personalized };
  }

  @Post("recommendations/clicks")
  @HttpCode(204)
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async postClick(@Body(new ZodPipe(ClickBody)) b: z.infer<typeof ClickBody>): Promise<void> {
    await this.click.execute({ module: b.module, productId: b.product_id.toLowerCase(), modelVersion: b.model_version });
  }
}
