/** Ports of the product-media module (background removal for seller product photos). No infrastructure imports. */

export interface Clock {
  nowMs(): number;
}
export interface IdPort {
  uuidV7(): string;
}

export type ImageMime = "image/jpeg" | "image/png" | "image/webp";
export type ScanState = "pending_scan" | "clean" | "infected";

/** Models the self-hosted sidecar may load. BRIA RMBG-1.4/2.0 are non-commercial and must never appear here. */
export const BG_MODELS = ["u2netp", "u2net", "birefnet-general-lite", "isnet-general-use"] as const;
export type BgModel = (typeof BG_MODELS)[number];
export const DEFAULT_BG_MODEL: BgModel = "u2netp";

export type JobStatus = "PENDING" | "PROCESSING" | "READY" | "NEEDS_REVIEW" | "FAILED";
export type Decision = "none" | "accepted" | "use_original";

export interface ProductMediaJob {
  readonly id: string;
  readonly storeId: string;
  readonly createdBy: string;
  /** Object key of the private original (scheme product-media/yyyy/mm/uuid). Also the idempotency anchor. */
  readonly originalRef: string;
  readonly contentType: ImageMime;
  readonly sizeBytes: number;
  readonly status: JobStatus;
  readonly decision: Decision;
  readonly requestedModel: BgModel | null;
  readonly modelId: string | null;
  readonly modelVersion: string | null;
  readonly qualityScore: number | null;
  readonly qualityReasons: readonly string[];
  readonly pngRef: string | null;
  readonly whiteJpgRef: string | null;
  readonly shadowRef: string | null;
  readonly latencyMs: number | null;
  readonly errorCode: string | null;
  readonly attempts: number;
  /** Product this job backs (set by the catalog write path through `claimAttachment`). null = free. */
  readonly attachedProductId: string | null;
  /** Keys of the copies promoted to the catalog image purpose (reused on re-attach). */
  readonly promotedImageRef: string | null;
  readonly promotedCutoutRef: string | null;
  /** Compare-and-set counter, bumped on every write. Not the edit version below. */
  readonly version: number;
  /** Edit version (product_media_versions.version) the derivatives above belong to. 0 = legacy job, versioned lazily. */
  readonly currentVersion: number;
  /** Manual refines applied so far (capped per job). */
  readonly editCount: number;
  /** Edit version the promoted catalog copies were made from (0 = none). A later edit is re-promoted on the next claim. */
  readonly promotedVersion: number;
  /** Rendered-background derivative of the current version, when one was requested. */
  readonly backgroundRenderRef: string | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export type VersionOp = "initial" | "rerun" | "refine";

/** Immutable record of one produced cutout. Keys only; params hold the compact edit request (<= 256 KB). */
export interface ProductMediaVersion {
  readonly id: string;
  readonly jobId: string;
  readonly storeId: string;
  readonly version: number;
  readonly op: VersionOp;
  readonly params: Readonly<Record<string, unknown>>;
  readonly maskRef: string | null;
  readonly pngRef: string;
  readonly whiteJpgRef: string;
  readonly shadowRef: string | null;
  readonly backgroundRenderRef: string | null;
  readonly modelId: string | null;
  readonly modelVersion: string | null;
  readonly latencyMs: number | null;
  readonly qualityScore: number;
  readonly qualityReasons: readonly string[];
  readonly createdAtMs: number;
}

export const MAX_VERSIONS_PER_JOB = 5;
export const MAX_EDITS_PER_JOB = 30;
/** Quota units: a full run is 4, a refine on a stored mask is 1 (0.25 run). */
export const QUOTA_UNITS_PER_RUN = 4;
export const MAX_PARAMS_BYTES = 256 * 1024;

/** Fields a compare-and-set may change. `version` is bumped by the store. */
export type JobPatch = Partial<
  Pick<
    ProductMediaJob,
    | "status"
    | "decision"
    | "requestedModel"
    | "modelId"
    | "modelVersion"
    | "qualityScore"
    | "qualityReasons"
    | "pngRef"
    | "whiteJpgRef"
    | "shadowRef"
    | "latencyMs"
    | "errorCode"
    | "attempts"
    | "currentVersion"
    | "editCount"
    | "backgroundRenderRef"
  >
> & { readonly updatedAtMs: number };

export interface ProductMediaStore {
  /** "duplicate" when (store, original) already has a job (idempotent per upload). */
  insertJob(job: ProductMediaJob): Promise<"created" | "duplicate">;
  getJob(id: string): Promise<ProductMediaJob | null>;
  /** Compare-and-set on `version`. null when the job is gone or the version moved. */
  update(id: string, expectedVersion: number, patch: JobPatch): Promise<ProductMediaJob | null>;
  listByStore(storeId: string, limit: number): Promise<readonly ProductMediaJob[]>;
  /** Atomically takes one run from the store's daily quota. False when `limit` runs were already used on `day` (UTC yyyy-mm-dd). */
  consumeQuota(storeId: string, day: string, limit: number): Promise<boolean>;
  /**
   * Compare-and-set claim for a product: succeeds only when the job is in `storeId`, free or already attached to
   * `productId`. Returns the job after the claim, or null (missing, other store, or attached elsewhere).
   * Does not change `version` (the attachment is not a machine transition).
   */
  claimAttachment(jobId: string, storeId: string, productId: string): Promise<ProductMediaJob | null>;
  /** Clears the attachment when it still points at `productId`. */
  releaseAttachment(jobId: string, storeId: string, productId: string): Promise<void>;
  /** Records the promoted catalog keys once (first writer wins; later calls keep the stored keys). Stamps promotedVersion = currentVersion. */
  setPromoted(jobId: string, refs: { readonly image: string; readonly cutout: string | null }): Promise<ProductMediaJob | null>;
  /**
   * Swaps the promoted keys for those of a newer version. Compare-and-set on the stored image key; returns the job
   * after the swap, or null when another writer already changed it. The superseded copies are not erased here:
   * the catalog product row may still reference them until its next save.
   */
  replacePromoted(
    jobId: string,
    expectedImage: string,
    refs: { readonly image: string; readonly cutout: string | null },
    version: number,
  ): Promise<ProductMediaJob | null>;
  /** Takes `units` quota units (4 per full run). False when the day's limit (runs * 4) would be exceeded. */
  consumeQuotaUnits(storeId: string, day: string, units: number, limitRuns: number): Promise<boolean>;
  /** Ascending by version. */
  listVersions(jobId: string): Promise<readonly ProductMediaVersion[]>;
  getVersion(jobId: string, version: number): Promise<ProductMediaVersion | null>;
  /** "duplicate" when (job, version) exists (a concurrent writer allocated it first). */
  insertVersion(v: ProductMediaVersion): Promise<"created" | "duplicate">;
  /** Removes a version row (rollback of an unfinished write, or pruning). Returns the removed row. */
  deleteVersion(jobId: string, version: number): Promise<ProductMediaVersion | null>;
}

// ---- object store (private bucket, existing signed-upload + scan + EXIF-strip path) ---------------

export interface IssuedUpload {
  readonly uploadId: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly expiresAtMs: number;
}

export type DerivativeKind = "png" | "jpg";

export interface ProductMediaBlobPort {
  readonly configured: boolean;
  issueUpload(input: { readonly storeId: string; readonly contentType: ImageMime; readonly sizeBytes: number }): Promise<IssuedUpload>;
  /** True when the key has the product-media scheme, exists and is owned by the store. */
  owns(storeId: string, key: string): Promise<boolean>;
  scanState(key: string): Promise<ScanState | null>;
  /** Only a `clean` object is returned. */
  read(key: string): Promise<Uint8Array | null>;
  /** Server-written derivative, private. Returns its key. */
  writeDerivative(input: { readonly storeId: string; readonly kind: DerivativeKind; readonly bytes: Uint8Array }): Promise<string>;
  /**
   * Copies a clean private object of this module (original or derivative) to the catalog image purpose
   * (`catalog/yyyy/mm/uuid`), which the catalog's signed media URLs serve. Returns the new key.
   */
  promote(input: { readonly storeId: string; readonly key: string }): Promise<string>;
  /** Signed GET, ttl is clamped to 15 minutes by every adapter. null when the object cannot be served. */
  signGet(key: string, ttlSeconds: number): Promise<{ readonly url: string; readonly expiresAtMs: number } | null>;
  delete(key: string): Promise<void>;
}

// ---- background removal ------------------------------------------------------------------------

export interface CutoutOptions {
  readonly model: BgModel;
  /** Alpha feather radius in px (sidecar edge cleanup). */
  readonly featherPx: number;
  /** Crop padding as a fraction of the subject's longest side. */
  readonly paddingRatio: number;
  /** Longest side of the white-background JPG. */
  readonly whiteMaxSide: number;
  readonly shadow: boolean;
}

export const DEFAULT_CUTOUT_OPTIONS: Omit<CutoutOptions, "model"> = { featherPx: 1.5, paddingRatio: 0.06, whiteMaxSide: 1600, shadow: true };

/** Measured on the uncropped mask by the engine that produced it. Ratios are 0..1. */
export interface MaskStats {
  readonly width: number;
  readonly height: number;
  /** Foreground pixels / all pixels. */
  readonly coverage: number;
  /** Share of the image border pixels that are foreground. */
  readonly borderTouch: number;
  /** Connected foreground components larger than 0.5% of the subject. */
  readonly components: number;
  /** Enclosed background area inside the subject's bounding box / subject area. */
  readonly holeRatio: number;
  /** Share of subject pixels that are neither clearly foreground nor background (0.1 < alpha < 0.9). */
  readonly softEdgeRatio: number;
  /** Share of subject pixels that are near-white and unsaturated. */
  readonly subjectBrightRatio: number;
  /** Share of the border ring (the background) that is near-white and unsaturated. */
  readonly borderBrightRatio: number;
}

export interface CutoutResult {
  /** Edge-cleaned, cropped RGBA PNG. */
  readonly png: Uint8Array;
  /** 8-bit alpha mask PNG (of the original frame). */
  readonly mask: Uint8Array;
  readonly whiteJpg: Uint8Array;
  readonly shadowPng: Uint8Array | null;
  readonly stats: MaskStats;
  readonly modelId: string;
  readonly modelVersion: string;
  readonly latencyMs: number;
}

export class BackgroundRemovalError extends Error {
  constructor(
    readonly code: "provider_not_configured" | "timeout" | "provider_error" | "invalid_response" | "image_rejected" | "too_large",
    message: string,
  ) {
    super(message);
    this.name = "BackgroundRemovalError";
  }
}

export type RefineBackground = "transparent" | "white" | "studio";

/** One brush stroke, coordinates normalised 0..1 in the frame of the original. */
export interface RefineStroke {
  readonly mode: "erase" | "restore";
  /** Brush radius as a fraction of the longest side, (0, 0.25]. */
  readonly radius: number;
  readonly points: readonly (readonly [number, number])[];
}

export interface RefineRequest {
  /** Current alpha mask (PNG of the original frame). null = the sidecar reruns its model first. */
  readonly mask: Uint8Array | null;
  readonly strokes: readonly RefineStroke[];
  readonly featherPx: number;
  /** 0..1 */
  readonly smooth: number;
  /** -3..3 px, negative shrinks the subject. */
  readonly edgeShiftPx: number;
  readonly background: RefineBackground;
}

export interface RefineResult extends CutoutResult {
  /** Subject rendered on the requested background (PNG or JPG); null for "transparent". */
  readonly backgroundRender: Uint8Array | null;
}

export const REFINE_LIMITS = { maxStrokes: 200, maxPointsPerStroke: 2000, maxTotalPoints: 20_000, maxRadius: 0.25 } as const;

export interface BackgroundRemovalPort {
  readonly configured: boolean;
  /** `in_region` is the default (self-hosted). `external` needs the cross_border_ml consent and a licence (ADR-0002). */
  readonly residency: "in_region" | "external";
  cutout(image: Uint8Array, options: CutoutOptions): Promise<CutoutResult>;
  /** Applies brush edits and edge settings to a mask (or reruns the model when none). Same guards as cutout. */
  refine(image: Uint8Array, request: RefineRequest): Promise<RefineResult>;
}

export interface ProductMediaFlagPort {
  isEnabled(key: string): Promise<boolean>;
}
export interface ProductMediaConsentPort {
  crossBorderMlGranted(storeId: string): Promise<boolean>;
}

export const FLAG_BACKGROUND_REMOVAL = "kill.background_removal";
