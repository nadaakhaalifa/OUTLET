import { assertTransition } from "../domain/machine";
import { DEFAULT_BG_MODEL, QUOTA_UNITS_PER_RUN } from "../domain/ports";
import type {
  BackgroundRemovalError,
  BackgroundRemovalPort,
  CutoutOptions,
  CutoutResult,
  DerivativeKind,
  IssuedUpload,
  JobPatch,
  MaskStats,
  ProductMediaVersion,
  RefineRequest,
  RefineResult,
  ProductMediaBlobPort,
  ProductMediaConsentPort,
  ProductMediaFlagPort,
  ProductMediaJob,
  ProductMediaStore,
  ScanState,
} from "../domain/ports";

export class InMemoryProductMediaStore implements ProductMediaStore {
  private readonly jobs = new Map<string, ProductMediaJob>();
  private readonly quota = new Map<string, number>();
  private readonly versions = new Map<string, ProductMediaVersion>();

  async insertJob(job: ProductMediaJob): Promise<"created" | "duplicate"> {
    for (const j of this.jobs.values()) if (j.storeId === job.storeId && j.originalRef === job.originalRef) return "duplicate";
    this.jobs.set(job.id, job);
    return "created";
  }
  async getJob(id: string): Promise<ProductMediaJob | null> {
    return this.jobs.get(id) ?? null;
  }
  async update(id: string, expectedVersion: number, patch: JobPatch): Promise<ProductMediaJob | null> {
    const cur = this.jobs.get(id);
    if (cur === undefined || cur.version !== expectedVersion) return null;
    if (patch.status !== undefined && patch.status !== cur.status) assertTransition(cur.status, patch.status);
    const { updatedAtMs, ...rest } = patch;
    const next: ProductMediaJob = { ...cur, ...rest, updatedAtMs, version: cur.version + 1 };
    this.jobs.set(id, next);
    return next;
  }
  async listByStore(storeId: string, limit: number): Promise<readonly ProductMediaJob[]> {
    return [...this.jobs.values()]
      .filter((j) => j.storeId === storeId)
      .sort((a, b) => b.createdAtMs - a.createdAtMs || (a.id < b.id ? 1 : -1))
      .slice(0, limit);
  }
  async consumeQuota(storeId: string, day: string, limit: number): Promise<boolean> {
    return this.consumeQuotaUnits(storeId, day, QUOTA_UNITS_PER_RUN, limit);
  }
  async consumeQuotaUnits(storeId: string, day: string, units: number, limitRuns: number): Promise<boolean> {
    const k = `${storeId}|${day}`;
    const n = this.quota.get(k) ?? 0;
    if (n + units > limitRuns * QUOTA_UNITS_PER_RUN) return false;
    this.quota.set(k, n + units);
    return true;
  }
  async listVersions(jobId: string): Promise<readonly ProductMediaVersion[]> {
    return [...this.versions.values()].filter((v) => v.jobId === jobId).sort((a, b) => a.version - b.version);
  }
  async getVersion(jobId: string, version: number): Promise<ProductMediaVersion | null> {
    return this.versions.get(`${jobId}|${version}`) ?? null;
  }
  async insertVersion(v: ProductMediaVersion): Promise<"created" | "duplicate"> {
    const k = `${v.jobId}|${v.version}`;
    if (this.versions.has(k)) return "duplicate";
    this.versions.set(k, v);
    return "created";
  }
  async deleteVersion(jobId: string, version: number): Promise<ProductMediaVersion | null> {
    const k = `${jobId}|${version}`;
    const v = this.versions.get(k) ?? null;
    this.versions.delete(k);
    return v;
  }
  async replacePromoted(
    jobId: string,
    expectedImage: string,
    refs: { image: string; cutout: string | null },
    version: number,
  ): Promise<ProductMediaJob | null> {
    const cur = this.jobs.get(jobId);
    if (cur === undefined || cur.promotedImageRef !== expectedImage) return null;
    const next = { ...cur, promotedImageRef: refs.image, promotedCutoutRef: refs.cutout, promotedVersion: version };
    this.jobs.set(jobId, next);
    return next;
  }
  async claimAttachment(jobId: string, storeId: string, productId: string): Promise<ProductMediaJob | null> {
    const cur = this.jobs.get(jobId);
    if (cur === undefined || cur.storeId !== storeId) return null;
    if (cur.attachedProductId !== null && cur.attachedProductId !== productId) return null;
    const next = { ...cur, attachedProductId: productId };
    this.jobs.set(jobId, next);
    return next;
  }
  async releaseAttachment(jobId: string, storeId: string, productId: string): Promise<void> {
    const cur = this.jobs.get(jobId);
    if (cur !== undefined && cur.storeId === storeId && cur.attachedProductId === productId) this.jobs.set(jobId, { ...cur, attachedProductId: null });
  }
  async setPromoted(jobId: string, refs: { image: string; cutout: string | null }): Promise<ProductMediaJob | null> {
    const cur = this.jobs.get(jobId);
    if (cur === undefined) return null;
    if (cur.promotedImageRef !== null) return cur;
    const next = { ...cur, promotedImageRef: refs.image, promotedCutoutRef: refs.cutout };
    this.jobs.set(jobId, next);
    return next;
  }
  /** Test helper. */
  all(): readonly ProductMediaJob[] {
    return [...this.jobs.values()];
  }
}

const hash = (b: Uint8Array): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < b.length; i++) h = Math.imul(h ^ (b[i] ?? 0), 0x01000193) >>> 0;
  return h;
};
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const fakeBytes = (head: readonly number[], tag: string, h: number): Uint8Array =>
  new Uint8Array([...head, ...new TextEncoder().encode(`${tag}:${h.toString(16)}`)]);

export const GOOD_STATS: MaskStats = {
  width: 1200,
  height: 1600,
  coverage: 0.42,
  borderTouch: 0,
  components: 1,
  holeRatio: 0.005,
  softEdgeRatio: 0.02,
  subjectBrightRatio: 0.05,
  borderBrightRatio: 0.9,
};

/** Deterministic: the same input bytes and options always give the same outputs. Not an image model. */
export class FakeBackgroundRemoval implements BackgroundRemovalPort {
  readonly configured = true;
  readonly residency: "in_region" | "external";
  calls = 0;
  statsFor: (input: Uint8Array) => MaskStats = () => GOOD_STATS;
  failWith: BackgroundRemovalError | null = null;
  delayMs = 0;
  constructor(o: { residency?: "in_region" | "external" } = {}) {
    this.residency = o.residency ?? "in_region";
  }
  async cutout(image: Uint8Array, o: CutoutOptions): Promise<CutoutResult> {
    this.calls += 1;
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.failWith !== null) throw this.failWith;
    const h = hash(image) ^ hash(new TextEncoder().encode(o.model));
    return {
      png: fakeBytes(PNG, "png", h),
      mask: fakeBytes(PNG, "mask", h),
      whiteJpg: fakeBytes([0xff, 0xd8, 0xff, 0xe0], "jpg", h),
      shadowPng: o.shadow ? fakeBytes(PNG, "shadow", h) : null,
      stats: this.statsFor(image),
      modelId: o.model,
      modelVersion: "fake-1",
      latencyMs: 5,
    };
  }
  /** Recorded refine requests (strokes and settings), newest last. */
  refineCalls: RefineRequest[] = [];
  /** Deterministic: the new mask hash depends on the input mask hash and every stroke, so an edit always changes it. */
  async refine(image: Uint8Array, r: RefineRequest): Promise<RefineResult> {
    this.refineCalls.push(r);
    if (this.delayMs > 0) await new Promise((res) => setTimeout(res, this.delayMs));
    if (this.failWith !== null) throw this.failWith;
    const enc = new TextEncoder();
    const edit = JSON.stringify({ s: r.strokes, f: r.featherPx, m: r.smooth, e: r.edgeShiftPx, b: r.background });
    const h = (hash(image) ^ (r.mask === null ? 0 : hash(r.mask)) ^ hash(enc.encode(edit))) >>> 0;
    return {
      png: fakeBytes(PNG, "png", h),
      mask: fakeBytes(PNG, "mask", h),
      whiteJpg: fakeBytes([0xff, 0xd8, 0xff, 0xe0], "jpg", h),
      shadowPng: fakeBytes(PNG, "shadow", h),
      stats: this.statsFor(image),
      modelId: DEFAULT_BG_MODEL,
      modelVersion: "fake-1",
      latencyMs: 4,
      backgroundRender: r.background === "transparent" ? null : fakeBytes([0xff, 0xd8, 0xff, 0xe0], `bg-${r.background}`, h),
    };
  }
}

export class FakeProductMediaBlobs implements ProductMediaBlobPort {
  readonly configured = true;
  readonly objects = new Map<string, { bytes: Uint8Array; owner: string; scan: ScanState; contentType: string }>();
  private n = 0;
  async issueUpload(i: { storeId: string; contentType: string; sizeBytes: number }): Promise<IssuedUpload> {
    this.n += 1;
    const key = `product-media/2026/10/${String(this.n).padStart(8, "0")}-0000-4000-8000-000000000000`;
    this.objects.set(key, { bytes: new Uint8Array(0), owner: i.storeId, scan: "pending_scan", contentType: i.contentType });
    return { uploadId: key, url: `https://bucket.test/${key}?sig=put`, headers: { "content-type": i.contentType }, expiresAtMs: Date.now() + 600_000 };
  }
  /** Test helper: the browser's PUT plus the scan worker's verdict. */
  put(key: string, bytes: Uint8Array, scan: ScanState = "clean"): void {
    const o = this.objects.get(key);
    if (o === undefined) throw new Error("no such upload");
    this.objects.set(key, { ...o, bytes, scan });
  }
  async owns(storeId: string, key: string): Promise<boolean> {
    return this.objects.get(key)?.owner === storeId;
  }
  async scanState(key: string): Promise<ScanState | null> {
    return this.objects.get(key)?.scan ?? null;
  }
  async read(key: string): Promise<Uint8Array | null> {
    const o = this.objects.get(key);
    return o !== undefined && o.scan === "clean" ? o.bytes : null;
  }
  async writeDerivative(i: { storeId: string; kind: DerivativeKind; bytes: Uint8Array }): Promise<string> {
    this.n += 1;
    const key = `product-media-derived/2026/10/${String(this.n).padStart(8, "0")}-0000-4000-8000-000000000000`;
    this.objects.set(key, { bytes: i.bytes, owner: i.storeId, scan: "clean", contentType: i.kind === "png" ? "image/png" : "image/jpeg" });
    return key;
  }
  async promote(i: { storeId: string; key: string }): Promise<string> {
    const o = this.objects.get(i.key);
    if (o === undefined || o.owner !== i.storeId || o.scan !== "clean") throw new Error("object cannot be promoted");
    this.n += 1;
    const key = `catalog/2026/10/${String(this.n).padStart(8, "0")}-0000-4000-8000-000000000000`;
    this.objects.set(key, { ...o });
    return key;
  }
  async signGet(key: string, ttlSeconds: number): Promise<{ url: string; expiresAtMs: number } | null> {
    const o = this.objects.get(key);
    if (o === undefined || o.scan !== "clean") return null;
    const ttl = Math.min(ttlSeconds, 15 * 60);
    return { url: `https://bucket.test/${key}?sig=get&ttl=${ttl}`, expiresAtMs: Date.now() + ttl * 1000 };
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

export class StaticProductMediaFlags implements ProductMediaFlagPort {
  constructor(private readonly on: Set<string>) {}
  set(key: string, v: boolean): void {
    if (v) this.on.add(key);
    else this.on.delete(key);
  }
  async isEnabled(key: string): Promise<boolean> {
    return this.on.has(key);
  }
}

export class DenyCrossBorderConsent implements ProductMediaConsentPort {
  async crossBorderMlGranted(): Promise<boolean> {
    return false;
  }
}
