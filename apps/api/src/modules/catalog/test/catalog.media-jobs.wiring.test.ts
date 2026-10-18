import "reflect-metadata";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { configureApp } from "../../../app.setup";
import { loadConfig } from "../../../config/env";
import { PlatformModule, createIdGenerator, nodeCsprng } from "../../../platform";
import {
  type FakeProductMediaBlobs,
  type InMemoryProductMediaStore,
  PRODUCT_MEDIA_BLOBS,
  PRODUCT_MEDIA_STORE,
  ProductMediaModule,
} from "../../product-media";
import { SEED, createCatalogDevFixtures } from "../adapters/in-memory";
import { CatalogModule } from "../catalog.module";
import { PRINCIPALS, STORE_A, TestAuthModule, TestClock, bearer, idemKey } from "./harness";

const JOB = "0192f3a4-5b6c-7d8e-9f01-0000000d0001";

/** The real ProductMediaModule (global) satisfies the catalog's optional "catalog.ImageJobs" dependency. */
describe("catalog + product-media composition", () => {
  let close: () => Promise<void>;
  let http: () => ReturnType<typeof request>;
  let store: InMemoryProductMediaStore;
  let blobs: FakeProductMediaBlobs;
  beforeAll(async () => {
    const config = loadConfig({ NODE_ENV: "test" });
    const clock = new TestClock();
    const ids = createIdGenerator(clock, nodeCsprng);
    const fixtures = createCatalogDevFixtures();
    const ref = await Test.createTestingModule({
      imports: [
        PlatformModule.forRoot(config, { clock, ids }),
        TestAuthModule.register(),
        ProductMediaModule.forRoot(config),
        CatalogModule.forRoot(config, fixtures),
      ],
    }).compile();
    const app = ref.createNestApplication({ logger: false });
    configureApp(app, config);
    await app.init();
    store = ref.get(PRODUCT_MEDIA_STORE, { strict: false });
    blobs = ref.get(PRODUCT_MEDIA_BLOBS, { strict: false });
    fixtures.stores.set({
      id: STORE_A,
      slug: "store-a",
      nameAr: "متجر أ",
      kind: "local",
      verifiedBadge: false,
      liveDrop: false,
      isFavorite: false,
      visible: true,
      legal: { legalName: "Legal a", commercialRegisterNo: "CR-1", taxCardNo: "TC-1", governorate: "Cairo", approved: true },
    });
    http = () => request(app.getHttpServer());
    close = () => app.close();
  }, 30_000);
  afterAll(async () => close());

  it("attaches a job through the module-bound port", async () => {
    const up = await blobs.issueUpload({ storeId: STORE_A, contentType: "image/jpeg", sizeBytes: 10 });
    blobs.put(up.uploadId, new Uint8Array([0xff, 0xd8, 1]));
    await store.insertJob({
      id: JOB,
      storeId: STORE_A,
      createdBy: PRINCIPALS.ownerA.actor.id,
      originalRef: up.uploadId,
      contentType: "image/jpeg",
      sizeBytes: 10,
      status: "READY",
      decision: "use_original",
      requestedModel: null,
      modelId: null,
      modelVersion: null,
      qualityScore: 80,
      qualityReasons: [],
      pngRef: await blobs.writeDerivative({ storeId: STORE_A, kind: "png", bytes: new Uint8Array([1]) }),
      whiteJpgRef: await blobs.writeDerivative({ storeId: STORE_A, kind: "jpg", bytes: new Uint8Array([2]) }),
      shadowRef: null,
      latencyMs: 1,
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
    const r = await http()
      .post("/v1/seller/products")
      .set(bearer(PRINCIPALS.ownerA))
      .set("Idempotency-Key", idemKey())
      .send({
        title: { ar: "فستان كتان أبيض" },
        category_id: SEED.categoryDresses,
        condition: "new_with_tags",
        images: [{ media_job_id: JOB }],
        skus: [{ size_label: "M", price: { amount: "129900", currency: "EGP" } }],
      });
    expect(r.status).toBe(201);
    expect(r.body.image_media_job_ids).toEqual([JOB]);
    expect((await store.getJob(JOB))?.attachedProductId).toBe(r.body.id);
  });
});
