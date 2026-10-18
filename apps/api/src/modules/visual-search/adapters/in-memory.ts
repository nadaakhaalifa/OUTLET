import { createHash } from "node:crypto";
import {
  EmbedderUnconfiguredError,
  IndexUnavailableError,
  type Box,
  type EmbedResult,
  type EvalRunRecord,
  type FaceRegionDetectorPort,
  type ImageEmbedderPort,
  type ImageMime,
  type ImageSafetyPort,
  type IssuedUpload,
  type QueryImageStorePort,
  type QuotaResult,
  type RequestLog,
  type ScanState,
  type ShopperContext,
  type ShopperContextPort,
  type VisualCandidate,
  type VisualCatalogPort,
  type VisualConsentPort,
  type VisualFlagsPort,
  type VisualIndexPort,
  type VisualMetrics,
  type VisualSearchStore,
  type Neighbor,
} from "../domain/ports";
import { cosine, norm } from "../domain/similarity";

export const EMBED_DIM = 768;
export const FAKE_MODEL_VERSION = "fake-siglip-v1";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic unit vector from a seed (Box-Muller). Shared by the fake embedder and the eval set. */
export function seededUnitVector(seed: number, dim = EMBED_DIM): number[] {
  const r = mulberry32(seed);
  const v: number[] = [];
  for (let i = 0; i < dim; i++) {
    const u1 = Math.max(r(), 1e-12);
    const u2 = r();
    v.push(Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2));
  }
  const n = norm(v);
  return v.map((x) => x / n);
}

/** Deterministic fake: the vector is a pure function of the image bytes. No model, no network. */
export class FakeImageEmbedder implements ImageEmbedderPort {
  readonly configured = true;
  residency: "in_region" | "external" = "in_region";
  modelVersion = FAKE_MODEL_VERSION;
  readonly calls: { readonly bytes: Uint8Array; readonly crop: Box | undefined; readonly maskRegions: readonly Box[] }[] = [];
  /** Test hooks. */
  failWith: Error | null = null;
  delayMs = 0;
  attributes: EmbedResult["attributes"];

  vectorOf(bytes: Uint8Array): number[] {
    const h = createHash("sha256").update(bytes).digest();
    return seededUnitVector(h.readUInt32BE(0));
  }
  async embed(input: Parameters<ImageEmbedderPort["embed"]>[0]): Promise<EmbedResult> {
    this.calls.push({ bytes: input.bytes, crop: input.crop, maskRegions: input.maskRegions });
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.failWith !== null) throw this.failWith;
    return { vector: this.vectorOf(input.bytes), modelVersion: this.modelVersion, ...(this.attributes === undefined ? {} : { attributes: this.attributes }) };
  }
}

/** Production default until a self-hosted model is deployed and VR-P3-13 is resolved. */
export class UnconfiguredImageEmbedder implements ImageEmbedderPort {
  readonly configured = false;
  readonly residency = "in_region" as const;
  readonly modelVersion = "unconfigured";
  async embed(): Promise<never> {
    throw new EmbedderUnconfiguredError();
  }
}

export class FakeFaceDetector implements FaceRegionDetectorPort {
  faces: readonly Box[] = [];
  readonly calls: number[] = [];
  async detect(bytes: Uint8Array): Promise<readonly Box[]> {
    this.calls.push(bytes.length);
    return this.faces;
  }
}
/** No detector deployed: no regions found. Faces are then not excluded; documented gap. */
export class NoFaceDetector implements FaceRegionDetectorPort {
  async detect(): Promise<readonly Box[]> {
    return [];
  }
}

export class FakeImageSafety implements ImageSafetyPort {
  nsfw = false;
  fashion = true;
  async classify(): Promise<{ nsfw: boolean; fashion: boolean }> {
    return { nsfw: this.nsfw, fashion: this.fashion };
  }
}
/** Fails closed: without a classifier every image is treated as not fashion. */
export class UnconfiguredImageSafety implements ImageSafetyPort {
  async classify(): Promise<{ nsfw: boolean; fashion: boolean }> {
    return { nsfw: false, fashion: false };
  }
}

interface FakeObject {
  bytes: Uint8Array;
  owner: string;
  scan: ScanState;
}
export class FakeQueryImageStore implements QueryImageStorePort {
  readonly configured = true;
  readonly objects = new Map<string, FakeObject>();
  readonly deleted: string[] = [];
  deleteFails = false;
  private seq = 0;
  async issue(input: { ownerId: string; contentType: ImageMime; sizeBytes: number }): Promise<IssuedUpload> {
    const uploadId = `visual-query/2026/10/00000000-0000-4000-8000-${String(++this.seq).padStart(12, "0")}`;
    this.objects.set(uploadId, { bytes: new Uint8Array(0), owner: input.ownerId, scan: "pending_scan" });
    return { uploadId, url: `https://objects.test/${uploadId}`, headers: { "content-type": input.contentType }, expiresAtMs: 0 };
  }
  /** Simulates the client PUT and the scan worker verdict. */
  put(uploadId: string, bytes: Uint8Array, scan: ScanState = "clean"): void {
    const o = this.objects.get(uploadId);
    if (o === undefined) throw new Error("unknown upload");
    this.objects.set(uploadId, { ...o, bytes, scan });
  }
  async owns(ownerId: string, uploadId: string): Promise<boolean> {
    return this.objects.get(uploadId)?.owner === ownerId;
  }
  async scanState(uploadId: string): Promise<ScanState | null> {
    return this.objects.get(uploadId)?.scan ?? null;
  }
  async read(uploadId: string): Promise<Uint8Array | null> {
    return this.objects.get(uploadId)?.bytes ?? null;
  }
  async delete(uploadId: string): Promise<void> {
    if (this.deleteFails) throw new Error("delete failed");
    this.objects.delete(uploadId);
    this.deleted.push(uploadId);
  }
}
export class UnconfiguredQueryImageStore implements QueryImageStorePort {
  readonly configured = false;
  async issue(): Promise<never> {
    throw new Error("object store not configured");
  }
  async owns(): Promise<boolean> {
    return false;
  }
  async scanState(): Promise<null> {
    return null;
  }
  async read(): Promise<null> {
    return null;
  }
  async delete(): Promise<void> {}
}

/** Brute-force exact cosine scan. The reference oracle for the pgvector adapter. */
export class InMemoryVisualIndex implements VisualIndexPort {
  private readonly rows = new Map<string, { vector: readonly number[]; modelVersion: string }>();
  down = false;
  set(productId: string, vector: readonly number[], modelVersion = FAKE_MODEL_VERSION): void {
    this.rows.set(productId, { vector, modelVersion });
  }
  get size(): number {
    return this.rows.size;
  }
  async search(input: { vector: readonly number[]; modelVersion: string; k: number }): Promise<readonly Neighbor[]> {
    if (this.down) throw new IndexUnavailableError();
    const out: Neighbor[] = [];
    for (const [productId, r] of this.rows) {
      if (r.modelVersion !== input.modelVersion) continue; // never compare across model versions
      out.push({ productId, similarity: cosine(input.vector, r.vector) });
    }
    return out.sort((a, b) => b.similarity - a.similarity || (a.productId < b.productId ? -1 : 1)).slice(0, input.k);
  }
  async vectorOf(productId: string) {
    if (this.down) throw new IndexUnavailableError();
    return this.rows.get(productId) ?? null;
  }
}

export class FakeVisualCatalog implements VisualCatalogPort {
  readonly items = new Map<string, VisualCandidate>();
  byIdsCalls = 0;
  add(c: VisualCandidate): void {
    this.items.set(c.productId, c);
  }
  async byIds(ids: readonly string[]): Promise<readonly VisualCandidate[]> {
    this.byIdsCalls++;
    return ids.flatMap((i) => this.items.get(i) ?? []);
  }
  async popularInCategory(categoryId: string, limit: number): Promise<readonly VisualCandidate[]> {
    return [...this.items.values()].filter((c) => c.categoryId === categoryId).sort((a, b) => (a.productId < b.productId ? -1 : 1)).slice(0, limit);
  }
}

export class FakeShopperContext implements ShopperContextPort {
  readonly by = new Map<string, ShopperContext>();
  async profile(userId: string): Promise<ShopperContext> {
    return this.by.get(userId) ?? { ageYears: 25, sizeLabels: [], myStoreIds: [] };
  }
}
export class FakeVisualConsent implements VisualConsentPort {
  readonly granted = new Set<string>();
  async crossBorderMlGranted(userId: string): Promise<boolean> {
    return this.granted.has(userId);
  }
}
export class StaticVisualFlags implements VisualFlagsPort {
  constructor(public on = true) {}
  async enabled(): Promise<boolean> {
    return this.on;
  }
}
export class InMemoryVisualMetrics implements VisualMetrics {
  readonly counters = new Map<string, number>();
  incr(name: string, labels: Readonly<Record<string, string>> = {}): void {
    const k = `${name}${Object.entries(labels).map(([a, b]) => `|${a}=${b}`).join("")}`;
    this.counters.set(k, (this.counters.get(k) ?? 0) + 1);
  }
}

interface UploadRow {
  ownerId: string;
  contentType: ImageMime;
  createdAtMs: number;
  expiresAtMs: number;
  consumed: boolean;
  deleted: boolean;
}
export class InMemoryVisualStore implements VisualSearchStore {
  readonly uploads = new Map<string, UploadRow>();
  readonly requests: RequestLog[] = [];
  readonly usage = new Map<string, number>();
  readonly evalRuns: EvalRunRecord[] = [];
  readonly outbox: { type: string; payload: Record<string, unknown> }[] = [];

  async recordUpload(u: { id: string; ownerId: string; contentType: ImageMime; createdAtMs: number; expiresAtMs: number }): Promise<void> {
    this.uploads.set(u.id, { ownerId: u.ownerId, contentType: u.contentType, createdAtMs: u.createdAtMs, expiresAtMs: u.expiresAtMs, consumed: false, deleted: false });
  }
  async claimUpload(ownerId: string, id: string, nowMs: number): Promise<boolean> {
    const u = this.uploads.get(id);
    if (u === undefined || u.ownerId !== ownerId || u.consumed || u.deleted || u.expiresAtMs <= nowMs) return false;
    u.consumed = true;
    return true;
  }
  async expiredUploads(nowMs: number, limit: number): Promise<readonly string[]> {
    return [...this.uploads.entries()].filter(([, u]) => !u.deleted && u.expiresAtMs <= nowMs).map(([id]) => id).slice(0, limit);
  }
  async markUploadsDeleted(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      const u = this.uploads.get(id);
      if (u !== undefined) u.deleted = true;
    }
  }
  async consumeQuota(i: { userId: string; nowMs: number; userDailyLimit: number; globalDailyLimit: number }): Promise<QuotaResult> {
    const day = Math.floor(i.nowMs / 86_400_000);
    const gk = `${day}|global`;
    const uk = `${day}|${i.userId}`;
    if ((this.usage.get(gk) ?? 0) >= i.globalDailyLimit) return "global_limit";
    if ((this.usage.get(uk) ?? 0) >= i.userDailyLimit) return "user_limit";
    this.usage.set(gk, (this.usage.get(gk) ?? 0) + 1);
    this.usage.set(uk, (this.usage.get(uk) ?? 0) + 1);
    return "ok";
  }
  async recordRequest(r: RequestLog): Promise<void> {
    this.requests.push(r);
    this.outbox.push({ type: "visual_search.performed", payload: { mode: r.mode, outcome: r.outcome, result_count: r.resultCount, latency_ms: r.latencyMs } });
  }
  async purge(beforeMs: number) {
    let uploads = 0;
    for (const [id, u] of this.uploads) if (u.expiresAtMs < beforeMs && u.deleted) {
        this.uploads.delete(id);
        uploads++;
      }
    const before = this.requests.length;
    for (let i = this.requests.length - 1; i >= 0; i--) if ((this.requests[i]?.tsMs ?? 0) < beforeMs) this.requests.splice(i, 1);
    let usage = 0;
    const cut = Math.floor(beforeMs / 86_400_000);
    for (const k of [...this.usage.keys()]) if (Number(k.split("|")[0]) < cut) {
        this.usage.delete(k);
        usage++;
      }
    return { uploads, requests: before - this.requests.length, usage };
  }
  async saveEvalRun(r: EvalRunRecord): Promise<void> {
    this.evalRuns.push(r);
  }
}
