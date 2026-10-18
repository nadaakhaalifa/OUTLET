import { sanitizeImage, type ImageReject } from "../domain/image";
import {
  EmbedderUnconfiguredError,
  IndexUnavailableError,
  type Box,
  type Clock,
  type FaceRegionDetectorPort,
  type IdPort,
  type ImageEmbedderPort,
  type ImageMime,
  type ImageSafetyPort,
  type IssuedUpload,
  type Neighbor,
  type QueryAttributes,
  type QueryImageStorePort,
  type ShopperContext,
  type ShopperContextPort,
  type VisualCandidate,
  type VisualCatalogPort,
  type VisualConsentPort,
  type VisualFlagsPort,
  type VisualIndexPort,
  type VisualLimits,
  type VisualMetrics,
  type VisualSearchStore,
  type RequestOutcome,
  type World,
} from "../domain/ports";
import { diversify, rerank, validVector } from "../domain/similarity";

export interface VisualDeps {
  readonly store: VisualSearchStore;
  readonly images: QueryImageStorePort;
  readonly embedder: ImageEmbedderPort;
  readonly faces: FaceRegionDetectorPort;
  readonly safety: ImageSafetyPort;
  readonly index: VisualIndexPort;
  readonly catalog: VisualCatalogPort;
  readonly shopper: ShopperContextPort;
  readonly consent: VisualConsentPort;
  readonly flags: VisualFlagsPort;
  readonly metrics: VisualMetrics;
  readonly clock: Clock;
  readonly ids: IdPort;
  readonly limits: VisualLimits;
}

export interface VisualFilters {
  readonly world?: World | "all";
  /** Restrict to the shopper's favourite stores (My Stores scope). */
  readonly myStores?: boolean;
  /** Only items with the shopper's size labels in stock. */
  readonly inMySize?: boolean;
  readonly maxPriceMinor?: bigint;
  readonly categoryId?: string;
}

export interface VisualItem {
  readonly productId: string;
  readonly storeId: string;
  readonly categoryId: string;
  readonly priceMinor: bigint;
  readonly verifiedDiscountPct: number | null;
  /** Visual closeness bucket. The raw score never leaves the API. */
  readonly match: "close" | "similar";
}

export interface VisualGroup {
  readonly categoryId: string;
  readonly items: readonly VisualItem[];
}

export interface VisualOutput {
  readonly items: readonly VisualItem[];
  readonly groups: readonly VisualGroup[];
  /** True when nothing is a close match: the UI says "closest we have", never an exact claim. */
  readonly lowConfidence: boolean;
  readonly degraded: boolean;
  readonly modelVersion: string | null;
  readonly categoryGuess: string | null;
}

export type SearchResult =
  | ({ readonly kind: "ok" } & VisualOutput)
  | { readonly kind: "disabled" }
  | { readonly kind: "quota"; readonly scope: "user" | "global" }
  | { readonly kind: "upload_not_found" }
  | { readonly kind: "upload_not_ready" }
  | { readonly kind: "rejected"; readonly reason: ImageReject | "not_fashion" | "unsafe" | "infected" }
  | { readonly kind: "consent_required" }
  | { readonly kind: "embedder_unavailable" }
  | { readonly kind: "index_unavailable" };

const dayOf = (ms: number): number => Math.floor(ms / 86_400_000);
export { dayOf };

class TimeoutError extends Error {}
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, rej) => {
        t = setTimeout(() => rej(new TimeoutError("timeout")), ms);
      }),
    ]);
  } finally {
    if (t !== undefined) clearTimeout(t);
  }
}

/** Server-side filters. Unknown age fails closed to the account minimum of 18. */
export function passesFilters(c: VisualCandidate, f: VisualFilters, ctx: ShopperContext): boolean {
  if (!c.inStock || !c.storeActive) return false;
  if (c.minAge > (ctx.ageYears ?? 18)) return false;
  if (f.world !== undefined && f.world !== "all" && c.world !== f.world) return false;
  if (f.myStores === true && !ctx.myStoreIds.includes(c.storeId)) return false;
  if (f.inMySize === true) {
    if (ctx.sizeLabels.length === 0) return false;
    if (!c.sizesInStock.some((s) => ctx.sizeLabels.includes(s))) return false;
  }
  if (f.maxPriceMinor !== undefined && c.priceMinor > f.maxPriceMinor) return false;
  if (f.categoryId !== undefined && c.categoryId !== f.categoryId) return false;
  return true;
}

/** Item facts come from the catalog at request time. The index only nominates candidates. */
async function retrieve(
  d: VisualDeps,
  vector: readonly number[],
  modelVersion: string,
  filters: VisualFilters,
  ctx: ShopperContext,
  query: QueryAttributes | undefined,
  limit: number,
  excludeId?: string,
): Promise<{ readonly items: readonly VisualItem[]; readonly topSimilarity: number }> {
  const want = Math.min(limit, d.limits.maxResults);
  // Filtered ANN loses recall (ADR-0023): oversample, widen while survivors are short.
  let k = Math.min(d.limits.oversampleCap, Math.max(want * 4, 20));
  let survivors: ReturnType<typeof rerank>;
  for (;;) {
    const raw: readonly Neighbor[] = await d.index.search({ vector, modelVersion, k: k + (excludeId === undefined ? 0 : 1) });
    const nominated = raw.filter((n) => n.productId !== excludeId);
    const facts = await d.catalog.byIds(nominated.map((n) => n.productId));
    const byId = new Map(facts.filter((c) => passesFilters(c, filters, ctx)).map((c) => [c.productId, c]));
    survivors = rerank(nominated, byId, query);
    if (survivors.length >= want || raw.length < k || k >= d.limits.oversampleCap) break;
    k = Math.min(d.limits.oversampleCap, k * 4);
  }
  const top = survivors[0]?.similarity ?? 0;
  const picked = diversify(survivors).slice(0, want);
  const close = d.limits.lowConfidenceBelow;
  return {
    topSimilarity: top,
    items: picked.map((r) => ({
      productId: r.candidate.productId,
      storeId: r.candidate.storeId,
      categoryId: r.candidate.categoryId,
      priceMinor: r.candidate.priceMinor,
      verifiedDiscountPct: r.candidate.claimAllowed ? r.candidate.verifiedDiscountPct : null,
      match: r.similarity >= close ? ("close" as const) : ("similar" as const),
    })),
  };
}

function group(items: readonly VisualItem[]): VisualGroup[] {
  const m = new Map<string, VisualItem[]>();
  for (const i of items) m.set(i.categoryId, [...(m.get(i.categoryId) ?? []), i]);
  return [...m.entries()].map(([categoryId, its]) => ({ categoryId, items: its }));
}

const toOutput = (items: readonly VisualItem[], o: { lowConfidence: boolean; degraded: boolean; modelVersion: string | null; categoryGuess: string | null }): VisualOutput => ({
  items,
  groups: group(items),
  ...o,
});

class Base {
  constructor(protected readonly d: VisualDeps) {}
  protected async log(mode: "image" | "product", startedMs: number, outcome: RequestOutcome, count: number, category: string | null, model: string | null): Promise<void> {
    const now = this.d.clock.nowMs();
    await this.d.store.recordRequest({ id: this.d.ids.uuidV7(), tsMs: now, mode, outcome, latencyMs: Math.max(0, now - startedMs), resultCount: count, categoryGuess: category, modelVersion: model });
    this.d.metrics.incr("visual_search_requests", { mode, outcome });
  }
}

/** Issues a short-lived signed upload for a query image (private bucket, TTL 10 min). */
export class IssueQueryUpload extends Base {
  async execute(input: { readonly userId: string; readonly contentType: ImageMime; readonly sizeBytes: number }): Promise<
    { readonly kind: "ok"; readonly upload: IssuedUpload } | { readonly kind: "disabled" } | { readonly kind: "unavailable" } | { readonly kind: "too_large" }
  > {
    if (!(await this.d.flags.enabled())) return { kind: "disabled" };
    if (!this.d.images.configured) return { kind: "unavailable" };
    if (!Number.isInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > this.d.limits.maxBytes) return { kind: "too_large" };
    const upload = await this.d.images.issue({ ownerId: input.userId, contentType: input.contentType, sizeBytes: input.sizeBytes });
    const now = this.d.clock.nowMs();
    await this.d.store.recordUpload({ id: upload.uploadId, ownerId: input.userId, contentType: input.contentType, createdAtMs: now, expiresAtMs: now + this.d.limits.uploadTtlMs });
    return { kind: "ok", upload };
  }
}

export interface ImageSearchInput {
  readonly userId: string;
  readonly uploadId: string;
  readonly crop?: Box;
  readonly categoryHint?: string;
  readonly filters: VisualFilters;
  readonly limit: number;
}

export class SearchByImage extends Base {
  async execute(i: ImageSearchInput): Promise<SearchResult> {
    const d = this.d;
    const started = d.clock.nowMs();
    if (!(await d.flags.enabled())) return { kind: "disabled" };
    const q = await d.store.consumeQuota({ userId: i.userId, nowMs: started, userDailyLimit: d.limits.userDailyLimit, globalDailyLimit: d.limits.globalDailyLimit });
    if (q !== "ok") return { kind: "quota", scope: q === "user_limit" ? "user" : "global" };
    // Ownership and single use: another user's id is indistinguishable from a missing one.
    if (!(await d.images.owns(i.userId, i.uploadId)) || !(await d.store.claimUpload(i.userId, i.uploadId, started))) return { kind: "upload_not_found" };
    try {
      return await this.run(i, started);
    } finally {
      // Zero retention: the object is deleted whatever the outcome. A failure here is retried by the sweeper.
      await d.images.delete(i.uploadId).catch(() => undefined);
      await d.store.markUploadsDeleted([i.uploadId], d.clock.nowMs()).catch(() => undefined);
    }
  }

  private async run(i: ImageSearchInput, started: number): Promise<SearchResult> {
    const d = this.d;
    const reject = async (reason: Extract<SearchResult, { kind: "rejected" }>["reason"]): Promise<SearchResult> => {
      await this.log("image", started, "rejected", 0, null, null);
      return { kind: "rejected", reason };
    };
    const scan = await d.images.scanState(i.uploadId);
    if (scan === null) return { kind: "upload_not_found" };
    if (scan === "infected") return reject("infected");
    if (scan !== "clean") return { kind: "upload_not_ready" };
    const raw = await d.images.read(i.uploadId);
    if (raw === null) return { kind: "upload_not_found" };

    const img = sanitizeImage(raw, d.limits);
    if (!img.ok) return reject(img.reason);
    const verdict = await d.safety.classify(img.bytes, img.mime);
    if (verdict.nsfw) return reject("unsafe");
    if (!verdict.fashion) return reject("not_fashion");

    if (d.embedder.residency === "external" && !(await d.consent.crossBorderMlGranted(i.userId))) return { kind: "consent_required" };
    const ctx = await d.shopper.profile(i.userId);
    const faceBoxes = await d.faces.detect(img.bytes, img.mime);

    let embedded;
    try {
      embedded = await withTimeout(
        d.embedder.embed({ bytes: img.bytes, mime: img.mime, ...(i.crop === undefined ? {} : { crop: i.crop }), maskRegions: faceBoxes }),
        d.limits.embedTimeoutMs,
      );
    } catch (e) {
      if (e instanceof EmbedderUnconfiguredError) return { kind: "embedder_unavailable" };
      // Timeout or failure: attribute search only when the client sent a category hint.
      if (i.categoryHint === undefined) {
        d.metrics.incr("visual_search_embedder_failure");
        return { kind: "embedder_unavailable" };
      }
      const fb = (await d.catalog.popularInCategory(i.categoryHint, d.limits.maxResults * 2)).filter((c) => passesFilters(c, i.filters, ctx));
      const items = fb.slice(0, Math.min(i.limit, d.limits.maxResults)).map<VisualItem>((c) => ({
        productId: c.productId,
        storeId: c.storeId,
        categoryId: c.categoryId,
        priceMinor: c.priceMinor,
        verifiedDiscountPct: c.claimAllowed ? c.verifiedDiscountPct : null,
        match: "similar",
      }));
      await this.log("image", started, "degraded", items.length, i.categoryHint, null);
      return { kind: "ok", ...toOutput(items, { lowConfidence: true, degraded: true, modelVersion: null, categoryGuess: i.categoryHint }) };
    }
    if (!validVector(embedded.vector, embedded.vector.length) || embedded.vector.length === 0) return { kind: "embedder_unavailable" };

    let r;
    try {
      r = await retrieve(d, embedded.vector, embedded.modelVersion, i.filters, ctx, embedded.attributes, i.limit);
    } catch (e) {
      if (e instanceof IndexUnavailableError) return { kind: "index_unavailable" };
      throw e;
    }
    const low = r.items.length > 0 && r.topSimilarity < d.limits.lowConfidenceBelow;
    const category = embedded.attributes?.category ?? null;
    await this.log("image", started, r.items.length === 0 ? "no_result" : low ? "low_confidence" : "ok", r.items.length, category, embedded.modelVersion);
    return { kind: "ok", ...toOutput(r.items, { lowConfidence: low, degraded: false, modelVersion: embedded.modelVersion, categoryGuess: category }) };
  }
}

export class SimilarByProduct extends Base {
  async execute(input: { readonly userId: string | null; readonly productId: string; readonly filters: VisualFilters; readonly limit: number }): Promise<
    | { readonly kind: "ok"; readonly result: VisualOutput }
    | { readonly kind: "not_found" }
    | { readonly kind: "disabled" }
  > {
    const d = this.d;
    const started = d.clock.nowMs();
    if (!(await d.flags.enabled())) return { kind: "disabled" };
    const [self] = await d.catalog.byIds([input.productId]);
    if (self === undefined || !self.storeActive) return { kind: "not_found" };
    const ctx: ShopperContext = input.userId === null ? { ageYears: null, sizeLabels: [], myStoreIds: [] } : await d.shopper.profile(input.userId);
    const fallback = async (): Promise<{ kind: "ok"; result: VisualOutput }> => {
      const pool = (await d.catalog.popularInCategory(self.categoryId, d.limits.maxResults * 2)).filter((c) => c.productId !== self.productId && passesFilters(c, input.filters, ctx));
      const items = pool.slice(0, Math.min(input.limit, d.limits.maxResults)).map<VisualItem>((c) => ({
        productId: c.productId,
        storeId: c.storeId,
        categoryId: c.categoryId,
        priceMinor: c.priceMinor,
        verifiedDiscountPct: c.claimAllowed ? c.verifiedDiscountPct : null,
        match: "similar",
      }));
      await this.log("product", started, "degraded", items.length, self.categoryId, null);
      return { kind: "ok", result: toOutput(items, { lowConfidence: true, degraded: true, modelVersion: null, categoryGuess: self.categoryId }) };
    };
    try {
      const own = await d.index.vectorOf(input.productId);
      if (own === null) return await fallback();
      const r = await retrieve(d, own.vector, own.modelVersion, input.filters, ctx, { category: self.categoryId, ...(self.colour === null ? {} : { colour: self.colour }), ...(self.pattern === null ? {} : { pattern: self.pattern }) }, input.limit, self.productId);
      await this.log("product", started, r.items.length === 0 ? "no_result" : "ok", r.items.length, self.categoryId, own.modelVersion);
      return { kind: "ok", result: toOutput(r.items, { lowConfidence: false, degraded: false, modelVersion: own.modelVersion, categoryGuess: self.categoryId }) };
    } catch (e) {
      if (e instanceof IndexUnavailableError) return fallback();
      throw e;
    }
  }
}

/** Deletes expired or abandoned query images and purges telemetry past retention (run by a worker). */
export class SweepVisualSearch extends Base {
  async execute(limit = 500): Promise<{ readonly deletedObjects: number; readonly purged: { readonly uploads: number; readonly requests: number; readonly usage: number } }> {
    const now = this.d.clock.nowMs();
    const ids = await this.d.store.expiredUploads(now, limit);
    const done: string[] = [];
    for (const id of ids) {
      try {
        await this.d.images.delete(id);
        done.push(id);
      } catch {
        this.d.metrics.incr("visual_search_sweep_delete_failed");
      }
    }
    await this.d.store.markUploadsDeleted(done, now);
    const purged = await this.d.store.purge(now - 48 * 3_600_000);
    return { deletedObjects: done.length, purged };
  }
}
