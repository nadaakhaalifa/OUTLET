import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeProductMediaBlobs, InMemoryProductMediaStore, ProductImageLinker, type ProductMediaJob } from "../../product-media";
import { SEED } from "../adapters/in-memory";
import { PRINCIPALS, STORE_A, STORE_B, bearer, createCatalogHarness, idemKey, type CatalogHarness } from "./harness";

const JOB = (n: number): string => `0192f3a4-5b6c-7d8e-9f01-0000000d${String(n).padStart(4, "0")}`;
const UP_IMG = "0192f3a4-5b6c-7d8e-9f01-0000000a0001";

let h: CatalogHarness;
let store: InMemoryProductMediaStore;
let blobs: FakeProductMediaBlobs;

beforeAll(async () => {
  store = new InMemoryProductMediaStore();
  blobs = new FakeProductMediaBlobs();
  h = await createCatalogHarness(undefined, new ProductImageLinker(store, blobs));
});
afterAll(async () => h.close());
beforeEach(() => {
  h.fixtures.uploads.add(STORE_A, UP_IMG);
});

/** Seeds a READY job with private original + derivatives owned by the store. */
async function seedJob(n: number, o: { storeId?: string; decision?: ProductMediaJob["decision"] } = {}): Promise<string> {
  const storeId = o.storeId ?? STORE_A;
  const up = await blobs.issueUpload({ storeId, contentType: "image/jpeg", sizeBytes: 10 });
  blobs.put(up.uploadId, new Uint8Array([0xff, 0xd8, 1, 2, 3]));
  const png = await blobs.writeDerivative({ storeId, kind: "png", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) });
  const jpg = await blobs.writeDerivative({ storeId, kind: "jpg", bytes: new Uint8Array([0xff, 0xd8, 9]) });
  await store.insertJob({
    id: JOB(n),
    storeId,
    createdBy: PRINCIPALS.ownerA.actor.id,
    originalRef: up.uploadId,
    contentType: "image/jpeg",
    sizeBytes: 10,
    status: "READY",
    decision: o.decision ?? "accepted",
    requestedModel: null,
    modelId: "u2netp",
    modelVersion: "1",
    qualityScore: 90,
    qualityReasons: [],
    pngRef: png,
    whiteJpgRef: jpg,
    shadowRef: null,
    latencyMs: 5,
    errorCode: null,
    attempts: 1,
    attachedProductId: null,
    promotedImageRef: null,
    promotedCutoutRef: null,
    currentVersion: 0,
    editCount: 0,
    promotedVersion: 0,
    backgroundRenderRef: null,
    version: 2,
    createdAtMs: 1,
    updatedAtMs: 1,
  });
  return JOB(n);
}

const body = (images: unknown, over: Record<string, unknown> = {}) => ({
  title: { ar: "فستان كتان أبيض", en: "White linen dress" },
  description: { ar: "فستان صيفي خفيف" },
  category_id: SEED.categoryDresses,
  condition: "new_with_tags",
  images,
  skus: [{ size_label: "M", price: { amount: "129900", currency: "EGP" }, initial_stock: 4 }],
  ...over,
});
const post = (p: typeof PRINCIPALS.ownerA, b: object) => h.http().post("/v1/seller/products").set(bearer(p)).set("Idempotency-Key", idemKey()).send(b);

async function patch(p: typeof PRINCIPALS.ownerA, id: string, b: object) {
  const etag = (await h.http().get(`/v1/seller/products/${id}`).set(bearer(p))).headers.etag as string;
  return h.http().patch(`/v1/seller/products/${id}`).set(bearer(p)).set("If-Match", etag).send(b);
}

describe("product image from a background-removal job", () => {
  it("attaches an accepted cutout: promoted keys, job marked attached, public image_url + cutout_url", async () => {
    const job = await seedJob(1);
    const r = await post(PRINCIPALS.ownerA, body([{ media_job_id: job }]));
    expect(r.status).toBe(201);
    expect(r.body.image_media_job_ids).toEqual([job]);
    expect(r.body.image_upload_ids).toEqual([job]);
    expect((await store.getJob(job))?.attachedProductId).toBe(r.body.id);

    const j = await store.getJob(job);
    expect(j?.promotedImageRef).toMatch(/^catalog\//);
    expect(j?.promotedCutoutRef).toMatch(/^catalog\//);
    // The promoted copies are copies of the derivatives, not the private keys themselves.
    expect(j?.promotedImageRef).not.toBe(j?.whiteJpgRef);

    const put = await patch(PRINCIPALS.ownerA, r.body.id, { status: "active" });
    expect(put.status).toBe(200);
    const pub = await h.http().get(`/v1/public/products/${r.body.id}`);
    expect(pub.status).toBe(200);
    expect(pub.body.image_url).toContain(j?.promotedImageRef);
    expect(pub.body.cutout_url).toContain(j?.promotedCutoutRef);
    expect(pub.body.images[0].cutout_url).toBe(pub.body.cutout_url);
    // No private job key or derivative key is ever serialized.
    const text = JSON.stringify(pub.body);
    for (const k of [j?.originalRef, j?.pngRef, j?.whiteJpgRef]) expect(text).not.toContain(k as string);
    expect(text).not.toMatch(/product-media/);
    expect(text).not.toContain(job);
  });

  it("use_original keeps the original: image_url only, no cutout_url", async () => {
    const job = await seedJob(2, { decision: "use_original" });
    const r = await post(PRINCIPALS.ownerA, body([{ media_job_id: job }]));
    expect(r.status).toBe(201);
    expect((await patch(PRINCIPALS.ownerA, r.body.id, { status: "active" })).status).toBe(200);
    const pub = await h.http().get(`/v1/public/products/${r.body.id}`);
    expect(pub.body.image_url).toBeTypeOf("string");
    expect(pub.body.cutout_url).toBeUndefined();
    expect(JSON.stringify(pub.body)).not.toMatch(/product-media/);
  });

  it("another store's job is a 404 and nothing is created or attached", async () => {
    const foreign = await seedJob(3, { storeId: STORE_B });
    const count = h.fixtures.products.countForTest();
    const r = await post(PRINCIPALS.ownerA, body([{ media_job_id: foreign }]));
    expect(r.status).toBe(404);
    expect(h.fixtures.products.countForTest()).toBe(count);
    expect((await store.getJob(foreign))?.attachedProductId).toBeNull();
    expect((await post(PRINCIPALS.ownerA, body([{ media_job_id: JOB(999) }]))).status).toBe(404);
  });

  it("refuses a job without a decision (422) and a job already on another product (409)", async () => {
    const undecided = await seedJob(4, { decision: "none" });
    const r1 = await post(PRINCIPALS.ownerA, body([{ media_job_id: undecided }]));
    expect(r1.status).toBe(422);
    expect(r1.body.errors).toEqual([{ pointer: "/images/0/media_job_id", code: "media_job_not_decided" }]);

    const job = await seedJob(5);
    expect((await post(PRINCIPALS.ownerA, body([{ media_job_id: job }]))).status).toBe(201);
    const r2 = await post(PRINCIPALS.ownerA, body([{ media_job_id: job }]));
    expect(r2.status).toBe(409);
    expect(r2.body.code).toBe("media_job_attached_elsewhere");
  });

  it("concurrent creates: exactly one product wins the job", async () => {
    const job = await seedJob(6);
    const rs = await Promise.all([1, 2, 3, 4].map(() => post(PRINCIPALS.ownerA, body([{ media_job_id: job }]))));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(3);
  });

  it("update is idempotent for the same product and frees a dropped job", async () => {
    const job = await seedJob(7);
    const r = await post(PRINCIPALS.ownerA, body([{ upload_id: UP_IMG }, { media_job_id: job }]));
    expect(r.status).toBe(201);
    const again = await patch(PRINCIPALS.ownerA, r.body.id, { images: [{ upload_id: UP_IMG }, { media_job_id: job }] });
    expect(again.status).toBe(200);
    expect(again.body.image_media_job_ids).toEqual([job]);
    const afterPromote = (await store.getJob(job))?.promotedImageRef;
    // A title-only update keeps the variants.
    const t = await patch(PRINCIPALS.ownerA, r.body.id, { title: { ar: "فستان كتان", en: "Linen dress" } });
    expect(t.body.image_media_job_ids).toEqual([job]);
    expect((await store.getJob(job))?.promotedImageRef).toBe(afterPromote);
    // Dropping the job frees it for another product.
    const drop = await patch(PRINCIPALS.ownerA, r.body.id, { images: [{ upload_id: UP_IMG }] });
    expect(drop.status).toBe(200);
    expect(drop.body.image_media_job_ids).toEqual([]);
    expect((await store.getJob(job))?.attachedProductId).toBeNull();
    expect((await post(PRINCIPALS.ownerA, body([{ media_job_id: job }]))).status).toBe(201);
  });

  it("validates the body: image_upload_ids and images are exclusive, entries need exactly one id", async () => {
    const job = await seedJob(8);
    const both = await post(PRINCIPALS.ownerA, body([{ media_job_id: job, upload_id: UP_IMG }]));
    expect(both.status).toBe(400);
    const empty = await post(PRINCIPALS.ownerA, body([{}]));
    expect(empty.status).toBe(400);
    const p = await post(PRINCIPALS.ownerA, body([{ upload_id: UP_IMG }]));
    const mixed = await patch(PRINCIPALS.ownerA, p.body.id, { images: [{ upload_id: UP_IMG }], image_upload_ids: [UP_IMG] });
    expect(mixed.status).toBe(400);
  });

  it("a foreign seller cannot attach a job of store A to their product (404)", async () => {
    const job = await seedJob(9);
    const r = await post(PRINCIPALS.ownerB, body([{ media_job_id: job }]));
    expect(r.status).toBe(404);
    expect((await store.getJob(job))?.attachedProductId).toBeNull();
  });
});
