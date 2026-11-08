import { randomBytes, randomUUID } from "node:crypto";
import { createTestClient, roleClient } from "@outlet/db/testing";
import type { SqlClient } from "@outlet/db";
import type { Principal } from "@outlet/policy";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MediaError, MediaService, NoopAvScanner, processImage, publicVariantUrl, srcset, MAX_BYTES } from "../src/index.js";
import type { AvScanPort, MediaAsset } from "../src/index.js";
import { FakeAvScanner, HmacSigner, InMemoryStorage } from "../src/testing.js";

const storeA = randomUUID();
const storeB = randomUUID();
const staff = (storeIds: string[], roles = ["owner"]): Principal => ({ kind: "seller_staff", userId: randomUUID(), marketId: "EG", storeIds, roles, scopes: [] });
const admin = (roles = ["ops"]): Principal => ({ kind: "admin", userId: randomUUID(), marketId: "EG", roles, scopes: [] });
const platform: Principal = { kind: "system", marketId: "EG", roles: [], scopes: ["media.platform_write"] };

/** Smooth gradient + mild noise, 2400x1800, with EXIF GPS-ish metadata; JPEG is well over 1 MB. */
const makePhoto = async (): Promise<Uint8Array> => {
  const w = 2400, h = 1800;
  const raw = Buffer.alloc(w * h * 3);
  let seed = 12345;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const n = (seed % 40) - 20;
    const i = (y * w + x) * 3;
    raw[i] = Math.max(0, Math.min(255, (x * 255) / w + n));
    raw[i + 1] = Math.max(0, Math.min(255, (y * 255) / h + n));
    raw[i + 2] = Math.max(0, Math.min(255, 128 + n));
  }
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } })
    .withExif({ IFD0: { Copyright: "secret-owner" }, IFD3: { GPSLatitudeRef: "N", GPSLongitudeRef: "E" } })
    .jpeg({ quality: 95, chromaSubsampling: "4:4:4" }).toBuffer();
};
const small = (w: number): Promise<Uint8Array> => sharp({ create: { width: w, height: w, channels: 3, background: "#336699" } }).png().toBuffer();
const pdf = new TextEncoder().encode("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");

let raw: SqlClient;
let close: () => Promise<void>;
let photo: Uint8Array;
const storage = new InMemoryStorage();
const signer = new HmacSigner("k");
const now = new Date("2030-01-01T00:00:00Z");
const mk = (scanner: AvScanPort = new FakeAvScanner(), st = storage): MediaService =>
  new MediaService({ app: roleClient(raw, "outlet_app"), worker: roleClient(raw, "outlet_worker"), storage: st, scanner, signer, marketId: "EG", now: () => now });

beforeAll(async () => {
  ({ client: raw, close } = await createTestClient());
  photo = await makePhoto();
});
afterAll(async () => {
  await close();
});

describe("ingest validation", () => {
  it("test photo is large", () => {
    expect(photo.byteLength).toBeGreaterThan(1_000_000);
  });

  it("rejects a declared type that differs from the sniffed one", async () => {
    await expect(mk().ingest({ bytes: photo, declaredMime: "image/png", kind: "product", actor: staff([storeA]), storeId: storeA })).rejects.toMatchObject({ code: "mime_mismatch" });
  });
  it("rejects types outside the allow list (and executables disguised as images)", async () => {
    await expect(mk().ingest({ bytes: pdf, declaredMime: "application/pdf", kind: "product", actor: staff([storeA]), storeId: storeA })).rejects.toMatchObject({ code: "type_not_allowed" });
    await expect(mk().ingest({ bytes: photo, declaredMime: "image/jpeg", kind: "document", actor: staff([storeA]), storeId: storeA })).rejects.toMatchObject({ code: "type_not_allowed" });
    await expect(mk().ingest({ bytes: new TextEncoder().encode("<svg onload=x>"), declaredMime: "image/svg+xml", kind: "product", actor: staff([storeA]), storeId: storeA })).rejects.toMatchObject({ code: "type_not_allowed" });
  });
  it("rejects oversize uploads per kind and empty uploads", async () => {
    const big = new Uint8Array(MAX_BYTES.product + 1);
    big.set(photo.subarray(0, 16));
    await expect(mk().ingest({ bytes: big, declaredMime: "image/jpeg", kind: "product", actor: staff([storeA]), storeId: storeA })).rejects.toMatchObject({ code: "too_large" });
    await expect(mk().ingest({ bytes: new Uint8Array(0), declaredMime: "image/jpeg", kind: "product", actor: staff([storeA]), storeId: storeA })).rejects.toMatchObject({ code: "invalid_image" });
  });
  it("rejects corrupt images and cleans nothing into the DB", async () => {
    const st = new InMemoryStorage();
    const bad = Uint8Array.from(photo.subarray(0, 3000));
    await expect(mk(new FakeAvScanner(), st).ingest({ bytes: bad, declaredMime: "image/jpeg", kind: "product", actor: staff([storeA]), storeId: storeA })).rejects.toBeInstanceOf(MediaError);
    expect(st.objects.size).toBe(0);
  });
});

describe("pipeline output", () => {
  it("strips EXIF/GPS, never upscales, caps 640w at 100 KB per format", async () => {
    const out = await processImage(photo);
    expect(out.renditions.length).toBe(12);
    for (const r of out.renditions) {
      const m = await sharp(r.data).metadata();
      expect(m.exif).toBeUndefined();
      expect(m.icc).toBeUndefined();
      expect(r.width).toBeLessThanOrEqual(out.width);
      expect(m.width).toBe(r.width);
      if (r.width === 640) expect(r.bytes).toBeLessThanOrEqual(100 * 1024);
    }
    const masterMeta = await sharp(out.master).metadata();
    expect(masterMeta.exif).toBeUndefined();
    expect(Buffer.from(out.master).includes(Buffer.from("secret-owner"))).toBe(false);
    expect(Buffer.from(photo).includes(Buffer.from("secret-owner"))).toBe(true);
  });
  it("small sources only get widths <= source (no upscaling)", async () => {
    const a = await processImage(await small(700));
    expect([...new Set(a.renditions.map((r) => r.width))].sort()).toEqual([320, 640]);
    const b = await processImage(await small(200));
    expect([...new Set(b.renditions.map((r) => r.width))]).toEqual([200]);
  });
  it("fails with variant_too_large when even the lowest quality exceeds the cap", async () => {
    const w = 700;
    const noise = randomBytes(w * w * 3);
    const png = await sharp(noise, { raw: { width: w, height: w, channels: 3 } }).png().toBuffer();
    await expect(processImage(png)).rejects.toMatchObject({ code: "variant_too_large" });
  });
});

describe("ingest + scan + outbox", () => {
  it("stores variants, marks ready and emits media.ready in the same tx", async () => {
    const asset = await mk().ingest({ bytes: photo, declaredMime: "image/jpeg", kind: "product", actor: staff([storeA]), storeId: storeA });
    expect(asset.status).toBe("ready");
    expect(asset.width).toBe(2400);
    expect(asset.variants).toHaveLength(12);
    expect(storage.objects.has(asset.storageKey)).toBe(true);
    expect(asset.storageKey.startsWith("private/")).toBe(true);
    expect(asset.variants.every((v) => v.key.startsWith("public/"))).toBe(true);
    const ev = await raw.query<{ event_type: string }>("SELECT event_type FROM outbox_events WHERE aggregate_id = $1", [asset.id]);
    expect(ev.rows.map((r) => r.event_type)).toEqual(["media.ready"]);
  });
  it("infected upload becomes rejected with media.rejected", async () => {
    const a = await mk(new FakeAvScanner({ clean: false, signature: "EICAR" })).ingest({ bytes: photo, declaredMime: "image/jpeg", kind: "product", actor: staff([storeA]), storeId: storeA });
    expect(a.status).toBe("rejected");
    const ev = await raw.query<{ event_type: string }>("SELECT event_type FROM outbox_events WHERE aggregate_id = $1", [a.id]);
    expect(ev.rows[0]?.event_type).toBe("media.rejected");
    expect(() => srcset(a, { sizes: "100vw", cdnBase: "https://cdn.x" })).toThrow(MediaError);
  });
  it("fails closed: NoopAvScanner throws unless MEDIA_AV_SCAN=disabled-local, asset stays pending_scan", async () => {
    const svc = mk(new NoopAvScanner({}));
    await expect(svc.ingest({ bytes: await small(400), declaredMime: "image/png", kind: "product", actor: staff([storeA]), storeId: storeA })).rejects.toMatchObject({ code: "av_unavailable" });
    const p = await raw.query<{ n: string }>("SELECT count(*)::text n FROM media_assets WHERE status = 'pending_scan'");
    expect(Number(p.rows[0]?.n)).toBeGreaterThanOrEqual(1);
    const ok = await mk(new NoopAvScanner({ MEDIA_AV_SCAN: "disabled-local" })).ingest({ bytes: await small(400), declaredMime: "image/png", kind: "product", actor: staff([storeA]), storeId: storeA });
    expect(ok.status).toBe("ready");
  });
  it("outbox write is in the same tx as the status change (rollback leaves it pending)", async () => {
    // sabotage: an invalid market makes the envelope parse fail inside the tx after the UPDATE ran
    const svc = new MediaService({ app: roleClient(raw, "outlet_app"), worker: roleClient(raw, "outlet_worker"), storage, scanner: new FakeAvScanner(), signer, marketId: "EG", now: () => new Date("not-a-date") });
    await expect(svc.ingest({ bytes: await small(300), declaredMime: "image/png", kind: "product", actor: staff([storeA]), storeId: storeA })).rejects.toBeDefined();
    const orphan = await raw.query<{ n: string }>(
      "SELECT count(*)::text n FROM media_assets m WHERE m.status = 'ready' AND NOT EXISTS (SELECT 1 FROM outbox_events e WHERE e.aggregate_id = m.id)");
    expect(orphan.rows[0]?.n).toBe("0");
  });
  it("authorization: other store staff and anonymous cannot ingest; platform needs system scope", async () => {
    await expect(mk().ingest({ bytes: photo, declaredMime: "image/jpeg", kind: "product", actor: staff([storeB]), storeId: storeA })).rejects.toMatchObject({ code: "not_found" });
    await expect(mk().ingest({ bytes: photo, declaredMime: "image/jpeg", kind: "product", actor: staff([storeA], ["support"]), storeId: storeA })).rejects.toMatchObject({ code: "forbidden" });
    await expect(mk().ingest({ bytes: photo, declaredMime: "image/jpeg", kind: "brand_logo", actor: staff([storeA]) })).rejects.toMatchObject({ code: "not_found" });
    const a = await mk().ingest({ bytes: await small(400), declaredMime: "image/png", kind: "brand_logo", actor: platform });
    expect(a.storeId).toBeNull();
  });
  it("RLS: the app role cannot read platform assets or other stores' rows", async () => {
    const { contextClient } = await import("@outlet/db");
    const c = contextClient(roleClient(raw, "outlet_app"), { kind: "store", marketId: "EG", storeId: storeB });
    const r = await c.query<{ n: string }>("SELECT count(*)::text n FROM media_assets");
    expect(r.rows[0]?.n).toBe("0");
  });
});

describe("signed URLs", () => {
  let doc: MediaAsset;
  beforeAll(async () => {
    doc = await mk().ingest({ bytes: pdf, declaredMime: "application/pdf", kind: "document", actor: staff([storeA]), storeId: storeA });
  });
  it("document ingest keeps the original, no variants", () => {
    expect(doc.variants).toEqual([]);
    expect(doc.width).toBeNull();
  });
  it("owner staff gets a URL that expires at the ttl and verifies", async () => {
    const { url, expiresAt } = await mk().signedUrl(doc.id, staff([storeA]), 900);
    expect(expiresAt.getTime() - now.getTime()).toBe(900_000);
    expect(signer.verify(url, now)).toBe(true);
    expect(signer.verify(url, new Date(now.getTime() + 901_000))).toBe(false);
  });
  it("rejects ttl > 900, 0, fractional", async () => {
    for (const t of [901, 0, -1, 1.5]) await expect(mk().signedUrl(doc.id, staff([storeA]), t)).rejects.toMatchObject({ code: "ttl_invalid" });
  });
  it("tenant negative: store B staff cannot sign store A's document (404-shaped)", async () => {
    await expect(mk().signedUrl(doc.id, staff([storeB]), 60)).rejects.toMatchObject({ code: "not_found" });
    await expect(mk().signedUrl(randomUUID(), staff([storeA]), 60)).rejects.toMatchObject({ code: "not_found" });
  });
  it("role without access is forbidden; shoppers cannot sign", async () => {
    await expect(mk().signedUrl(doc.id, staff([storeA], ["support"]), 60)).rejects.toMatchObject({ code: "forbidden" });
    const shopper: Principal = { kind: "shopper", userId: randomUUID(), marketId: "EG", roles: [], scopes: [] };
    await expect(mk().signedUrl(doc.id, shopper, 60)).rejects.toBeInstanceOf(MediaError);
  });
  it("admin needs a reason code for documents", async () => {
    await expect(mk().signedUrl(doc.id, admin(), 60, { storeId: storeA })).rejects.toMatchObject({ code: "reason_required" });
    const r = await mk().signedUrl(doc.id, admin(), 60, { storeId: storeA, reasonCode: "kyc_review" });
    expect(r.url).toContain("sig=");
  });
  it("platform assets are signable only by the system scope", async () => {
    const pa = await mk().ingest({ bytes: pdf, declaredMime: "application/pdf", kind: "document", actor: platform });
    await expect(mk().signedUrl(pa.id, staff([storeA]), 60)).rejects.toMatchObject({ code: "not_found" });
    await expect(mk().signedUrl(pa.id, platform, 60)).resolves.toBeDefined();
  });
  it("pending or rejected assets are not signable", async () => {
    const r = await mk(new FakeAvScanner({ clean: false })).ingest({ bytes: pdf, declaredMime: "application/pdf", kind: "document", actor: staff([storeA]), storeId: storeA });
    await expect(mk().signedUrl(r.id, staff([storeA]), 60)).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("srcset / public URLs", () => {
  it("builds picture data with dimensions and refuses documents", async () => {
    const a = await mk().ingest({ bytes: photo, declaredMime: "image/jpeg", kind: "product", actor: staff([storeA]), storeId: storeA });
    const p = srcset(a, { sizes: "(min-width: 800px) 640px, 100vw", cdnBase: "https://cdn.example/" });
    expect(p.sources.map((s) => s.type)).toEqual(["image/avif", "image/webp"]);
    expect(p.sources[0]?.srcset).toContain("avif-320.avif 320w");
    expect(p.img.width).toBe(1280);
    expect(p.img.height).toBe(960);
    expect(p.img.src).toBe(`https://cdn.example/${a.variants.find((v) => v.format === "jpeg" && v.width === 1280)?.key ?? ""}`);
    const d = await mk().ingest({ bytes: pdf, declaredMime: "application/pdf", kind: "document", actor: staff([storeA]), storeId: storeA });
    expect(() => publicVariantUrl(d, a.variants[0]!, "https://cdn")).toThrow(MediaError);
    expect(() => publicVariantUrl(a, { ...a.variants[0]!, key: "other" }, "https://cdn")).toThrow(MediaError);
  });
});

describe("platform assets under the named worker policy (ADR-0011)", () => {
  it("only the media.platform worker context reaches store_id NULL rows; other roles, jobs and stores do not", async () => {
    const pa = await mk().ingest({ bytes: await small(400), declaredMime: "image/png", kind: "brand_logo", actor: platform });
    const { contextClient } = await import("@outlet/db");
    const count = async (c: SqlClient) => Number((await c.query<{ n: string }>("SELECT count(*)::text n FROM media_assets WHERE id = $1", [pa.id])).rows[0]?.n);
    const w = roleClient(raw, "outlet_worker");
    expect(await count(contextClient(w, { kind: "worker", marketId: "EG", job: "media.platform" }))).toBe(1);
    expect(await count(contextClient(w, { kind: "worker", marketId: "EG", job: "auth.purge" }))).toBe(0);
    expect(await count(contextClient(w, { kind: "worker", marketId: "FR", job: "media.platform" }))).toBe(0);
    expect(await count(contextClient(roleClient(raw, "outlet_app"), { kind: "store", marketId: "EG", storeId: storeA }))).toBe(0);
    // the worker policy never matches a store-owned row
    const own = await mk().ingest({ bytes: await small(400), declaredMime: "image/png", kind: "product", actor: staff([storeA]), storeId: storeA });
    const other = await contextClient(w, { kind: "worker", marketId: "EG", job: "media.platform" }).query("SELECT 1 FROM media_assets WHERE id = $1", [own.id]);
    expect(other.rows).toHaveLength(0);
    await expect(contextClient(w, { kind: "worker", marketId: "EG", job: "media.platform" }).query("UPDATE media_assets SET rejected_reason = 'x' WHERE id = $1 RETURNING id", [own.id]).then((r) => r.rows)).resolves.toHaveLength(0);
  });
  it("signedUrl looks up through the caller's store context (an admin without a store gets not_found)", async () => {
    const doc = await mk().ingest({ bytes: pdf, declaredMime: "application/pdf", kind: "document", actor: staff([storeA]), storeId: storeA });
    await expect(mk().signedUrl(doc.id, admin(), 60, { reasonCode: "kyc_review" })).rejects.toMatchObject({ code: "not_found" });
    await expect(mk().signedUrl(doc.id, admin(), 60, { storeId: storeB, reasonCode: "kyc_review" })).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("quarantine and promotion", () => {
  it("renditions are written under quarantine/ and only public/ keys remain once ready", async () => {
    const seen: string[] = [];
    const st = new InMemoryStorage();
    const put = st.put.bind(st);
    st.put = (k, b, c) => (seen.push(k), put(k, b, c));
    const a = await mk(new FakeAvScanner(), st).ingest({ bytes: await small(700), declaredMime: "image/png", kind: "product", actor: staff([storeA]), storeId: storeA });
    expect(seen.some((k) => k.startsWith("quarantine/"))).toBe(true);
    expect(a.variants.every((v) => st.objects.has(v.key) && v.key.startsWith("public/"))).toBe(true);
    expect([...st.objects.keys()].some((k) => k.startsWith("quarantine/"))).toBe(false);
  });
  it("an infected upload is scanned before decode: nothing is stored, nothing is public", async () => {
    const st = new InMemoryStorage();
    let decodedBeforeScan = false;
    const scanner: AvScanPort = { scan: () => { decodedBeforeScan = st.objects.size > 0; return Promise.resolve({ clean: false, signature: "EICAR" }); } };
    const a = await mk(scanner, st).ingest({ bytes: photo, declaredMime: "image/jpeg", kind: "product", actor: staff([storeA]), storeId: storeA });
    expect(a.status).toBe("rejected");
    expect(decodedBeforeScan).toBe(false);
    expect(st.objects.size).toBe(0);
  });
  it("a failure after the objects were written deletes every written key", async () => {
    const st = new InMemoryStorage();
    const svc = new MediaService({ app: roleClient(raw, "outlet_app"), worker: roleClient(raw, "outlet_worker"), storage: st, scanner: new FakeAvScanner(), signer, marketId: "EG", now: () => (st.objects.size > 0 ? new Date("not-a-date") : now) });
    await expect(svc.ingest({ bytes: await small(700), declaredMime: "image/png", kind: "product", actor: staff([storeA]), storeId: storeA })).rejects.toBeDefined();
    expect(st.objects.size).toBe(0);
  });
});

describe("document views are audited", () => {
  it("emits media.document_viewed with actor, asset and reason code but no content", async () => {
    const doc = await mk().ingest({ bytes: pdf, declaredMime: "application/pdf", kind: "document", actor: staff([storeA]), storeId: storeA });
    const adm = admin();
    await mk().signedUrl(doc.id, adm, 60, { storeId: storeA, reasonCode: "kyc_review" });
    await expect(mk().signedUrl(doc.id, admin(), 60, { storeId: storeA })).rejects.toMatchObject({ code: "reason_required" });
    const ev = await raw.query<{ payload: Record<string, unknown> }>("SELECT payload FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'media.document_viewed'", [doc.id]);
    expect(ev.rows).toHaveLength(1); // the denied attempt left nothing behind
    expect(ev.rows[0]?.payload).toMatchObject({ assetId: doc.id, actorId: adm.userId, actorKind: "admin", reasonCode: "kyc_review" });
    expect(JSON.stringify(ev.rows[0]?.payload)).not.toMatch(/%PDF|sig=|exp=/);
  });
  it("platform document views are recorded under the worker context", async () => {
    const pa = await mk().ingest({ bytes: pdf, declaredMime: "application/pdf", kind: "document", actor: platform });
    await mk().signedUrl(pa.id, platform, 60);
    const ev = await raw.query("SELECT 1 FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'media.document_viewed'", [pa.id]);
    expect(ev.rows).toHaveLength(1);
  });
});

describe("purgeStalePending", () => {
  it("deletes storage objects of stale pending rows (store and platform) and marks them rejected; fresh ones stay", async () => {
    const st = new InMemoryStorage();
    const stuck = new NoopAvScanner({});
    const a = mk(stuck, st);
    await expect(a.ingest({ bytes: await small(400), declaredMime: "image/png", kind: "product", actor: staff([storeA]), storeId: storeA })).rejects.toMatchObject({ code: "av_unavailable" });
    await expect(a.ingest({ bytes: await small(400), declaredMime: "image/png", kind: "brand_logo", actor: platform })).rejects.toMatchObject({ code: "av_unavailable" });
    // simulate a crash that left objects behind for a stale row
    const row = await raw.query<{ id: string; storage_key: string }>("SELECT id, storage_key FROM media_assets WHERE status = 'pending_scan' ORDER BY created_at DESC LIMIT 1");
    await st.put(row.rows[0]?.storage_key ?? "", new Uint8Array([1]), "image/jpeg");
    await raw.query("INSERT INTO catalog_public_stores (id, market_id, slug, display_name_ar, kind, status, verified_badge, ships_from_country, followers_count, discount_display_mode, legal_identity, updated_at) VALUES ($1,'EG',$2,'أ','local','ACTIVE',false,'EG',0,'verified_only','{}'::jsonb, now()) ON CONFLICT DO NOTHING", [storeA, `s-${storeA}`]);
    const later = new Date(now.getTime() + 3_600_000);
    expect(await a.purgeStalePending(later, 60_000)).toBeGreaterThanOrEqual(1);
    expect(st.objects.size).toBe(0);
    const left = await raw.query<{ n: string }>("SELECT count(*)::text n FROM media_assets WHERE status = 'pending_scan' AND created_at <= $1", [new Date(later.getTime() - 60_000)]);
    expect(left.rows[0]?.n).toBe("0");
    const rej = await raw.query<{ rejected_reason: string }>("SELECT rejected_reason FROM media_assets WHERE id = $1", [row.rows[0]?.id]);
    expect(rej.rows[0]?.rejected_reason).toBe("stale_pending");
    expect(await a.purgeStalePending(now, 1_000_000_000)).toBe(0);
  });
});
