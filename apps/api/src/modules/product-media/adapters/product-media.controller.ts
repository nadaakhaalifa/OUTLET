import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req } from "@nestjs/common";
import { z } from "zod";
import { Authorize, Idempotent, RateLimit } from "../../../platform/decorators";
import type { ApiRequest } from "../../../platform/http-types";
import { ProblemError, Problems } from "../../../platform/problem";
import { ZodPipe } from "../../../platform/zod.pipe";
import type { ListProductVersions, RefineProductPhoto, RestoreProductVersion } from "../application/refine";
import type {
  DecideProductPhoto,
  GetProductPhoto,
  IssueProductPhotoUpload,
  ListProductPhotos,
  ProcessProductPhoto,
  ProcessResult,
  RerunProductPhoto,
} from "../application/product-media";
import { BG_MODELS, REFINE_LIMITS } from "../domain/ports";
import {
  DECIDE_PRODUCT_PHOTO,
  GET_PRODUCT_PHOTO,
  ISSUE_PRODUCT_PHOTO_UPLOAD,
  LIST_PRODUCT_PHOTOS,
  LIST_PRODUCT_VERSIONS,
  PROCESS_PRODUCT_PHOTO,
  PRODUCT_MEDIA_RESOLVER,
  PRODUCT_MEDIA_STORE_RESOLVER,
  REFINE_PRODUCT_PHOTO,
  RERUN_PRODUCT_PHOTO,
  RESTORE_PRODUCT_VERSION,
} from "./tokens";
import { jobWire, summaryWire, versionWire } from "./wire";

const MAX_BYTES = 12 * 1024 * 1024;
const StoreParams = z.object({ storeId: z.uuid() }).strict();
const JobParams = z.object({ storeId: z.uuid(), jobId: z.uuid() }).strict();
/** Strict bodies: unknown fields are refused (mass assignment, API3). */
const UploadBody = z
  .object({ content_type: z.enum(["image/jpeg", "image/png", "image/webp"]), size_bytes: z.number().int().min(1).max(MAX_BYTES) })
  .strict();
const RerunBody = z.object({ model: z.enum(BG_MODELS) }).strict();
const NoBody = z.object({}).strict().optional();
const Coord = z.number().min(0).max(1);
const Stroke = z
  .object({
    mode: z.enum(["erase", "restore"]),
    radius: z.number().gt(0).max(REFINE_LIMITS.maxRadius),
    points: z.array(z.tuple([Coord, Coord])).min(1).max(REFINE_LIMITS.maxPointsPerStroke),
  })
  .strict();
/** At least one stroke or a changed setting is not required: re-rendering with new settings is a valid edit. */
const RefineBody = z
  .object({
    strokes: z.array(Stroke).max(REFINE_LIMITS.maxStrokes).default([]),
    feather_px: z.number().min(0).max(8).default(1.5),
    smooth: z.number().min(0).max(1).default(0),
    edge_shift_px: z.number().min(-3).max(3).default(0),
    background: z.enum(["transparent", "white", "studio"]).default("transparent"),
    base_version: z.number().int().min(0).max(100_000).optional(),
  })
  .strict()
  .refine((b) => b.strokes.reduce((n, s) => n + s.points.length, 0) <= REFINE_LIMITS.maxTotalPoints, {
    message: `at most ${REFINE_LIMITS.maxTotalPoints} points in total`,
    path: ["strokes"],
  });
const VersionParams = z
  .object({ storeId: z.uuid(), jobId: z.uuid(), version: z.string().regex(/^[1-9][0-9]{0,5}$/).transform(Number) })
  .strict();

const principalOf = (req: ApiRequest) => {
  const p = req.principal;
  if (p === null || p === undefined) throw Problems.unauthenticated();
  return p;
};
const disabled = () => Problems.unavailable("background_removal_disabled");
const unconfigured = () => Problems.unavailable("provider_not_configured");
const conflict = (code: string, title: string) => new ProblemError(409, code.replace(/_/g, "-"), title, { code });

function failure(r: Exclude<ProcessResult, { kind: "ok" }>): never {
  switch (r.kind) {
    case "disabled":
      throw disabled();
    case "unconfigured":
      throw unconfigured();
    case "not_found":
      throw Problems.notFound();
    case "consent_required":
      throw new ProblemError(403, "consent-required", "The cross-border processing consent is required", { code: "consent_required" });
    case "upload_not_ready":
      throw conflict("upload_not_ready", "The original is not uploaded or scanned yet");
    case "quota_exceeded":
      throw new ProblemError(429, "quota-exceeded", "The store's daily background-removal quota is used", { code: "quota_exceeded" });
    case "attempts_exceeded":
      throw conflict("attempts_exceeded", "This photo reached its re-run limit");
  }
}

@Controller("seller/stores/:storeId/product-media")
export class ProductMediaController {
  constructor(
    @Inject(ISSUE_PRODUCT_PHOTO_UPLOAD) private readonly issue: IssueProductPhotoUpload,
    @Inject(PROCESS_PRODUCT_PHOTO) private readonly process: ProcessProductPhoto,
    @Inject(DECIDE_PRODUCT_PHOTO) private readonly decide: DecideProductPhoto,
    @Inject(RERUN_PRODUCT_PHOTO) private readonly rerun: RerunProductPhoto,
    @Inject(GET_PRODUCT_PHOTO) private readonly get: GetProductPhoto,
    @Inject(LIST_PRODUCT_PHOTOS) private readonly list: ListProductPhotos,
    @Inject(REFINE_PRODUCT_PHOTO) private readonly refineUc: RefineProductPhoto,
    @Inject(LIST_PRODUCT_VERSIONS) private readonly versionsUc: ListProductVersions,
    @Inject(RESTORE_PRODUCT_VERSION) private readonly restoreUc: RestoreProductVersion,
  ) {}

  @Get()
  @Authorize({ audience: "seller_api", action: "read", resourceType: "store_product", resolver: PRODUCT_MEDIA_STORE_RESOLVER, idParam: "storeId" })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async jobs(@Param(new ZodPipe(StoreParams, "/params")) p: z.infer<typeof StoreParams>) {
    const items = await this.list.execute({ storeId: p.storeId.toLowerCase() });
    return { items: items.map(summaryWire) };
  }

  @Post("uploads")
  @HttpCode(201)
  @Authorize({ audience: "seller_api", action: "create", resourceType: "store_product", resolver: PRODUCT_MEDIA_STORE_RESOLVER, idParam: "storeId" })
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 3600 }])
  async createUpload(
    @Req() req: ApiRequest,
    @Param(new ZodPipe(StoreParams, "/params")) p: z.infer<typeof StoreParams>,
    @Body(new ZodPipe(UploadBody)) body: z.output<typeof UploadBody>,
  ) {
    const r = await this.issue.execute({
      storeId: p.storeId.toLowerCase(),
      actorId: principalOf(req).actor.id,
      contentType: body.content_type,
      sizeBytes: body.size_bytes,
    });
    if (r.kind === "storage_unconfigured") throw Problems.unavailable("product_media_storage_unconfigured");
    if (r.kind !== "issued") throw Problems.unavailable("service_unavailable");
    return {
      job_id: r.job.id,
      status: r.job.status,
      upload: { upload_id: r.upload.uploadId, url: r.upload.url, headers: r.upload.headers, expires_at: new Date(r.upload.expiresAtMs).toISOString() },
    };
  }

  @Post(":jobId/process")
  @HttpCode(200)
  @Authorize({ audience: "seller_api", action: "update", resourceType: "store_product", resolver: PRODUCT_MEDIA_RESOLVER, idParam: "jobId" })
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 3600 }])
  async run(@Param(new ZodPipe(JobParams, "/params")) p: z.infer<typeof JobParams>, @Body(new ZodPipe(NoBody)) _body: unknown) {
    void _body;
    const r = await this.process.execute({ storeId: p.storeId.toLowerCase(), jobId: p.jobId.toLowerCase() });
    if (r.kind !== "ok") failure(r);
    return jobWire(r.view);
  }

  @Get(":jobId")
  @Authorize({ audience: "seller_api", action: "read", resourceType: "store_product", resolver: PRODUCT_MEDIA_RESOLVER, idParam: "jobId" })
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async status(@Param(new ZodPipe(JobParams, "/params")) p: z.infer<typeof JobParams>) {
    const v = await this.get.execute({ storeId: p.storeId.toLowerCase(), jobId: p.jobId.toLowerCase() });
    if (v === null) throw Problems.notFound();
    return jobWire(v);
  }

  @Post(":jobId/accept")
  @HttpCode(200)
  @Authorize({ audience: "seller_api", action: "update", resourceType: "store_product", resolver: PRODUCT_MEDIA_RESOLVER, idParam: "jobId" })
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async accept(@Param(new ZodPipe(JobParams, "/params")) p: z.infer<typeof JobParams>, @Body(new ZodPipe(NoBody)) _body: unknown) {
    void _body;
    return this.decideWith(p, "accepted");
  }

  @Post(":jobId/use-original")
  @HttpCode(200)
  @Authorize({ audience: "seller_api", action: "update", resourceType: "store_product", resolver: PRODUCT_MEDIA_RESOLVER, idParam: "jobId" })
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async useOriginal(@Param(new ZodPipe(JobParams, "/params")) p: z.infer<typeof JobParams>, @Body(new ZodPipe(NoBody)) _body: unknown) {
    void _body;
    return this.decideWith(p, "use_original");
  }

  @Post(":jobId/rerun")
  @HttpCode(200)
  @Authorize({ audience: "seller_api", action: "update", resourceType: "store_product", resolver: PRODUCT_MEDIA_RESOLVER, idParam: "jobId" })
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 30, windowSeconds: 3600 }])
  async rerunWith(@Param(new ZodPipe(JobParams, "/params")) p: z.infer<typeof JobParams>, @Body(new ZodPipe(RerunBody)) body: z.output<typeof RerunBody>) {
    const r = await this.rerun.execute({ storeId: p.storeId.toLowerCase(), jobId: p.jobId.toLowerCase(), model: body.model });
    if (r.kind === "invalid_state") throw conflict("invalid_state", `A ${r.status} photo cannot be re-run`);
    if (r.kind === "conflict") throw conflict("version_conflict", "The photo changed, retry");
    if (r.kind !== "ok") failure(r);
    return jobWire(r.view);
  }

  /** Brush/edge edit of the current cutout. Writes a new immutable version; 30 edits per photo, 0.25 run each on the daily quota. */
  @Post(":jobId/refine")
  @HttpCode(200)
  @Authorize({ audience: "seller_api", action: "update", resourceType: "store_product", resolver: PRODUCT_MEDIA_RESOLVER, idParam: "jobId" })
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 30, windowSeconds: 60 }])
  async refine(@Param(new ZodPipe(JobParams, "/params")) p: z.infer<typeof JobParams>, @Body(new ZodPipe(RefineBody)) body: z.output<typeof RefineBody>) {
    const r = await this.refineUc.execute({
      storeId: p.storeId.toLowerCase(),
      jobId: p.jobId.toLowerCase(),
      strokes: body.strokes,
      featherPx: body.feather_px,
      smooth: body.smooth,
      edgeShiftPx: body.edge_shift_px,
      background: body.background,
      baseVersion: body.base_version,
    });
    switch (r.kind) {
      case "ok":
        return { ...jobWire(r.view), versions: r.versions.map(versionWire) };
      case "disabled":
        throw disabled();
      case "unconfigured":
        throw unconfigured();
      case "not_found":
        throw Problems.notFound();
      case "consent_required":
        throw new ProblemError(403, "consent-required", "The cross-border processing consent is required", { code: "consent_required" });
      case "invalid_state":
        throw conflict("invalid_state", `A ${r.status} photo cannot be edited`);
      case "edits_exceeded":
        throw conflict("edits_exceeded", "This photo reached its edit limit");
      case "base_version_conflict":
        throw new ProblemError(409, "version-conflict", "The cutout changed since this edit started", { code: "version_conflict", extensions: { current_version: r.current } });
      case "quota_exceeded":
        throw new ProblemError(429, "quota-exceeded", "The store's daily background-removal quota is used", { code: "quota_exceeded" });
      case "conflict":
        throw conflict("version_conflict", "The photo changed, retry");
      case "invalid_edit":
        throw new ProblemError(422, "invalid-edit", "The edit is out of range", { code: "invalid_edit" });
      case "params_too_large":
        throw new ProblemError(422, "edit-too-large", "The edit is too large to store", { code: "edit_too_large" });
      case "refine_failed":
        if (r.code === "timeout") throw new ProblemError(504, "refine-timeout", "The editor timed out, retry", { code: "refine_timeout" });
        if (r.code.startsWith("image_") || r.code === "image_rejected" || r.code === "too_large") {
          throw new ProblemError(422, "image-rejected", "The image cannot be edited", { code: "image_rejected" });
        }
        throw new ProblemError(502, "refine-failed", "The editor failed, retry", { code: "refine_failed" });
    }
  }

  @Get(":jobId/versions")
  @Authorize({ audience: "seller_api", action: "read", resourceType: "store_product", resolver: PRODUCT_MEDIA_RESOLVER, idParam: "jobId" })
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async versions(@Param(new ZodPipe(JobParams, "/params")) p: z.infer<typeof JobParams>) {
    const r = await this.versionsUc.execute({ storeId: p.storeId.toLowerCase(), jobId: p.jobId.toLowerCase() });
    if (r.kind === "not_found") throw Problems.notFound();
    return { current_version: r.current, items: r.versions.map(versionWire) };
  }

  /** Undo / redo: makes an existing version current. No sidecar call, no quota. */
  @Post(":jobId/versions/:version/restore")
  @HttpCode(200)
  @Authorize({ audience: "seller_api", action: "update", resourceType: "store_product", resolver: PRODUCT_MEDIA_RESOLVER, idParam: "jobId" })
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async restore(@Param(new ZodPipe(VersionParams, "/params")) p: z.infer<typeof VersionParams>, @Body(new ZodPipe(NoBody)) _body: unknown) {
    void _body;
    const r = await this.restoreUc.execute({ storeId: p.storeId.toLowerCase(), jobId: p.jobId.toLowerCase(), version: p.version });
    if (r.kind === "not_found") throw Problems.notFound();
    if (r.kind === "invalid_state") throw conflict("invalid_state", `A ${r.status} photo cannot be restored`);
    if (r.kind === "conflict") throw conflict("version_conflict", "The photo changed, retry");
    return { ...jobWire(r.view), versions: r.versions.map(versionWire) };
  }

  private async decideWith(p: z.infer<typeof JobParams>, decision: "accepted" | "use_original") {
    const r = await this.decide.execute({ storeId: p.storeId.toLowerCase(), jobId: p.jobId.toLowerCase(), decision });
    if (r.kind === "not_found") throw Problems.notFound();
    if (r.kind === "invalid_state") throw conflict("invalid_state", `A ${r.status} photo cannot take this decision`);
    if (r.kind === "conflict") throw conflict("version_conflict", "The photo changed, retry");
    return jobWire(r.view);
  }
}
