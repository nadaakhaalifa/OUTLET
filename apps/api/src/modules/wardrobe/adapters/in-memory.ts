import { createHash } from "node:crypto";
import { CATEGORIES, COLOURS, MATERIALS, PATTERNS, type PartialAttributes } from "../domain/attributes";
import { SEASONS } from "../domain/bridge";
import type {
  AttributeSuggestion,
  AttributesSource,
  CreateItemResult,
  ImageMime,
  IssuedUpload,
  Page,
  ScanState,
  UpdateItemResult,
  UploadRecord,
  VisionAttributePort,
  WardrobeConsentPort,
  WardrobeEvent,
  WardrobeFlagPort,
  WardrobeImageStorePort,
  WardrobeItem,
  WardrobeStore,
} from "../domain/ports";

/** Cursor: `<createdAtMs>.<id>` of the last item of the previous page, opaque to clients. */
export const encodeCursor = (ms: number, id: string): string => Buffer.from(`${ms}.${id}`, "utf8").toString("base64url");
export function decodeCursor(c: string): { readonly ms: number; readonly id: string } | null {
  const m = /^(\d{1,15})\.([0-9a-f-]{36})$/.exec(Buffer.from(c, "base64url").toString("utf8"));
  return m === null ? null : { ms: Number(m[1]), id: m[2] ?? "" };
}

const newestFirst = (a: WardrobeItem, b: WardrobeItem): number => b.createdAtMs - a.createdAtMs || (a.id < b.id ? 1 : -1);

export class InMemoryWardrobeStore implements WardrobeStore {
  readonly items = new Map<string, WardrobeItem>();
  readonly uploads = new Map<string, UploadRecord>();
  readonly events: WardrobeEvent[] = [];
  /** Keys of deleted rows not yet purged (stands in for the graveyard trigger). */
  readonly graveyard = new Set<string>();

  async insertUpload(u: UploadRecord, max: number): Promise<"stored" | "quota"> {
    const pending = [...this.uploads.values()].filter((x) => x.userId === u.userId && x.consumedAtMs === null).length;
    if (pending >= max) return "quota";
    this.uploads.set(u.uploadId, u);
    return "stored";
  }
  async getUpload(userId: string, uploadId: string): Promise<UploadRecord | null> {
    const u = this.uploads.get(uploadId);
    return u !== undefined && u.userId === userId ? u : null;
  }
  async insertItem(item: WardrobeItem, uploadId: string | null, maxItems: number, events: readonly WardrobeEvent[]): Promise<CreateItemResult> {
    if ([...this.items.values()].filter((i) => i.userId === item.userId).length >= maxItems) return "limit_reached";
    if (uploadId !== null) {
      const u = this.uploads.get(uploadId);
      if (u === undefined || u.userId !== item.userId || u.consumedAtMs !== null) return "upload_unavailable";
      this.uploads.set(uploadId, { ...u, consumedAtMs: item.createdAtMs });
    }
    this.items.set(item.id, item);
    this.events.push(...events);
    return "created";
  }
  async getItem(id: string): Promise<WardrobeItem | null> {
    return this.items.get(id) ?? null;
  }
  async all(userId: string): Promise<readonly WardrobeItem[]> {
    return [...this.items.values()].filter((i) => i.userId === userId).sort(newestFirst);
  }
  async list(userId: string, limit: number, cursor: string | null): Promise<Page<WardrobeItem>> {
    let rows = await this.all(userId);
    if (cursor !== null) {
      const c = decodeCursor(cursor);
      if (c === null) throw new RangeError("bad cursor");
      rows = rows.filter((i) => i.createdAtMs < c.ms || (i.createdAtMs === c.ms && i.id < c.id));
    }
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return { items: page, nextCursor: rows.length > limit && last !== undefined ? encodeCursor(last.createdAtMs, last.id) : null };
  }
  async updateAttributes(
    id: string,
    userId: string,
    expectedVersion: number | null,
    attributes: PartialAttributes,
    source: AttributesSource,
    modelVersion: string | null,
    atMs: number,
    events: readonly WardrobeEvent[],
  ): Promise<UpdateItemResult> {
    const cur = this.items.get(id);
    if (cur === undefined || cur.userId !== userId) return { kind: "not_found" };
    if (expectedVersion !== null && cur.version !== expectedVersion) return { kind: "conflict" };
    const next: WardrobeItem = { ...cur, attributes, attributesSource: source, visionModelVersion: modelVersion, version: cur.version + 1, updatedAtMs: atMs };
    this.items.set(id, next);
    this.events.push(...events);
    return { kind: "updated", item: next };
  }
  async setImageState(id: string, state: ScanState, atMs: number): Promise<void> {
    const cur = this.items.get(id);
    if (cur !== undefined && cur.imageRef !== null) this.items.set(id, { ...cur, imageState: state, updatedAtMs: atMs });
  }
  async deleteItem(id: string, userId: string, events: readonly WardrobeEvent[]): Promise<{ readonly deleted: boolean; readonly imageRef: string | null }> {
    const cur = this.items.get(id);
    if (cur === undefined || cur.userId !== userId) return { deleted: false, imageRef: null };
    this.items.delete(id);
    if (cur.imageRef !== null) this.graveyard.add(cur.imageRef);
    this.events.push(...events);
    return { deleted: true, imageRef: cur.imageRef };
  }
  async clear(userId: string): Promise<{ readonly count: number; readonly imageRefs: readonly string[] }> {
    const mine = [...this.items.values()].filter((i) => i.userId === userId);
    const refs = mine.flatMap((i) => (i.imageRef === null ? [] : [i.imageRef]));
    for (const i of mine) this.items.delete(i.id);
    for (const [k, u] of [...this.uploads]) {
      if (u.userId !== userId) continue;
      this.uploads.delete(k);
      if (u.consumedAtMs === null) refs.push(u.uploadId);
    }
    for (const r of refs) this.graveyard.add(r);
    this.events.push({ type: "wardrobe.cleared", userId, count: mine.length });
    return { count: mine.length, imageRefs: refs };
  }
}

// ---- fakes ---------------------------------------------------------------------------------------

export class FakeWardrobeImages implements WardrobeImageStorePort {
  readonly configured = true;
  readonly objects = new Map<string, { ownerId: string; contentType: ImageMime; state: ScanState; bytes: Uint8Array }>();
  deleted: string[] = [];
  private seq = 0;

  async issue(i: { readonly ownerId: string; readonly contentType: ImageMime; readonly sizeBytes: number }): Promise<IssuedUpload> {
    const uploadId = `wardrobe/2026/10/00000000-0000-4000-8000-${String(++this.seq).padStart(12, "0")}`;
    this.objects.set(uploadId, { ownerId: i.ownerId, contentType: i.contentType, state: "pending_scan", bytes: new Uint8Array(0) });
    return { uploadId, url: `https://objects.test/${uploadId}`, headers: { "content-type": i.contentType, "x-amz-tagging": "scan=pending_scan" }, expiresAtMs: 0 };
  }
  /** Simulates the client PUT plus the scan pipeline verdict. */
  put(uploadId: string, bytes: Uint8Array, state: ScanState = "clean"): void {
    const o = this.objects.get(uploadId);
    if (o === undefined) throw new Error("unknown upload");
    this.objects.set(uploadId, { ...o, bytes, state });
  }
  async owns(ownerId: string, uploadId: string): Promise<boolean> {
    return this.objects.get(uploadId)?.ownerId === ownerId;
  }
  async scanState(uploadId: string): Promise<ScanState | null> {
    return this.objects.get(uploadId)?.state ?? null;
  }
  async read(uploadId: string): Promise<Uint8Array | null> {
    const o = this.objects.get(uploadId);
    return o === undefined || o.state !== "clean" ? null : o.bytes;
  }
  async signGet(uploadId: string, ttl: number): Promise<{ url: string; expiresAtMs: number } | null> {
    const o = this.objects.get(uploadId);
    return o === undefined || o.state !== "clean" ? null : { url: `https://objects.test/get/${uploadId}?ttl=${ttl}`, expiresAtMs: ttl * 1000 };
  }
  async delete(uploadId: string): Promise<void> {
    this.objects.delete(uploadId);
    this.deleted.push(uploadId);
  }
}

/** Deterministic: the same bytes always give the same suggestion. Never a classifier. */
export class FakeVision implements VisionAttributePort {
  readonly configured = true;
  residency: "in_region" | "external" = "in_region";
  calls = 0;
  async suggest(i: { readonly image: Uint8Array; readonly contentType: ImageMime }): Promise<AttributeSuggestion | null> {
    this.calls++;
    if (i.image.length === 0) return null;
    const h = createHash("sha256").update(i.image).digest();
    const at = (n: number): number => h[n] ?? 0;
    const category = CATEGORIES[at(0) % CATEGORIES.length] ?? "top";
    return {
      modelVersion: "fake-vision-1",
      attributes: {
        category,
        palette: [COLOURS[at(1) % COLOURS.length] ?? "black"],
        pattern: PATTERNS[at(2) % PATTERNS.length] ?? "solid",
        formality: at(3) % 5,
        seasons: [SEASONS[at(4) % SEASONS.length] ?? "all"],
        material: MATERIALS[at(5) % MATERIALS.length] ?? "cotton",
        modest: false,
      },
    };
  }
}

export class FakeConsent implements WardrobeConsentPort {
  personalization = new Set<string>();
  crossBorder = new Set<string>();
  async personalizationGranted(userId: string): Promise<boolean> {
    return this.personalization.has(userId);
  }
  async crossBorderMlGranted(userId: string): Promise<boolean> {
    return this.crossBorder.has(userId);
  }
}

export class StaticWardrobeFlags implements WardrobeFlagPort {
  constructor(public on: Set<string> = new Set()) {}
  async isEnabled(key: string): Promise<boolean> {
    return this.on.has(key);
  }
}
