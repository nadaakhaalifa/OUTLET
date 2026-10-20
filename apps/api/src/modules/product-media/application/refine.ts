import { sanitizeImage } from "../../visual-search";
import { compactParams, nextVersionNumber, paramsFit, quantizeStrokes, toRefineRequest, type EditSettings } from "../domain/edit";
import { canTransition } from "../domain/machine";
import {
  BackgroundRemovalError,
  FLAG_BACKGROUND_REMOVAL,
  MAX_EDITS_PER_JOB,
  QUOTA_UNITS_PER_RUN,
  REFINE_LIMITS,
  type ProductMediaJob,
  type ProductMediaVersion,
  type RefineStroke,
} from "../domain/ports";
import { assessQuality, isReady } from "../domain/quality";
import { flagOn, utcDay, viewOf, withTimeout, type JobView, type ProductMediaDeps } from "./shared";
import { ensureInitialVersion, pruneVersions } from "./versions";

export interface VersionSummary {
  readonly version: number;
  readonly op: ProductMediaVersion["op"];
  readonly qualityScore: number;
  readonly qualityReasons: readonly string[];
  readonly createdAtMs: number;
  readonly isCurrent: boolean;
  readonly thumbnail: { readonly url: string; readonly expiresAtMs: number } | null;
}

const summarize = async (d: ProductMediaDeps, versions: readonly ProductMediaVersion[], current: number, withThumbs: boolean): Promise<VersionSummary[]> => {
  const out: VersionSummary[] = [];
  for (const v of [...versions].sort((a, b) => b.version - a.version)) {
    let thumbnail: VersionSummary["thumbnail"] = null;
    if (withThumbs && d.blobs.configured) {
      try {
        thumbnail = await d.blobs.signGet(v.pngRef, d.cfg.signedGetTtlSeconds);
      } catch {
        thumbnail = null;
      }
    }
    out.push({ version: v.version, op: v.op, qualityScore: v.qualityScore, qualityReasons: v.qualityReasons, createdAtMs: v.createdAtMs, isCurrent: v.version === current, thumbnail });
  }
  return out;
};

export type RefineInput = {
  readonly storeId: string;
  readonly jobId: string;
  readonly strokes: readonly RefineStroke[];
  readonly featherPx: number;
  readonly smooth: number;
  readonly edgeShiftPx: number;
  readonly background: EditSettings["background"];
  readonly baseVersion?: number | undefined;
};

export type RefineResult =
  | { readonly kind: "ok"; readonly view: JobView; readonly versions: readonly VersionSummary[] }
  | { readonly kind: "disabled" }
  | { readonly kind: "unconfigured" }
  | { readonly kind: "not_found" }
  | { readonly kind: "consent_required" }
  | { readonly kind: "invalid_state"; readonly status: ProductMediaJob["status"] }
  | { readonly kind: "edits_exceeded" }
  | { readonly kind: "base_version_conflict"; readonly current: number }
  | { readonly kind: "quota_exceeded" }
  | { readonly kind: "conflict" }
  | { readonly kind: "invalid_edit" }
  | { readonly kind: "params_too_large" }
  | { readonly kind: "refine_failed"; readonly code: string; readonly view: JobView };

const failCode = (e: unknown): string => {
  if (e instanceof BackgroundRemovalError) return e.code;
  if (e instanceof Error && e.message === "timeout") return "timeout";
  return "provider_error";
};

/** Strokes are validated again here: the use case is callable without the HTTP layer. */
function validStrokes(strokes: readonly RefineStroke[]): boolean {
  if (strokes.length > REFINE_LIMITS.maxStrokes) return false;
  let total = 0;
  for (const s of strokes) {
    if (!(s.radius > 0 && s.radius <= REFINE_LIMITS.maxRadius)) return false;
    if (s.points.length < 1 || s.points.length > REFINE_LIMITS.maxPointsPerStroke) return false;
    total += s.points.length;
    for (const p of s.points) if (!(p[0] >= 0 && p[0] <= 1 && p[1] >= 0 && p[1] <= 1)) return false;
  }
  return total <= REFINE_LIMITS.maxTotalPoints;
}

/**
 * Manual cutout edit. Applies brush strokes and edge settings to the CURRENT version's mask in the sidecar (or
 * reruns the model when no mask is stored), writes the result as a NEW immutable version and makes it current.
 * Nothing is overwritten, so every earlier version (at most 5) stays restorable. The job may be attached to a
 * product: the catalog copies are re-promoted on the product's next save (ProductImageLinker).
 */
export class RefineProductPhoto {
  constructor(private readonly d: ProductMediaDeps) {}

  async execute(i: RefineInput): Promise<RefineResult> {
    const { d } = this;
    if (!(await flagOn(d.flags, FLAG_BACKGROUND_REMOVAL))) return { kind: "disabled" };
    if (!d.removal.configured || !d.blobs.configured) return { kind: "unconfigured" };
    if (d.removal.residency === "external" && !(await d.consent.crossBorderMlGranted(i.storeId))) return { kind: "consent_required" };
    if (!validStrokes(i.strokes)) return { kind: "invalid_edit" };

    let job = await d.store.getJob(i.jobId);
    if (job === null || job.storeId !== i.storeId) return { kind: "not_found" };
    if (job.status !== "READY" && job.status !== "NEEDS_REVIEW") return { kind: "invalid_state", status: job.status };
    if (job.editCount >= MAX_EDITS_PER_JOB) return { kind: "edits_exceeded" };
    job = await ensureInitialVersion(d, job);
    if (job.status !== "READY" && job.status !== "NEEDS_REVIEW") return { kind: "invalid_state", status: job.status };
    if (i.baseVersion !== undefined && i.baseVersion !== job.currentVersion) return { kind: "base_version_conflict", current: job.currentVersion };

    const strokes = quantizeStrokes(i.strokes);
    const settings: EditSettings = { strokes, featherPx: i.featherPx, smooth: i.smooth, edgeShiftPx: i.edgeShiftPx, background: i.background };
    const params = compactParams(settings, { baseVersion: job.currentVersion });
    if (!paramsFit(params)) return { kind: "params_too_large" };

    const current = job.currentVersion > 0 ? await d.store.getVersion(job.id, job.currentVersion) : null;
    let mask: Uint8Array | null = null;
    if (current?.maskRef !== null && current?.maskRef !== undefined) {
      try {
        mask = await d.blobs.read(current.maskRef);
      } catch {
        mask = null;
      }
    }
    // A stored mask makes this a cheap edit (0.25 run); without one the sidecar reruns the model (1 run).
    const units = mask === null ? QUOTA_UNITS_PER_RUN : 1;
    if (!(await d.store.consumeQuotaUnits(job.storeId, utcDay(d.clock.nowMs()), units, d.cfg.dailyRuns))) return { kind: "quota_exceeded" };

    const prior = job.status;
    const claimed = await d.store.update(job.id, job.version, { status: "PROCESSING", errorCode: null, updatedAtMs: d.clock.nowMs() });
    if (claimed === null) return { kind: "conflict" };

    const restoreWith = async (code: string): Promise<RefineResult> => {
      const back = await d.store.update(claimed.id, claimed.version, { status: prior, errorCode: `refine_${code}`.slice(0, 60), updatedAtMs: d.clock.nowMs() });
      return { kind: "refine_failed", code, view: await viewOf(d, back ?? (await d.store.getJob(claimed.id)) ?? claimed) };
    };

    let original: Uint8Array | null;
    try {
      original = await d.blobs.read(claimed.originalRef);
    } catch {
      return restoreWith("storage_error");
    }
    if (original === null) return restoreWith("original_missing");
    const clean = sanitizeImage(original, { maxBytes: d.cfg.maxBytes, maxDimension: d.cfg.maxDimension });
    if (!clean.ok) return restoreWith(`image_${clean.reason}`);

    let out;
    try {
      out = await withTimeout(d.removal.refine(clean.bytes, toRefineRequest(mask, settings)), d.cfg.refineTimeoutMs);
    } catch (e) {
      return restoreWith(failCode(e));
    }
    const quality = assessQuality(out.stats);
    const written: string[] = [];
    let versionNo = 0;
    try {
      const put = async (kind: "png" | "jpg", bytes: Uint8Array): Promise<string> => {
        const k = await d.blobs.writeDerivative({ storeId: claimed.storeId, kind, bytes });
        written.push(k);
        return k;
      };
      const maskRef = await put("png", out.mask);
      const pngRef = await put("png", out.png);
      const whiteJpgRef = await put("jpg", out.whiteJpg);
      const shadowRef = out.shadowPng === null ? null : await put("png", out.shadowPng);
      const renderRef =
        out.backgroundRender === null ? null : await put(out.backgroundRender[0] === 0xff ? "jpg" : "png", out.backgroundRender);
      versionNo = nextVersionNumber(await d.store.listVersions(claimed.id));
      const created = await d.store.insertVersion({
        id: d.ids.uuidV7(),
        jobId: claimed.id,
        storeId: claimed.storeId,
        version: versionNo,
        op: "refine",
        params,
        maskRef,
        pngRef,
        whiteJpgRef,
        shadowRef,
        backgroundRenderRef: renderRef,
        modelId: out.modelId,
        modelVersion: out.modelVersion,
        latencyMs: out.latencyMs,
        qualityScore: quality.score,
        qualityReasons: quality.reasons,
        createdAtMs: d.clock.nowMs(),
      });
      if (created === "duplicate") throw new Error("version allocation raced");
      const status = isReady(quality) ? "READY" : "NEEDS_REVIEW";
      const done = await d.store.update(claimed.id, claimed.version, {
        status,
        currentVersion: versionNo,
        editCount: claimed.editCount + 1,
        backgroundRenderRef: renderRef,
        modelId: out.modelId,
        modelVersion: out.modelVersion,
        qualityScore: quality.score,
        qualityReasons: quality.reasons,
        pngRef,
        whiteJpgRef,
        shadowRef,
        latencyMs: out.latencyMs,
        errorCode: null,
        updatedAtMs: d.clock.nowMs(),
      });
      if (done === null) {
        await d.store.deleteVersion(claimed.id, versionNo).catch(() => null);
        await Promise.allSettled(written.map((k) => d.blobs.delete(k)));
        return { kind: "conflict" };
      }
      await pruneVersions(d, done).catch(() => undefined);
      const versions = await d.store.listVersions(done.id);
      return { kind: "ok", view: await viewOf(d, done), versions: await summarize(d, versions, done.currentVersion, false) };
    } catch {
      if (versionNo > 0) await d.store.deleteVersion(claimed.id, versionNo).catch(() => null);
      await Promise.allSettled(written.map((k) => d.blobs.delete(k)));
      return restoreWith("storage_error");
    }
  }
}

export type VersionsResult =
  | { readonly kind: "ok"; readonly current: number; readonly versions: readonly VersionSummary[] }
  | { readonly kind: "not_found" };

export class ListProductVersions {
  constructor(private readonly d: ProductMediaDeps) {}
  async execute(i: { storeId: string; jobId: string }): Promise<VersionsResult> {
    const job = await this.d.store.getJob(i.jobId);
    if (job === null || job.storeId !== i.storeId) return { kind: "not_found" };
    const versions = await this.d.store.listVersions(job.id);
    return { kind: "ok", current: job.currentVersion, versions: await summarize(this.d, versions, job.currentVersion, true) };
  }
}

export type RestoreResult =
  | { readonly kind: "ok"; readonly view: JobView; readonly versions: readonly VersionSummary[] }
  | { readonly kind: "not_found" }
  | { readonly kind: "invalid_state"; readonly status: ProductMediaJob["status"] }
  | { readonly kind: "conflict" };

/** Undo / redo: makes an existing version current again. Never creates or deletes a version, never calls the sidecar. */
export class RestoreProductVersion {
  constructor(private readonly d: ProductMediaDeps) {}
  async execute(i: { storeId: string; jobId: string; version: number }): Promise<RestoreResult> {
    const { d } = this;
    let job = await d.store.getJob(i.jobId);
    if (job === null || job.storeId !== i.storeId) return { kind: "not_found" };
    if (job.status !== "READY" && job.status !== "NEEDS_REVIEW") return { kind: "invalid_state", status: job.status };
    job = await ensureInitialVersion(d, job);
    const target = await d.store.getVersion(job.id, i.version);
    if (target === null) return { kind: "not_found" };
    const versions = await d.store.listVersions(job.id);
    if (job.currentVersion === target.version) return { kind: "ok", view: await viewOf(d, job), versions: await summarize(d, versions, job.currentVersion, false) };
    const status = isReady({ score: target.qualityScore, reasons: target.qualityReasons, whiteOnWhiteRisk: 0 }) ? "READY" : "NEEDS_REVIEW";
    if (status !== job.status && !canTransition(job.status, status)) return { kind: "invalid_state", status: job.status };
    const done = await d.store.update(job.id, job.version, {
      status,
      currentVersion: target.version,
      backgroundRenderRef: target.backgroundRenderRef,
      modelId: target.modelId,
      modelVersion: target.modelVersion,
      qualityScore: target.qualityScore,
      qualityReasons: target.qualityReasons,
      pngRef: target.pngRef,
      whiteJpgRef: target.whiteJpgRef,
      shadowRef: target.shadowRef,
      latencyMs: target.latencyMs,
      errorCode: null,
      updatedAtMs: d.clock.nowMs(),
    });
    if (done === null) return { kind: "conflict" };
    return { kind: "ok", view: await viewOf(d, done), versions: await summarize(d, versions, done.currentVersion, false) };
  }
}
