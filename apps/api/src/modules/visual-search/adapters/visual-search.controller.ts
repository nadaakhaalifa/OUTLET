import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from "@nestjs/common";
import { z } from "zod";
import { AuthenticatedSelf, Public, RateLimit } from "../../../platform/decorators";
import type { ApiRequest } from "../../../platform/http-types";
import { Problems, ProblemError } from "../../../platform/problem";
import { ZodPipe } from "../../../platform/zod.pipe";
import type { IssueQueryUpload, SearchByImage, SimilarByProduct, VisualFilters, VisualItem, VisualOutput } from "../application/visual-search";
import { ISSUE_QUERY_UPLOAD, SEARCH_BY_IMAGE, SIMILAR_BY_PRODUCT } from "./tokens";

const Piastres = z.string().regex(/^\d{1,15}$/).transform((s) => BigInt(s));
const Unit = z.number().min(0).max(1);
const FiltersBody = z
  .object({
    world: z.enum(["local", "global", "all"]).optional(),
    my_stores: z.boolean().optional(),
    in_my_size: z.boolean().optional(),
    max_price_piastres: Piastres.optional(),
    category_id: z.string().min(1).max(60).optional(),
  })
  .strict();
const UploadBody = z
  .object({ content_type: z.enum(["image/jpeg", "image/png", "image/webp"]), size_bytes: z.number().int().min(1).max(10 * 1024 * 1024) })
  .strict();
const SearchBody = z
  .object({
    upload_id: z.string().min(8).max(200),
    crop: z.object({ x: Unit, y: Unit, w: Unit.refine((v) => v > 0), h: Unit.refine((v) => v > 0) }).strict().optional(),
    category_hint: z.string().min(1).max(60).optional(),
    filters: FiltersBody.default({}),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict();
const SimilarParams = z.object({ productId: z.uuid() }).strict();
const SimilarQuery = z
  .object({
    world: z.enum(["local", "global", "all"]).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(12),
  })
  .strict();

const filtersOf = (f: z.infer<typeof FiltersBody>): VisualFilters => ({
  ...(f.world === undefined ? {} : { world: f.world }),
  ...(f.my_stores === undefined ? {} : { myStores: f.my_stores }),
  ...(f.in_my_size === undefined ? {} : { inMySize: f.in_my_size }),
  ...(f.max_price_piastres === undefined ? {} : { maxPriceMinor: f.max_price_piastres }),
  ...(f.category_id === undefined ? {} : { categoryId: f.category_id }),
});

/** A "% off" is only emitted when price integrity allowed the claim. No raw similarity score leaves the API. */
const itemWire = (i: VisualItem) => ({
  product_id: i.productId,
  store_id: i.storeId,
  category_id: i.categoryId,
  price_piastres: i.priceMinor.toString(),
  verified_discount_pct: i.verifiedDiscountPct,
  match: i.match,
  sponsored: false as const,
});
const outputWire = (o: VisualOutput) => ({
  items: o.items.map(itemWire),
  groups: o.groups.map((g) => ({ category_id: g.categoryId, items: g.items.map(itemWire) })),
  low_confidence: o.lowConfidence,
  degraded: o.degraded,
  model_version: o.modelVersion,
  category_guess: o.categoryGuess,
});

const principalOf = (req: ApiRequest) => {
  const p = req.principal;
  if (p === null || p === undefined) throw Problems.unauthenticated();
  return p;
};

@Controller()
export class VisualSearchController {
  constructor(
    @Inject(ISSUE_QUERY_UPLOAD) private readonly issue: IssueQueryUpload,
    @Inject(SEARCH_BY_IMAGE) private readonly search: SearchByImage,
    @Inject(SIMILAR_BY_PRODUCT) private readonly similar: SimilarByProduct,
  ) {}

  @Post("search/visual/uploads")
  @HttpCode(201)
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 10, windowSeconds: 60 }])
  async postUpload(@Req() req: ApiRequest, @Body(new ZodPipe(UploadBody)) b: z.infer<typeof UploadBody>) {
    const r = await this.issue.execute({ userId: principalOf(req).actor.id, contentType: b.content_type, sizeBytes: b.size_bytes });
    if (r.kind === "disabled") throw Problems.unavailable("visual_search_disabled");
    if (r.kind === "unavailable") throw Problems.unavailable("visual_search_unavailable");
    if (r.kind === "too_large") throw Problems.validation([{ pointer: "/size_bytes", code: "too_large" }]);
    return {
      upload_id: r.upload.uploadId,
      url: r.upload.url,
      headers: r.upload.headers,
      expires_at: new Date(r.upload.expiresAtMs).toISOString(),
    };
  }

  @Post("search/visual")
  @HttpCode(200)
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 10, windowSeconds: 60 }])
  async postSearch(@Req() req: ApiRequest, @Body(new ZodPipe(SearchBody)) b: z.infer<typeof SearchBody>) {
    const r = await this.search.execute({
      userId: principalOf(req).actor.id,
      uploadId: b.upload_id,
      ...(b.crop === undefined ? {} : { crop: b.crop }),
      ...(b.category_hint === undefined ? {} : { categoryHint: b.category_hint }),
      filters: filtersOf(b.filters),
      limit: b.limit,
    });
    switch (r.kind) {
      case "ok":
        return outputWire(r);
      case "disabled":
        throw Problems.unavailable("visual_search_disabled");
      case "quota":
        if (r.scope === "global") throw Problems.unavailable("visual_search_capacity");
        throw new ProblemError(429, "rate-limited", "Daily visual search limit reached", { code: "daily_limit", headers: { "Retry-After": "3600" } });
      case "upload_not_found":
        throw Problems.notFound();
      case "upload_not_ready":
        throw new ProblemError(409, "upload-not-ready", "The image is still being checked", { code: "upload_not_ready", headers: { "Retry-After": "1" } });
      case "rejected":
        throw new ProblemError(422, "image-rejected", "This image cannot be searched", { code: `image_${r.reason}` });
      case "consent_required":
        throw Problems.forbidden("consent_required");
      case "embedder_unavailable":
        throw Problems.unavailable("embedder_unavailable");
      case "index_unavailable":
        throw Problems.unavailable("index_unavailable");
    }
  }

  @Get("products/:productId/visually-similar")
  @Public()
  @RateLimit([{ dimension: "ip", limit: 60, windowSeconds: 60 }])
  async getSimilar(
    @Param(new ZodPipe(SimilarParams, "/params")) p: z.infer<typeof SimilarParams>,
    @Query(new ZodPipe(SimilarQuery, "/query")) q: z.infer<typeof SimilarQuery>,
  ) {
    const r = await this.similar.execute({
      userId: null,
      productId: p.productId.toLowerCase(),
      filters: q.world === undefined ? {} : { world: q.world },
      limit: q.limit,
    });
    if (r.kind === "disabled") throw Problems.unavailable("visual_search_disabled");
    if (r.kind === "not_found") throw Problems.notFound();
    return outputWire(r.result);
  }
}
