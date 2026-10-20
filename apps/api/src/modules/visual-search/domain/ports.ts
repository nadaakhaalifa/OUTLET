/** Ports of the visual-search module (spec P3-08, ADR-0023). No infrastructure imports. */

export interface Clock {
  nowMs(): number;
}
export interface IdPort {
  uuidV7(): string;
}

export type ImageMime = "image/jpeg" | "image/png" | "image/webp";
export type ScanState = "pending_scan" | "clean" | "infected";
export type World = "local" | "global";

/** Normalised crop box (0..1) in the sanitised image, chosen on-device. */
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

// ---- query image storage (private bucket, existing signed-upload / scan path) ----------------

export interface IssuedUpload {
  readonly uploadId: string;
  readonly url: string;
  /** Headers the client must send verbatim (they are signed). */
  readonly headers: Readonly<Record<string, string>>;
  readonly expiresAtMs: number;
}

/** Facade over the object store. Production stays Unconfigured (503) until a bucket exists. */
export interface QueryImageStorePort {
  readonly configured: boolean;
  issue(input: { readonly ownerId: string; readonly contentType: ImageMime; readonly sizeBytes: number }): Promise<IssuedUpload>;
  /** True when the key has the visual-query scheme, exists and is owned by `ownerId`. */
  owns(ownerId: string, uploadId: string): Promise<boolean>;
  scanState(uploadId: string): Promise<ScanState | null>;
  read(uploadId: string): Promise<Uint8Array | null>;
  delete(uploadId: string): Promise<void>;
}

// ---- ML ports ---------------------------------------------------------------------------------

export interface QueryAttributes {
  readonly category?: string;
  readonly colour?: string;
  readonly pattern?: string;
}

export interface EmbedResult {
  readonly vector: readonly number[];
  /** Same space and version as product_embeddings.model_version. */
  readonly modelVersion: string;
  readonly attributes?: QueryAttributes;
}

export interface ImageEmbedderPort {
  readonly configured: boolean;
  /** `in_region` is the ADR-0002 default. `external` needs the cross_border_ml consent and a licence (VR-P3-13). */
  readonly residency: "in_region" | "external";
  readonly modelVersion: string;
  /**
   * `maskRegions` (detected faces) must not contribute to the embedding. `crop` restricts it to the
   * garment region. The port receives no user identifier.
   */
  embed(input: {
    readonly bytes: Uint8Array;
    readonly mime: ImageMime;
    readonly crop?: Box;
    readonly maskRegions: readonly Box[];
  }): Promise<EmbedResult>;
}

/** Face regions only, to exclude them. No identification, no face embedding is ever computed. */
export interface FaceRegionDetectorPort {
  detect(bytes: Uint8Array, mime: ImageMime): Promise<readonly Box[]>;
}

export interface ImageSafetyPort {
  classify(bytes: Uint8Array, mime: ImageMime): Promise<{ readonly nsfw: boolean; readonly fashion: boolean }>;
}

// ---- retrieval --------------------------------------------------------------------------------

export interface Neighbor {
  readonly productId: string;
  /** Cosine similarity in [-1, 1]. */
  readonly similarity: number;
}

/** Throws IndexUnavailableError when the extension, table or replica is down. */
export interface VisualIndexPort {
  search(input: { readonly vector: readonly number[]; readonly modelVersion: string; readonly k: number }): Promise<readonly Neighbor[]>;
  vectorOf(productId: string): Promise<{ readonly vector: readonly number[]; readonly modelVersion: string } | null>;
}

export class IndexUnavailableError extends Error {
  constructor(message = "vector index unavailable") {
    super(message);
    this.name = "IndexUnavailableError";
  }
}
export class EmbedderUnconfiguredError extends Error {
  constructor() {
    super("image embedder is not configured");
    this.name = "EmbedderUnconfiguredError";
  }
}

/** Catalog and price integrity facts, read at request time (never trusted from the index). */
export interface VisualCandidate {
  readonly productId: string;
  readonly storeId: string;
  readonly world: World;
  readonly categoryId: string;
  readonly priceMinor: bigint;
  /** Price-integrity output; a "% off" is only emitted when true. */
  readonly claimAllowed: boolean;
  readonly verifiedDiscountPct: number;
  readonly inStock: boolean;
  readonly sizesInStock: readonly string[];
  readonly storeActive: boolean;
  /** 18 by default; 21 for age-gated capabilities (spec B6). */
  readonly minAge: number;
  readonly colour: string | null;
  readonly pattern: string | null;
}

export interface VisualCatalogPort {
  byIds(productIds: readonly string[]): Promise<readonly VisualCandidate[]>;
  /** Attribute fallback when the embedder or index is down. */
  popularInCategory(categoryId: string, limit: number): Promise<readonly VisualCandidate[]>;
}

export interface ShopperContext {
  readonly ageYears: number | null;
  readonly sizeLabels: readonly string[];
  readonly myStoreIds: readonly string[];
}
export interface ShopperContextPort {
  profile(userId: string): Promise<ShopperContext>;
}

export interface VisualConsentPort {
  crossBorderMlGranted(userId: string): Promise<boolean>;
}

export interface VisualFlagsPort {
  /** Backed by `kill.visual_search`: true means visual search may run. */
  enabled(): Promise<boolean>;
}

export interface VisualMetrics {
  incr(name: string, labels?: Readonly<Record<string, string>>): void;
}

// ---- persistence ------------------------------------------------------------------------------

export type QuotaResult = "ok" | "user_limit" | "global_limit";

export type RequestOutcome = "ok" | "no_result" | "low_confidence" | "rejected" | "degraded";

export interface RequestLog {
  readonly id: string;
  readonly tsMs: number;
  readonly mode: "image" | "product";
  readonly outcome: RequestOutcome;
  readonly latencyMs: number;
  readonly resultCount: number;
  readonly categoryGuess: string | null;
  readonly modelVersion: string | null;
}

export interface EvalRunRecord {
  readonly id: string;
  readonly setName: string;
  readonly modelVersion: string;
  readonly k: number;
  readonly queries: number;
  readonly recallAtK: number;
  readonly mrr: number;
  readonly coverage: number;
  readonly passed: boolean;
  readonly ranAtMs: number;
}

export interface VisualSearchStore {
  recordUpload(u: { readonly id: string; readonly ownerId: string; readonly contentType: ImageMime; readonly createdAtMs: number; readonly expiresAtMs: number }): Promise<void>;
  /** Atomic single use: true only for the owner, before expiry, when not yet consumed. */
  claimUpload(ownerId: string, id: string, nowMs: number): Promise<boolean>;
  /** Uploads past expiry whose object must be deleted (consumed or not). */
  expiredUploads(nowMs: number, limit: number): Promise<readonly string[]>;
  markUploadsDeleted(ids: readonly string[], nowMs: number): Promise<void>;
  /** Atomic per-user and global daily counters (cost cap, API4). */
  consumeQuota(input: { readonly userId: string; readonly nowMs: number; readonly userDailyLimit: number; readonly globalDailyLimit: number }): Promise<QuotaResult>;
  /** P1 telemetry plus the outbox event in one transaction. No user id, no image, no vector. */
  recordRequest(r: RequestLog): Promise<void>;
  purge(beforeMs: number): Promise<{ readonly uploads: number; readonly requests: number; readonly usage: number }>;
  saveEvalRun(r: EvalRunRecord): Promise<void>;
}

export interface VisualLimits {
  readonly maxBytes: number;
  readonly maxDimension: number;
  readonly embedTimeoutMs: number;
  readonly userDailyLimit: number;
  /** Embedder cost cap: queries per UTC day across all users. */
  readonly globalDailyLimit: number;
  readonly uploadTtlMs: number;
  /** Below this top similarity the response carries low_confidence ("closest we have"). */
  readonly lowConfidenceBelow: number;
  readonly maxResults: number;
  readonly oversampleCap: number;
}

export const DEFAULT_LIMITS: VisualLimits = {
  maxBytes: 10 * 1024 * 1024,
  maxDimension: 4096,
  embedTimeoutMs: 1500,
  userDailyLimit: 100,
  globalDailyLimit: 20_000,
  uploadTtlMs: 10 * 60 * 1000,
  lowConfidenceBelow: 0.55,
  maxResults: 50,
  oversampleCap: 400,
};
