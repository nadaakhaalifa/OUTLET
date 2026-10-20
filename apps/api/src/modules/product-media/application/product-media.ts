import { sanitizeImage } from "../../visual-search";
import { BackgroundRemovalError, BG_MODELS, DEFAULT_BG_MODEL, DEFAULT_CUTOUT_OPTIONS, FLAG_BACKGROUND_REMOVAL } from "../domain/ports";
import type { BgModel, DerivativeKind, ImageMime, IssuedUpload, JobPatch, ProductMediaJob } from "../domain/ports";
import { canDecide, STALE_PROCESSING_MS } from "../domain/machine";
import { assessQuality, isReady } from "../domain/quality";
import { nextVersionNumber } from "../domain/edit";
import { pruneVersions } from "./versions";
import { flagOn, utcDay, viewOf, withTimeout, type JobView, type ProductMediaDeps } from "./shared";

export type Failure =
  | { readonly kind: "disabled" }
  | { readonly kind: "unconfigured" }
  | { readonly kind: "not_found" }
  | { readonly kind: "consent_required" };

export type IssueResult = { readonly kind: "issued"; readonly job: ProductMediaJob; readonly upload: IssuedUpload } | Failure | { readonly kind: "storage_unconfigured" };

/** Issues a signed PUT for the original and records the job (status PENDING). The original stays private. */
export class IssueProductPhotoUpload {
  constructor(private readonly d: ProductMediaDeps) {}
  async execute(i: { storeId: string; actorId: string; contentType: ImageMime; sizeBytes: number }): Promise<IssueResult> {
    const { d } = this;
    if (!d.blobs.configured) return { kind: "storage_unconfigured" };
    if (i.sizeBytes < 1 || i.sizeBytes > d.cfg.maxBytes) throw new RangeError("size out of range");
    const upload = await d.blobs.issueUpload({ storeId: i.storeId, contentType: i.contentType, sizeBytes: i.sizeBytes });
    const now = d.clock.nowMs();
    const job: ProductMediaJob = {
      id: d.ids.uuidV7(),
      storeId: i.storeId,
      createdBy: i.actorId,
      originalRef: upload.uploadId,
      contentType: i.contentType,
      sizeBytes: i.sizeBytes,
      status: "PENDING",
      decision: "none",
      requestedModel: null,
      modelId: null,
      modelVersion: null,
      qualityScore: null,
      qualityReasons: [],
      pngRef: null,
      whiteJpgRef: null,
      shadowRef: null,
      latencyMs: null,
      errorCode: null,
      attempts: 0,
      attachedProductId: null,
      promotedImageRef: null,
      promotedCutoutRef: null,
      currentVersion: 0,
      editCount: 0,
      promotedVersion: 0,
      backgroundRenderRef: null,
      version: 1,
      createdAtMs: now,
      updatedAtMs: now,
    };
    await d.store.insertJob(job);
    return { kind: "issued", job, upload };
  }
}

export type ProcessResult =
  | { readonly kind: "ok"; readonly view: JobView; readonly ran: boolean }
  | { readonly kind: "disabled" }
  | { readonly kind: "unconfigured" }
  | { readonly kind: "not_found" }
  | { readonly kind: "consent_required" }
  | { readonly kind: "upload_not_ready"; readonly state: "missing" | "pending_scan" }
  | { readonly kind: "quota_exceeded" }
  | { readonly kind: "attempts_exceeded" };

const failCode = (e: unknown): string => {
  if (e instanceof BackgroundRemovalError) return e.code;
  if (e instanceof Error && e.message === "timeout") return "timeout";
  return "provider_error";
};

/**
 * The pipeline: validate (type, 12 MB, 4096 px), strip metadata, cut out in the sidecar (which also cleans
 * edges, crops and renders the white-background and shadow variants), score quality, store private
 * derivatives. Idempotent per upload: a job that is not PENDING is returned as is.
 */
export class ProcessProductPhoto {
  constructor(private readonly d: ProductMediaDeps) {}

  async execute(i: { storeId: string; jobId: string; model?: BgModel }): Promise<ProcessResult> {
    const { d } = this;
    if (!(await flagOn(d.flags, FLAG_BACKGROUND_REMOVAL))) return { kind: "disabled" };
    if (!d.removal.configured || !d.blobs.configured) return { kind: "unconfigured" };
    if (d.removal.residency === "external" && !(await d.consent.crossBorderMlGranted(i.storeId))) return { kind: "consent_required" };
    let job = await d.store.getJob(i.jobId);
    if (job === null || job.storeId !== i.storeId) return { kind: "not_found" };

    const stale = job.status === "PROCESSING" && d.clock.nowMs() - job.updatedAtMs > STALE_PROCESSING_MS;
    if (stale) {
      const failed = await d.store.update(job.id, job.version, { status: "FAILED", errorCode: "stale_processing", updatedAtMs: d.clock.nowMs() });
      if (failed === null) return { kind: "ok", view: await viewOf(d, (await d.store.getJob(job.id)) ?? job), ran: false };
      return { kind: "ok", view: await viewOf(d, failed), ran: false };
    }
    if (job.status !== "PENDING") return { kind: "ok", view: await viewOf(d, job), ran: false };
    if (job.attempts >= d.cfg.maxAttemptsPerJob) return { kind: "attempts_exceeded" };

    const scan = await d.blobs.scanState(job.originalRef);
    if (scan === null) return { kind: "upload_not_ready", state: "missing" };
    if (scan === "pending_scan") return { kind: "upload_not_ready", state: "pending_scan" };
    if (scan === "infected") {
      const f = await this.finish(job, { status: "FAILED", errorCode: "infected" });
      return { kind: "ok", view: await viewOf(d, f ?? job), ran: false };
    }

    if (!(await d.store.consumeQuota(job.storeId, utcDay(d.clock.nowMs()), d.cfg.dailyRuns))) return { kind: "quota_exceeded" };
    const claimed = await d.store.update(job.id, job.version, {
      status: "PROCESSING",
      attempts: job.attempts + 1,
      errorCode: null,
      updatedAtMs: d.clock.nowMs(),
    });
    if (claimed === null) {
      // Another request owns the run: report its state.
      const now = await d.store.getJob(job.id);
      return now === null ? { kind: "not_found" } : { kind: "ok", view: await viewOf(d, now), ran: false };
    }
    job = claimed;
    const done = await this.run(job, i.model ?? job.requestedModel ?? DEFAULT_BG_MODEL);
    return { kind: "ok", view: await viewOf(d, done), ran: true };
  }

  private async finish(job: ProductMediaJob, patch: Omit<JobPatch, "updatedAtMs">): Promise<ProductMediaJob | null> {
    return this.d.store.update(job.id, job.version, { ...patch, updatedAtMs: this.d.clock.nowMs() });
  }

  private async run(job: ProductMediaJob, model: BgModel): Promise<ProductMediaJob> {
    const { d } = this;
    const fail = async (code: string): Promise<ProductMediaJob> => (await this.finish(job, { status: "FAILED", errorCode: code })) ?? job;
    let original: Uint8Array | null;
    try {
      original = await d.blobs.read(job.originalRef);
    } catch {
      return fail("storage_error");
    }
    if (original === null) return fail("original_missing");
    const clean = sanitizeImage(original, { maxBytes: d.cfg.maxBytes, maxDimension: d.cfg.maxDimension });
    if (!clean.ok) return fail(`image_${clean.reason}`);

    let out;
    try {
      out = await withTimeout(d.removal.cutout(clean.bytes, { model, ...DEFAULT_CUTOUT_OPTIONS }), d.cfg.cutoutTimeoutMs);
    } catch (e) {
      return fail(failCode(e));
    }
    const quality = assessQuality(out.stats);
    const written: string[] = [];
    try {
      const put = async (kind: DerivativeKind, bytes: Uint8Array): Promise<string> => {
        const k = await d.blobs.writeDerivative({ storeId: job.storeId, kind, bytes });
        written.push(k);
        return k;
      };
      const pngRef = await put("png", out.png);
      const whiteJpgRef = await put("jpg", out.whiteJpg);
      const shadowRef = out.shadowPng === null ? null : await put("png", out.shadowPng);
      const maskRef = await put("png", out.mask);
      const status = isReady(quality) ? "READY" : "NEEDS_REVIEW";
      const existing = await d.store.listVersions(job.id);
      const versionNo = nextVersionNumber(existing);
      const inserted = await d.store.insertVersion({
        id: d.ids.uuidV7(),
        jobId: job.id,
        storeId: job.storeId,
        version: versionNo,
        op: existing.length === 0 ? "initial" : "rerun",
        params: existing.length === 0 ? {} : { model },
        maskRef,
        pngRef,
        whiteJpgRef,
        shadowRef,
        backgroundRenderRef: null,
        modelId: out.modelId,
        modelVersion: out.modelVersion,
        latencyMs: out.latencyMs,
        qualityScore: quality.score,
        qualityReasons: quality.reasons,
        createdAtMs: d.clock.nowMs(),
      });
      if (inserted === "duplicate") throw new Error("version allocation raced");
      const updated = await this.finish(job, {
        currentVersion: versionNo,
        backgroundRenderRef: null,
        status,
        modelId: out.modelId,
        modelVersion: out.modelVersion,
        qualityScore: quality.score,
        qualityReasons: quality.reasons,
        pngRef,
        whiteJpgRef,
        shadowRef,
        latencyMs: out.latencyMs,
        errorCode: null,
      });
      if (updated === null) {
        await d.store.deleteVersion(job.id, versionNo).catch(() => null);
        await Promise.allSettled(written.map((k) => d.blobs.delete(k)));
        return (await d.store.getJob(job.id)) ?? job;
      }
      await pruneVersions(d, updated).catch(() => undefined);
      return updated;
    } catch {
      await Promise.allSettled(written.map((k) => d.blobs.delete(k)));
      return fail("storage_error");
    }
  }
}

export type DecisionResult =
  | { readonly kind: "ok"; readonly view: JobView }
  | { readonly kind: "not_found" }
  | { readonly kind: "invalid_state"; readonly status: ProductMediaJob["status"] }
  | { readonly kind: "conflict" };

export class DecideProductPhoto {
  constructor(private readonly d: ProductMediaDeps) {}
  async execute(i: { storeId: string; jobId: string; decision: "accepted" | "use_original" }): Promise<DecisionResult> {
    const { d } = this;
    const job = await d.store.getJob(i.jobId);
    if (job === null || job.storeId !== i.storeId) return { kind: "not_found" };
    if (job.decision === i.decision) return { kind: "ok", view: await viewOf(d, job) }; // idempotent
    if (!canDecide(job.status, i.decision)) return { kind: "invalid_state", status: job.status };
    const updated = await d.store.update(job.id, job.version, { decision: i.decision, updatedAtMs: d.clock.nowMs() });
    if (updated === null) return { kind: "conflict" };
    return { kind: "ok", view: await viewOf(d, updated) };
  }
}

export type RerunResult = ProcessResult | { readonly kind: "invalid_state"; readonly status: ProductMediaJob["status"] } | { readonly kind: "conflict" };

/** Re-run with another model: resets to PENDING, drops the old derivatives, then runs the pipeline again. */
export class RerunProductPhoto {
  constructor(private readonly d: ProductMediaDeps, private readonly process: ProcessProductPhoto) {}
  async execute(i: { storeId: string; jobId: string; model: BgModel }): Promise<RerunResult> {
    const { d } = this;
    if (!(BG_MODELS as readonly string[]).includes(i.model)) throw new RangeError("unknown model");
    if (!(await flagOn(d.flags, FLAG_BACKGROUND_REMOVAL))) return { kind: "disabled" };
    if (!d.removal.configured || !d.blobs.configured) return { kind: "unconfigured" };
    const job = await d.store.getJob(i.jobId);
    if (job === null || job.storeId !== i.storeId) return { kind: "not_found" };
    const stale = job.status === "PROCESSING" && d.clock.nowMs() - job.updatedAtMs > STALE_PROCESSING_MS;
    if (job.status === "PENDING") return this.process.execute({ storeId: i.storeId, jobId: i.jobId, model: i.model });
    if (job.status === "PROCESSING" && !stale) return { kind: "invalid_state", status: job.status };
    if (job.attempts >= d.cfg.maxAttemptsPerJob) return { kind: "attempts_exceeded" };
    // Derivatives of recorded versions stay (undo/redo by version); only keys no version references are dropped.
    const kept = new Set((await d.store.listVersions(job.id)).flatMap((v) => [v.maskRef, v.pngRef, v.whiteJpgRef, v.shadowRef, v.backgroundRenderRef]));
    const old = [job.pngRef, job.whiteJpgRef, job.shadowRef, job.backgroundRenderRef].filter((k): k is string => k !== null && !kept.has(k));
    const reset = await d.store.update(job.id, job.version, {
      status: job.status === "PROCESSING" ? "FAILED" : "PENDING",
      decision: "none",
      requestedModel: i.model,
      qualityScore: null,
      qualityReasons: [],
      pngRef: null,
      whiteJpgRef: null,
      shadowRef: null,
      backgroundRenderRef: null,
      modelId: null,
      modelVersion: null,
      latencyMs: null,
      errorCode: null,
      updatedAtMs: d.clock.nowMs(),
    });
    if (reset === null) return { kind: "conflict" };
    await Promise.allSettled(old.map((k) => d.blobs.delete(k)));
    if (reset.status === "FAILED") {
      const again = await d.store.update(reset.id, reset.version, { status: "PENDING", updatedAtMs: d.clock.nowMs() });
      if (again === null) return { kind: "conflict" };
    }
    return this.process.execute({ storeId: i.storeId, jobId: i.jobId, model: i.model });
  }
}

export class GetProductPhoto {
  constructor(private readonly d: ProductMediaDeps) {}
  async execute(i: { storeId: string; jobId: string }): Promise<JobView | null> {
    const job = await this.d.store.getJob(i.jobId);
    if (job === null || job.storeId !== i.storeId) return null;
    return viewOf(this.d, job);
  }
}

export class ListProductPhotos {
  constructor(private readonly d: ProductMediaDeps) {}
  async execute(i: { storeId: string }): Promise<readonly ProductMediaJob[]> {
    return this.d.store.listByStore(i.storeId, this.d.cfg.listLimit);
  }
}
