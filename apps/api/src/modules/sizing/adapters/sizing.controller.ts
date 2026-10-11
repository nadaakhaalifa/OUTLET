import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query, Req, Res } from "@nestjs/common";
import { sha256Hex } from "@outlet/idempotency";
import { UuidSchema } from "@outlet/validation";
import { z } from "zod";
import { AuthenticatedSelf, Authorize, Idempotent, RateLimit } from "../../../platform/decorators";
import { headerValue, type ApiRequest, type ApiResponse } from "../../../platform/http-types";
import { ProblemError, Problems } from "../../../platform/problem";
import { ZodPipe } from "../../../platform/zod.pipe";
import type { CreateSizeChart, GetSizeDemand, ListSizeCharts } from "../application/charts";
import { CipherUnavailableError, type ProfileView } from "../application/codec";
import type { SubmitFitFeedback } from "../application/feedback";
import type {
  CreateSizeProfile,
  DeleteSizeProfile,
  GetSizeProfile,
  ListSizeProfiles,
  ProfileFailure,
  UpdateSizeProfile,
} from "../application/profiles";
import type { FitRecommendationView, RecommendFit, RecommendOutcome } from "../application/recommend";
import { FIT_PREFERENCES, FIT_RATINGS, MEASURE_KEYS, K_ANONYMITY_MIN, SIZE_LABEL } from "../domain/bridge";
import type { StoredChart } from "../domain/ports";
import {
  CREATE_SIZE_CHART,
  CREATE_SIZE_PROFILE,
  DELETE_SIZE_PROFILE,
  GET_SIZE_DEMAND,
  GET_SIZE_PROFILE,
  LIST_SIZE_CHARTS,
  LIST_SIZE_PROFILES,
  RECOMMEND_FIT,
  SIZING_STORE_RESOLVER,
  SUBMIT_FIT_FEEDBACK,
  UPDATE_SIZE_PROFILE,
} from "./tokens";

// ---- Schemas (strict allow-lists, API3) -------------------------------------------------------

const Num = z.number();
const MeasurementsSchema = z
  .object(Object.fromEntries(MEASURE_KEYS.map((k) => [k, Num.optional()])) as Record<(typeof MEASURE_KEYS)[number], z.ZodOptional<typeof Num>>)
  .strict();

const KindSchema = z.enum(["me", "partner", "child"]);
const UsualSizeSchema = z
  .object({ brand_id: UuidSchema.optional(), size_label: z.string().min(1).max(12) })
  .strict();

const ProfileInputSchema = z
  .object({
    label: z.string().min(1).max(40),
    kind: KindSchema,
    fit_preference: z.enum(FIT_PREFERENCES).optional(),
    modest_fit: z.boolean().optional(),
    measurements: MeasurementsSchema.optional(),
    usual_size: UsualSizeSchema.optional(),
  })
  .strict();

const ProfilePatchSchema = z
  .object({
    label: z.string().min(1).max(40).optional(),
    kind: KindSchema.optional(),
    fit_preference: z.enum(FIT_PREFERENCES).optional(),
    modest_fit: z.boolean().optional(),
    measurements: MeasurementsSchema.optional(),
    usual_size: UsualSizeSchema.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "at least one property is required" });

const ListQuerySchema = z
  .object({
    cursor: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[A-Za-z0-9_-]+={0,2}$/)
      .optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();

const RecommendQuerySchema = z.object({ sku_group: UuidSchema, profile_id: UuidSchema }).strict();
const ProductFitQuerySchema = z.object({ profile_id: UuidSchema }).strict();

const FeedbackSchema = z
  .object({
    rating: z.enum(FIT_RATINGS),
    area: z.enum(["chest", "waist", "hips", "length", "shoulders", "sleeves", "overall"]).optional(),
  })
  .strict();

const ChartInputSchema = z
  .object({
    product_type: z.string().min(1).max(60),
    unit: z.enum(["cm", "in"]),
    rows: z
      .array(
        z
          .object({
            size_label: z.string().regex(SIZE_LABEL, "size label may use letters, digits, space . / + - only"),
            measurements: MeasurementsSchema,
          })
          .strict(),
      )
      .min(1)
      .max(30),
  })
  .strict();

// ---- Wire mapping -----------------------------------------------------------------------------

const iso = (ms: number): string => new Date(ms).toISOString();

function compact<T extends Record<string, number | undefined>>(o: T): Record<string, number> {
  return Object.fromEntries(Object.entries(o).filter((e): e is [string, number] => e[1] !== undefined));
}

function profileWire(v: ProfileView) {
  return {
    id: v.id,
    label: v.label,
    kind: v.kind,
    fit_preference: v.fitPreference,
    modest_fit: v.modestFit,
    ...(v.measurements !== null ? { measurements: compact(v.measurements) } : {}),
    ...(v.usualSize !== null
      ? {
          usual_size: {
            size_label: v.usualSize.sizeLabel,
            ...(v.usualSize.brandId !== null ? { brand_id: v.usualSize.brandId } : {}),
          },
        }
      : {}),
    updated_at: iso(v.updatedAtMs),
  };
}

function fitWire(v: FitRecommendationView) {
  return {
    size: v.size,
    confidence: v.confidence,
    explanation: v.explanation.map((e) => ({ ar: e.ar, en: e.en })),
    alternatives: v.alternatives.map((a) => ({ size: a.size, reason: { ar: a.reason.ar, en: a.reason.en } })),
    community_fit:
      v.communityFit === null ? null : { tendency: v.communityFit.tendency, sample_size: v.communityFit.sampleSize },
    model: v.model,
  };
}

function chartWire(c: StoredChart) {
  return {
    id: c.id,
    product_type: c.productType,
    // Stored and returned in cm: inches are normalised on the way in.
    unit: "cm" as const,
    rows: c.rows.map((r) => ({ size_label: r.sizeLabel, measurements: compact(r.measurements) })),
    validated: c.validated,
    ...(c.validationErrors.length > 0
      ? { validation_errors: c.validationErrors.map((e) => ({ size_label: e.sizeLabel, code: e.code })) }
      : {}),
  };
}

const etagOf = (wire: unknown): string => `"${sha256Hex(JSON.stringify(wire)).slice(0, 32)}"`;
function tagMatches(header: string, etag: string): boolean {
  return header.split(",").some((t) => {
    const tag = t.trim();
    return tag === "*" || tag === etag || tag === `W/${etag}`;
  });
}

const unprocessable = (code: string, title: string) => new ProblemError(422, code.replace(/_/g, "-"), title, { code });

function userIdOf(req: ApiRequest): string {
  const id = req.principal?.actor.id;
  if (id === undefined) throw Problems.unauthenticated();
  return id;
}

function storeIdOf(req: ApiRequest): string {
  const g = req.principal?.actor.grants.find((x) => x.kind === "brand");
  if (g === undefined || g.kind !== "brand") throw Problems.notFound();
  return g.storeId;
}

function invalidCursor(): ProblemError {
  return new ProblemError(400, "validation-failed", "Request validation failed", {
    code: "invalid_cursor",
    errors: [{ pointer: "/query/cursor", code: "invalid_cursor" }],
  });
}

function failProfile(f: ProfileFailure): never {
  switch (f.kind) {
    case "label_invalid":
      throw Problems.validation([{ pointer: "/body/label", code: "invalid_label" }]);
    case "limit_reached":
      throw unprocessable("profile_limit_reached", "You have reached the maximum number of size profiles");
    case "consent_required":
      throw unprocessable("measurements_consent_required", "Consent to use measurements is required");
    case "invalid_measurements":
      throw Problems.validation(f.errors.map((e) => ({ pointer: `/body/measurements/${e.key}`, code: e.code })));
  }
}

function failRecommend(o: Exclude<RecommendOutcome, { kind: "ok" }>): never {
  switch (o.kind) {
    case "profile_not_found":
    case "product_not_found":
      throw Problems.notFound();
    case "fit_unavailable":
      throw new ProblemError(404, "fit-unavailable", "No size recommendation is available for this product", {
        code: "fit_unavailable",
      });
    case "consent_required":
      throw unprocessable("measurements_consent_required", "Consent to use measurements is required");
    case "measurements_required":
      throw unprocessable("measurements_required", "Add measurements or your usual size to get a recommendation");
  }
}

/** A cipher outage must never fall back to plaintext: the request fails closed with 503. */
async function guardCipher<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof CipherUnavailableError) throw Problems.unavailable("encryption_unavailable");
    throw e;
  }
}

const SELLER = (action: "read" | "create") =>
  Authorize({
    action,
    resourceType: "store_product",
    resolver: SIZING_STORE_RESOLVER,
    idParam: "storeScope",
    audience: "seller_api",
  });

@Controller()
export class SizingController {
  constructor(
    @Inject(CREATE_SIZE_PROFILE) private readonly createProfile: CreateSizeProfile,
    @Inject(LIST_SIZE_PROFILES) private readonly listProfiles: ListSizeProfiles,
    @Inject(GET_SIZE_PROFILE) private readonly getProfile: GetSizeProfile,
    @Inject(UPDATE_SIZE_PROFILE) private readonly updateProfile: UpdateSizeProfile,
    @Inject(DELETE_SIZE_PROFILE) private readonly deleteProfile: DeleteSizeProfile,
    @Inject(RECOMMEND_FIT) private readonly recommend: RecommendFit,
    @Inject(SUBMIT_FIT_FEEDBACK) private readonly submitFeedback: SubmitFitFeedback,
    @Inject(CREATE_SIZE_CHART) private readonly createChart: CreateSizeChart,
    @Inject(LIST_SIZE_CHARTS) private readonly listCharts: ListSizeCharts,
    @Inject(GET_SIZE_DEMAND) private readonly demand: GetSizeDemand,
  ) {}

  // ---- Buyer: profiles --------------------------------------------------------------------

  @Get("me/size-profiles")
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async list(@Req() req: ApiRequest, @Query(new ZodPipe(ListQuerySchema, "/query")) q: z.infer<typeof ListQuerySchema>) {
    const r = await guardCipher(() => this.listProfiles.execute(userIdOf(req), { cursor: q.cursor ?? null, limit: q.limit }));
    if (r.kind === "invalid_cursor") throw invalidCursor();
    return { items: r.items.map(profileWire), page: { next_cursor: r.nextCursor, has_more: r.nextCursor !== null } };
  }

  @Post("me/size-profiles")
  @AuthenticatedSelf()
  @Idempotent({ required: false })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async create(@Req() req: ApiRequest, @Body(new ZodPipe(ProfileInputSchema)) b: z.infer<typeof ProfileInputSchema>) {
    const r = await guardCipher(() =>
      this.createProfile.execute(userIdOf(req), {
        label: b.label,
        kind: b.kind,
        ...(b.fit_preference !== undefined ? { fitPreference: b.fit_preference } : {}),
        ...(b.modest_fit !== undefined ? { modestFit: b.modest_fit } : {}),
        ...(b.measurements !== undefined ? { measurements: compact(b.measurements) } : {}),
        ...(b.usual_size !== undefined
          ? { usualSize: { brandId: b.usual_size.brand_id ?? null, sizeLabel: b.usual_size.size_label } }
          : {}),
      }),
    );
    if (r.kind !== "created") failProfile(r);
    return profileWire(r.view);
  }

  @Get("me/size-profiles/:profileId")
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async get(@Req() req: ApiRequest, @Res({ passthrough: true }) res: ApiResponse, @Param("profileId") profileId: string) {
    const v = await guardCipher(() => this.getProfile.execute(userIdOf(req), profileId));
    if (v === null) throw Problems.notFound();
    const wire = profileWire(v);
    const etag = etagOf(wire);
    res.setHeader("ETag", etag);
    res.setHeader("Cache-Control", "private, no-cache");
    const inm = headerValue(req, "if-none-match");
    if (inm !== undefined && tagMatches(inm, etag)) throw new ProblemError(304, "not-modified", "Not modified");
    return wire;
  }

  @Patch("me/size-profiles/:profileId")
  @HttpCode(200)
  @AuthenticatedSelf()
  @Idempotent({ required: false })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async update(
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: ApiResponse,
    @Param("profileId") profileId: string,
    @Body(new ZodPipe(ProfilePatchSchema)) b: z.infer<typeof ProfilePatchSchema>,
  ) {
    const ifMatch = headerValue(req, "if-match");
    if (ifMatch === undefined || ifMatch.trim() === "") {
      throw new ProblemError(428, "precondition-required", "If-Match is required for this update", {
        code: "precondition_required",
      });
    }
    const r = await guardCipher(() =>
      this.updateProfile.execute(
        userIdOf(req),
        profileId,
        {
          ...(b.label !== undefined ? { label: b.label } : {}),
          ...(b.kind !== undefined ? { kind: b.kind } : {}),
          ...(b.fit_preference !== undefined ? { fitPreference: b.fit_preference } : {}),
          ...(b.modest_fit !== undefined ? { modestFit: b.modest_fit } : {}),
          ...(b.measurements !== undefined ? { measurements: compact(b.measurements) } : {}),
          ...(b.usual_size !== undefined
            ? { usualSize: { brandId: b.usual_size.brand_id ?? null, sizeLabel: b.usual_size.size_label } }
            : {}),
        },
        (current) => tagMatches(ifMatch, etagOf(profileWire(current))),
      ),
    );
    switch (r.kind) {
      case "updated": {
        const wire = profileWire(r.view);
        res.setHeader("ETag", etagOf(wire));
        return wire;
      }
      case "not_found":
        throw Problems.notFound();
      case "precondition_failed":
        throw new ProblemError(412, "precondition-failed", "The profile changed; reload and try again", {
          code: "precondition_failed",
        });
      default:
        return failProfile(r);
    }
  }

  @Delete("me/size-profiles/:profileId")
  @HttpCode(204)
  @AuthenticatedSelf()
  @Idempotent({ required: false })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async remove(@Req() req: ApiRequest, @Param("profileId") profileId: string): Promise<void> {
    const r = await this.deleteProfile.execute(userIdOf(req), profileId);
    if (r === "not_found") throw Problems.notFound();
  }

  // ---- Buyer: fit -------------------------------------------------------------------------

  @Get("fit/recommend")
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async recommendFit(
    @Req() req: ApiRequest,
    @Query(new ZodPipe(RecommendQuerySchema, "/query")) q: z.infer<typeof RecommendQuerySchema>,
  ) {
    const o = await guardCipher(() => this.recommend.execute(userIdOf(req), q.sku_group, q.profile_id));
    if (o.kind !== "ok") failRecommend(o);
    return fitWire(o.view);
  }

  @Get("products/:productId/fit")
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async productFit(
    @Req() req: ApiRequest,
    @Param("productId") productId: string,
    @Query(new ZodPipe(ProductFitQuerySchema, "/query")) q: z.infer<typeof ProductFitQuerySchema>,
  ) {
    const o = await guardCipher(() => this.recommend.execute(userIdOf(req), productId, q.profile_id));
    if (o.kind !== "ok") failRecommend(o);
    return fitWire(o.view);
  }

  @Post("orders/lines/:orderLineId/fit-feedback")
  @HttpCode(204)
  @AuthenticatedSelf()
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async feedback(
    @Req() req: ApiRequest,
    @Param("orderLineId") orderLineId: string,
    @Body(new ZodPipe(FeedbackSchema)) b: z.infer<typeof FeedbackSchema>,
  ): Promise<void> {
    const r = await this.submitFeedback.execute(userIdOf(req), orderLineId, {
      rating: b.rating,
      area: b.area ?? null,
      profileId: null,
    });
    switch (r.kind) {
      case "recorded":
        return;
      case "not_found":
        throw Problems.notFound();
      case "not_delivered":
        throw unprocessable("line_not_delivered", "Fit feedback is accepted after delivery");
      case "duplicate":
        throw new ProblemError(409, "feedback-exists", "Feedback was already submitted for this item", {
          code: "feedback_exists",
        });
    }
  }

  // ---- Seller -----------------------------------------------------------------------------

  @Get("seller/size-charts")
  @SELLER("read")
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async charts(@Req() req: ApiRequest, @Query(new ZodPipe(ListQuerySchema, "/query")) q: z.infer<typeof ListQuerySchema>) {
    const r = await this.listCharts.execute(storeIdOf(req), { cursor: q.cursor ?? null, limit: q.limit });
    if (r === "invalid_cursor") throw invalidCursor();
    return { items: r.items.map(chartWire), page: { next_cursor: r.nextCursor, has_more: r.nextCursor !== null } };
  }

  @Post("seller/size-charts")
  @SELLER("create")
  @Idempotent({ required: false })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async chartCreate(@Req() req: ApiRequest, @Body(new ZodPipe(ChartInputSchema)) b: z.infer<typeof ChartInputSchema>) {
    const chart = await this.createChart.execute(storeIdOf(req), {
      productType: b.product_type,
      unit: b.unit,
      rows: b.rows.map((r) => ({ sizeLabel: r.size_label, measurements: compact(r.measurements) })),
    });
    return chartWire(chart);
  }

  /** Not in openapi.yaml yet (reported). Aggregates only, cells below k = 50 never leave. */
  @Get("seller/size-demand")
  @SELLER("read")
  @RateLimit([{ dimension: "user", limit: 30, windowSeconds: 60 }])
  async sizeDemand(@Req() req: ApiRequest) {
    const cells = await this.demand.execute(storeIdOf(req));
    return {
      items: cells.map((c) => ({
        product_type: c.productType,
        size_label: c.sizeLabel,
        week: c.week,
        demand_count: c.demandCount,
      })),
      min_cell_size: K_ANONYMITY_MIN,
    };
  }
}
