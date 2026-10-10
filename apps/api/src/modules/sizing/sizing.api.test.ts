import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  BRAND_X,
  BRAND_Y,
  IDEM_1,
  IDEM_2,
  IDEM_3,
  PRODUCT_1,
  PRODUCT_2,
  PRODUCT_NO_CHART,
  STORE_A,
  STORE_B,
  TOKENS,
  TOPS_ROWS,
  USER_A,
  USER_B,
  auth,
  createSizingHarness,
  type SizingHarness,
} from "./test/harness";

let h: SizingHarness;

beforeAll(async () => {
  h = await createSizingHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  for (const r of h.profiles.rawRecords()) await h.profiles.delete(r.userId, r.id);
});

const BODY = { bust_cm: 86, waist_cm: 68 };

async function makeProfile(token: string, over: Record<string, unknown> = {}): Promise<string> {
  const r = await h
    .http()
    .post("/v1/me/size-profiles")
    .set(auth(token))
    .send({ label: "Me", kind: "me", measurements: BODY, ...over });
  if (r.status !== 201) throw new Error(`profile create failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.id as string;
}

async function publishChart(token = TOKENS.sellerOwnerA): Promise<void> {
  const r = await h.http().post("/v1/seller/size-charts").set(auth(token)).send({ product_type: "tops", unit: "cm", rows: TOPS_ROWS });
  expect(r.status).toBe(201);
  expect(r.body.validated).toBe(true);
}

describe("size profiles", () => {
  beforeEach(() => {
    h.consent.grant(USER_A);
    h.consent.grant(USER_B);
  });

  it("creates a profile, encrypts P3 fields at rest and returns them to the owner only", async () => {
    const r = await h
      .http()
      .post("/v1/me/size-profiles")
      .set(auth(TOKENS.buyerA))
      .send({ label: "Nada", kind: "me", fit_preference: "snug", modest_fit: true, measurements: { waist_cm: 71.5, height_cm: 168 } });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ label: "Nada", kind: "me", fit_preference: "snug", modest_fit: true });
    expect(r.body.measurements).toEqual({ waist_cm: 71.5, height_cm: 168 });
    const stored = h.profiles.rawRecords().find((x) => x.id === r.body.id);
    expect(stored).toBeDefined();
    const bytes = Buffer.from(stored?.measurementsEnc ?? new Uint8Array()).toString("utf8");
    expect(bytes).not.toContain("waist");
    expect(bytes).not.toContain("71.5");
    expect(Buffer.from(stored?.labelEnc ?? new Uint8Array()).toString("utf8")).not.toContain("Nada");
    expect(JSON.stringify(h.events.events)).not.toContain("71.5");
  });

  it("requires the measurements consent for measurements and usual size, not for a bare profile", async () => {
    h.consent.withdraw(USER_A);
    const bare = await h.http().post("/v1/me/size-profiles").set(auth(TOKENS.buyerA)).send({ label: "Bare", kind: "me" });
    expect(bare.status).toBe(201);
    const withM = await h
      .http()
      .post("/v1/me/size-profiles")
      .set(auth(TOKENS.buyerA))
      .send({ label: "M", kind: "me", measurements: BODY });
    expect(withM.status).toBe(422);
    expect(withM.body.code).toBe("measurements_consent_required");
    const usual = await h
      .http()
      .post("/v1/me/size-profiles")
      .set(auth(TOKENS.buyerA))
      .send({ label: "U", kind: "me", usual_size: { size_label: "M" } });
    expect(usual.status).toBe(422);
    h.consent.grant(USER_A);
  });

  it("rejects impossible measurements with a pointer and does not store anything", async () => {
    const before = h.profiles.rawRecords().length;
    const r = await h
      .http()
      .post("/v1/me/size-profiles")
      .set(auth(TOKENS.buyerA))
      .send({ label: "X", kind: "me", measurements: { waist_cm: 300 } });
    expect(r.status).toBe(400);
    expect(r.body.errors).toContainEqual({ pointer: "/body/measurements/waist_cm", code: "out_of_range" });
    expect(h.profiles.rawRecords().length).toBe(before);
  });

  it("rejects labels with control characters", async () => {
    const r = await h.http().post("/v1/me/size-profiles").set(auth(TOKENS.buyerA)).send({ label: "bad\nlabel", kind: "me" });
    expect(r.status).toBe(400);
    expect(r.body.errors).toContainEqual({ pointer: "/body/label", code: "invalid_label" });
    const blank = await h.http().post("/v1/me/size-profiles").set(auth(TOKENS.buyerA)).send({ label: "   ", kind: "me" });
    expect(blank.status).toBe(400);
  });

  it("children hold only measurements and a nickname: date of birth or photo is a 400", async () => {
    for (const extra of [{ date_of_birth: "2018-01-01" }, { photo_url: "https://x.invalid/a.jpg" }, { dob: "2018-01-01" }]) {
      const r = await h
        .http()
        .post("/v1/me/size-profiles")
        .set(auth(TOKENS.buyerA))
        .send({ label: "Kid", kind: "child", measurements: { height_cm: 110 }, ...extra });
      expect(r.status).toBe(400);
    }
    const ok = await h
      .http()
      .post("/v1/me/size-profiles")
      .set(auth(TOKENS.buyerA))
      .send({ label: "Kid", kind: "child", measurements: { height_cm: 110 } });
    expect(ok.status).toBe(201);
    expect(ok.body.kind).toBe("child");
  });

  it("allows at most 6 profiles per user", async () => {
    const created: string[] = [];
    let last = 201;
    for (let i = 0; i < 8; i += 1) {
      const r = await h.http().post("/v1/me/size-profiles").set(auth(TOKENS.buyerB)).send({ label: `P${i}`, kind: "partner" });
      last = r.status;
      if (r.status === 201) created.push(r.body.id as string);
    }
    expect(last).toBe(422);
    expect(created.length).toBeLessThanOrEqual(6);
    const list = await h.http().get("/v1/me/size-profiles?limit=50").set(auth(TOKENS.buyerB));
    expect(list.body.items.length).toBe(6);
    for (const id of created) await h.http().delete(`/v1/me/size-profiles/${id}`).set(auth(TOKENS.buyerB));
  });

  it("lists with cursor pagination, owner scoped", async () => {
    const a = await makeProfile(TOKENS.buyerA, { label: "L1" });
    const b = await makeProfile(TOKENS.buyerB, { label: "other" });
    const page = await h.http().get("/v1/me/size-profiles?limit=1").set(auth(TOKENS.buyerA));
    expect(page.status).toBe(200);
    expect(page.body.items.length).toBe(1);
    const all = await h.http().get("/v1/me/size-profiles?limit=50").set(auth(TOKENS.buyerA));
    expect(all.body.items.some((x: { id: string }) => x.id === b)).toBe(false);
    expect(all.body.items.some((x: { id: string }) => x.id === a)).toBe(true);
    if (page.body.page.has_more) {
      const next = await h.http().get(`/v1/me/size-profiles?limit=1&cursor=${page.body.page.next_cursor}`).set(auth(TOKENS.buyerA));
      expect(next.status).toBe(200);
      expect(next.body.items[0].id).not.toBe(page.body.items[0].id);
    }
    const bad = await h.http().get("/v1/me/size-profiles?cursor=AAAA").set(auth(TOKENS.buyerA));
    expect(bad.status).toBe(400);
    await h.http().delete(`/v1/me/size-profiles/${a}`).set(auth(TOKENS.buyerA));
    await h.http().delete(`/v1/me/size-profiles/${b}`).set(auth(TOKENS.buyerB));
  });

  it("supports ETag, If-Match updates, 428 and 412", async () => {
    const id = await makeProfile(TOKENS.buyerA, { label: "Etag" });
    const got = await h.http().get(`/v1/me/size-profiles/${id}`).set(auth(TOKENS.buyerA));
    expect(got.status).toBe(200);
    const etag = got.headers["etag"] as string;
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    const cached = await h.http().get(`/v1/me/size-profiles/${id}`).set(auth(TOKENS.buyerA)).set("If-None-Match", etag);
    expect(cached.status).toBe(304);

    const noMatch = await h.http().patch(`/v1/me/size-profiles/${id}`).set(auth(TOKENS.buyerA)).send({ modest_fit: true });
    expect(noMatch.status).toBe(428);
    const stale = await h
      .http()
      .patch(`/v1/me/size-profiles/${id}`)
      .set(auth(TOKENS.buyerA))
      .set("If-Match", '"00000000000000000000000000000000"')
      .send({ modest_fit: true });
    expect(stale.status).toBe(412);
    const ok = await h
      .http()
      .patch(`/v1/me/size-profiles/${id}`)
      .set(auth(TOKENS.buyerA))
      .set("If-Match", etag)
      .send({ modest_fit: true, measurements: { bust_cm: 88, waist_cm: 70 } });
    expect(ok.status).toBe(200);
    expect(ok.body.modest_fit).toBe(true);
    expect(ok.body.measurements).toEqual({ bust_cm: 88, waist_cm: 70 });
    // the old etag no longer matches
    const again = await h
      .http()
      .patch(`/v1/me/size-profiles/${id}`)
      .set(auth(TOKENS.buyerA))
      .set("If-Match", etag)
      .send({ label: "Again" });
    expect(again.status).toBe(412);
    const empty = await h.http().patch(`/v1/me/size-profiles/${id}`).set(auth(TOKENS.buyerA)).set("If-Match", "*").send({});
    expect(empty.status).toBe(400);
  });

  it("deletes a profile and then reports 404", async () => {
    const id = await makeProfile(TOKENS.buyerA, { label: "Del" });
    const del = await h.http().delete(`/v1/me/size-profiles/${id}`).set(auth(TOKENS.buyerA));
    expect(del.status).toBe(204);
    expect((await h.http().get(`/v1/me/size-profiles/${id}`).set(auth(TOKENS.buyerA))).status).toBe(404);
    expect((await h.http().delete(`/v1/me/size-profiles/${id}`).set(auth(TOKENS.buyerA))).status).toBe(404);
    expect(h.profiles.rawRecords().some((x) => x.id === id)).toBe(false);
  });

  it("fails closed with 503 when the cipher is down and stores nothing", async () => {
    const before = h.profiles.rawRecords().length;
    h.cipher.setFailing(true);
    try {
      const r = await h.http().post("/v1/me/size-profiles").set(auth(TOKENS.buyerA)).send({ label: "Down", kind: "me", measurements: BODY });
      expect(r.status).toBe(503);
      expect(h.profiles.rawRecords().length).toBe(before);
    } finally {
      h.cipher.setFailing(false);
    }
  });
});

describe("seller size charts", () => {
  it("saves a valid chart, normalises inches, and saves a failing chart as a draft", async () => {
    const inches = await h
      .http()
      .post("/v1/seller/size-charts")
      .set(auth(TOKENS.sellerCatalogA))
      .send({
        product_type: "tops",
        unit: "in",
        rows: [
          { size_label: "S", measurements: { bust_cm: 34, waist_cm: 26 } },
          { size_label: "M", measurements: { bust_cm: 36, waist_cm: 28 } },
        ],
      });
    expect(inches.status).toBe(201);
    expect(inches.body.validated).toBe(true);
    expect(inches.body.unit).toBe("cm");
    expect(inches.body.rows[0].measurements).toEqual({ bust_cm: 86.4, waist_cm: 66 });

    const draft = await h
      .http()
      .post("/v1/seller/size-charts")
      .set(auth(TOKENS.sellerOwnerA))
      .send({
        product_type: "dresses",
        unit: "cm",
        rows: [
          { size_label: "S", measurements: { bust_cm: 90, waist_cm: 70, hip_cm: 96 } },
          { size_label: "M", measurements: { bust_cm: 86, waist_cm: 74, hip_cm: 100 } },
        ],
      });
    expect(draft.status).toBe(201);
    expect(draft.body.validated).toBe(false);
    expect(draft.body.validation_errors).toContainEqual({ size_label: "M", code: "not_monotonic" });
  });

  it("is tenant scoped: store B never sees store A charts", async () => {
    await publishChart(TOKENS.sellerOwnerA);
    const a = await h.http().get("/v1/seller/size-charts?limit=50").set(auth(TOKENS.sellerOwnerA));
    expect(a.status).toBe(200);
    expect(a.body.items.length).toBeGreaterThan(0);
    const b = await h.http().get("/v1/seller/size-charts").set(auth(TOKENS.sellerOwnerB));
    expect(b.status).toBe(200);
    expect(b.body.items).toEqual([]);
  });

  it("rejects script in labels and unknown measurement keys", async () => {
    const r = await h
      .http()
      .post("/v1/seller/size-charts")
      .set(auth(TOKENS.sellerOwnerA))
      .send({ product_type: "tops", unit: "cm", rows: [{ size_label: "<script>", measurements: { bust_cm: 86, waist_cm: 68 } }] });
    expect(r.status).toBe(400);
    const r2 = await h
      .http()
      .post("/v1/seller/size-charts")
      .set(auth(TOKENS.sellerOwnerA))
      .send({ product_type: "tops", unit: "cm", rows: [{ size_label: "S", measurements: { bust_cm: 86, shoe_size: 40 } }] });
    expect(r2.status).toBe(400);
  });

  it("support staff can read but not create (403)", async () => {
    const read = await h.http().get("/v1/seller/size-charts").set(auth(TOKENS.sellerSupportA));
    expect(read.status).toBe(200);
    const write = await h
      .http()
      .post("/v1/seller/size-charts")
      .set(auth(TOKENS.sellerSupportA))
      .send({ product_type: "tops", unit: "cm", rows: TOPS_ROWS });
    expect(write.status).toBe(403);
  });
});

describe("fit recommendation", () => {
  beforeAll(() => {
    h.catalog.seed({ productId: PRODUCT_1, storeId: STORE_A, brandId: BRAND_X, productType: "tops", stretch: "none" });
    h.catalog.seed({ productId: PRODUCT_2, storeId: STORE_A, brandId: BRAND_X, productType: "tops", stretch: "none" });
    h.catalog.seed({ productId: PRODUCT_NO_CHART, storeId: STORE_B, brandId: BRAND_Y, productType: "tops", stretch: "none" });
  });
  beforeEach(() => {
    h.consent.grant(USER_A);
    h.consent.grant(USER_B);
  });

  it("returns 404 fit_unavailable when the store has no validated chart", async () => {
    const id = await makeProfile(TOKENS.buyerA);
    const r = await h.http().get(`/v1/fit/recommend?sku_group=${PRODUCT_NO_CHART}&profile_id=${id}`).set(auth(TOKENS.buyerA));
    expect(r.status).toBe(404);
    expect(r.body.code).toBe("fit_unavailable");
  });

  it("recommends from a validated chart with Arabic first explanations", async () => {
    await publishChart();
    const id = await makeProfile(TOKENS.buyerA);
    const r = await h.http().get(`/v1/fit/recommend?sku_group=${PRODUCT_2}&profile_id=${id}`).set(auth(TOKENS.buyerA));
    expect(r.status).toBe(200);
    expect(r.body.size).toBe("M");
    expect(r.body.confidence).toBeGreaterThanOrEqual(0.6);
    expect(r.body.confidence).toBeLessThanOrEqual(1);
    expect(r.body.explanation[0].ar.length).toBeGreaterThan(0);
    expect(r.body.explanation[0].en).toContain("M");
    expect(r.body.alternatives.map((a: { size: string }) => a.size)).toEqual(["S", "L"]);
    expect(r.body.community_fit).toBeNull();
    expect(r.body.model).toBe("fit-v1");
    // same answer on the product route
    const p = await h.http().get(`/v1/products/${PRODUCT_2}/fit?profile_id=${id}`).set(auth(TOKENS.buyerA));
    expect(p.status).toBe(200);
    expect(p.body).toEqual(r.body);
    // the analytics event holds no measurement
    const ev = h.events.events.filter((e) => e.type === "size_recommended");
    expect(ev.length).toBeGreaterThan(0);
    expect(JSON.stringify(ev)).not.toContain("bust");
  });

  it("flags low confidence as not sure (confidence below 0.6, first explanation)", async () => {
    await publishChart();
    const id = await makeProfile(TOKENS.buyerA, { measurements: { bust_cm: 86 } });
    const r = await h.http().get(`/v1/fit/recommend?sku_group=${PRODUCT_1}&profile_id=${id}`).set(auth(TOKENS.buyerA));
    expect(r.status).toBe(200);
    expect(r.body.confidence).toBeLessThan(0.6);
    expect(r.body.explanation[0].en).toMatch(/not sure/i);
  });

  it("stops using measurements the moment the consent is withdrawn", async () => {
    await publishChart();
    const id = await makeProfile(TOKENS.buyerA);
    h.consent.withdraw(USER_A);
    const r = await h.http().get(`/v1/fit/recommend?sku_group=${PRODUCT_1}&profile_id=${id}`).set(auth(TOKENS.buyerA));
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("measurements_consent_required");
  });

  it("422 when the profile has neither measurements nor a usual size", async () => {
    await publishChart();
    const bare = await h.http().post("/v1/me/size-profiles").set(auth(TOKENS.buyerA)).send({ label: "Bare", kind: "me" });
    const r = await h.http().get(`/v1/fit/recommend?sku_group=${PRODUCT_1}&profile_id=${bare.body.id}`).set(auth(TOKENS.buyerA));
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("measurements_required");
  });

  it("uses a usual size with low confidence", async () => {
    await publishChart();
    const bare = await h
      .http()
      .post("/v1/me/size-profiles")
      .set(auth(TOKENS.buyerA))
      .send({ label: "Usual", kind: "me", usual_size: { size_label: "L" } });
    const r = await h.http().get(`/v1/fit/recommend?sku_group=${PRODUCT_1}&profile_id=${bare.body.id}`).set(auth(TOKENS.buyerA));
    expect(r.status).toBe(200);
    expect(r.body.size).toBe("L");
    expect(r.body.confidence).toBeLessThanOrEqual(0.55);
  });

  it("another user's profile or an unknown product is a 404", async () => {
    await publishChart();
    const id = await makeProfile(TOKENS.buyerA);
    const other = await h.http().get(`/v1/fit/recommend?sku_group=${PRODUCT_1}&profile_id=${id}`).set(auth(TOKENS.buyerB));
    expect(other.status).toBe(404);
    const unknown = await h
      .http()
      .get(`/v1/fit/recommend?sku_group=0192f3a4-5b6c-7d8e-9f01-0000000000aa&profile_id=${id}`)
      .set(auth(TOKENS.buyerA));
    expect(unknown.status).toBe(404);
  });

  it("validates query parameters", async () => {
    const r = await h.http().get("/v1/fit/recommend?sku_group=nope&profile_id=nope").set(auth(TOKENS.buyerA));
    expect(r.status).toBe(400);
    const missing = await h.http().get("/v1/fit/recommend").set(auth(TOKENS.buyerA));
    expect(missing.status).toBe(400);
  });

  it("shifts up after two too_small in the same brand and cites the count (acceptance)", async () => {
    await publishChart();
    const id = await makeProfile(TOKENS.buyerB, { label: "Hist" });
    const before = await h.http().get(`/v1/fit/recommend?sku_group=${PRODUCT_1}&profile_id=${id}`).set(auth(TOKENS.buyerB));
    expect(before.body.size).toBe("M");

    const lineA = "0192f3a4-5b6c-7d8e-9f01-0000000a0001";
    const lineB = "0192f3a4-5b6c-7d8e-9f01-0000000a0002";
    for (const line of [lineA, lineB]) {
      h.lines.seed(USER_B, line, {
        kind: "delivered",
        line: { orderLineId: line, productId: PRODUCT_1, brandId: BRAND_X, productType: "tops", sizeLabel: "M", sizeChartId: null },
      });
    }
    const key = [IDEM_1, IDEM_2];
    for (const [i, line] of [lineA, lineB].entries()) {
      const fb = await h
        .http()
        .post(`/v1/orders/lines/${line}/fit-feedback`)
        .set(auth(TOKENS.buyerB))
        .set("Idempotency-Key", key[i] as string)
        .send({ rating: "too_small", area: "chest" });
      expect(fb.status).toBe(204);
    }
    const after = await h.http().get(`/v1/fit/recommend?sku_group=${PRODUCT_2}&profile_id=${id}`).set(auth(TOKENS.buyerB));
    expect(after.status).toBe(200);
    expect(after.body.size).toBe("L");
    const cite = after.body.explanation.find((e: { en: string }) => e.en.includes('"too small" 2 times'));
    expect(cite).toBeDefined();
    expect(cite.ar).toContain("2");
    // another brand is untouched
    h.catalog.seed({ productId: PRODUCT_NO_CHART, storeId: STORE_A, brandId: BRAND_Y, productType: "tops", stretch: "none" });
    const otherBrand = await h.http().get(`/v1/fit/recommend?sku_group=${PRODUCT_NO_CHART}&profile_id=${id}`).set(auth(TOKENS.buyerB));
    expect(otherBrand.body.size).toBe("M");
    h.catalog.seed({ productId: PRODUCT_NO_CHART, storeId: STORE_B, brandId: BRAND_Y, productType: "tops", stretch: "none" });
  });

  it("shows community fit only with at least 20 events, with the count", async () => {
    await publishChart();
    const chartList = await h.http().get("/v1/seller/size-charts?limit=50").set(auth(TOKENS.sellerOwnerA));
    const latest = [...chartList.body.items].reverse().find((c: { validated: boolean; product_type: string }) => c.validated && c.product_type === "tops");
    const chartId = latest.id as string;
    const id = await makeProfile(TOKENS.buyerA);
    const seedFeedback = (n: number, rating: "too_small" | "ok", offset: number) => {
      for (let i = 0; i < n; i += 1) {
        h.feedback.seed({
          id: `0192f3a4-5b6c-7d8e-9f01-${String(offset + i).padStart(12, "0")}`,
          orderLineId: `0192f3a4-5b6c-7d8e-9f01-${String(offset + i + 500).padStart(12, "0")}`,
          userId: `0192f3a4-5b6c-7d8e-9f01-${String(offset + i + 9000).padStart(12, "0")}`,
          profileId: null,
          productId: PRODUCT_2,
          brandId: BRAND_Y,
          productType: "tops",
          sizeChartId: chartId,
          sizeLabel: "M",
          rating,
          area: null,
          submittedAtMs: 0,
        });
      }
    };
    seedFeedback(19, "too_small", 70000);
    const r19 = await h.http().get(`/v1/fit/recommend?sku_group=${PRODUCT_2}&profile_id=${id}`).set(auth(TOKENS.buyerA));
    expect(r19.body.community_fit).toBeNull();
    seedFeedback(1, "too_small", 71000);
    const r20 = await h.http().get(`/v1/fit/recommend?sku_group=${PRODUCT_2}&profile_id=${id}`).set(auth(TOKENS.buyerA));
    expect(r20.body.community_fit).toEqual({ tendency: "runs_small", sample_size: 20 });
    expect(r20.body.size).toBe("L");
  });
});

describe("fit feedback", () => {
  const LINE_OK = "0192f3a4-5b6c-7d8e-9f01-0000000b0001";
  const LINE_PENDING = "0192f3a4-5b6c-7d8e-9f01-0000000b0002";
  beforeAll(() => {
    h.lines.seed(USER_A, LINE_OK, {
      kind: "delivered",
      line: { orderLineId: LINE_OK, productId: PRODUCT_1, brandId: BRAND_X, productType: "tops", sizeLabel: "S", sizeChartId: null },
    });
    h.lines.seed(USER_A, LINE_PENDING, { kind: "not_delivered" });
  });

  it("requires an Idempotency-Key", async () => {
    const r = await h.http().post(`/v1/orders/lines/${LINE_OK}/fit-feedback`).set(auth(TOKENS.buyerA)).send({ rating: "ok" });
    expect(r.status).toBe(400);
  });

  it("records once, replays with the same key and returns 409 for a second submission", async () => {
    const first = await h
      .http()
      .post(`/v1/orders/lines/${LINE_OK}/fit-feedback`)
      .set(auth(TOKENS.buyerA))
      .set("Idempotency-Key", IDEM_3)
      .send({ rating: "ok" });
    expect(first.status).toBe(204);
    const replay = await h
      .http()
      .post(`/v1/orders/lines/${LINE_OK}/fit-feedback`)
      .set(auth(TOKENS.buyerA))
      .set("Idempotency-Key", IDEM_3)
      .send({ rating: "ok" });
    expect(replay.status).toBe(204);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    const second = await h
      .http()
      .post(`/v1/orders/lines/${LINE_OK}/fit-feedback`)
      .set(auth(TOKENS.buyerA))
      .set("Idempotency-Key", "0192f3a4-5b6c-7d8e-9f01-23456789abc9")
      .send({ rating: "too_large" });
    expect(second.status).toBe(409);
  });

  it("is refused before delivery and for another user's line", async () => {
    const pending = await h
      .http()
      .post(`/v1/orders/lines/${LINE_PENDING}/fit-feedback`)
      .set(auth(TOKENS.buyerA))
      .set("Idempotency-Key", "0192f3a4-5b6c-7d8e-9f01-23456789abd1")
      .send({ rating: "ok" });
    expect(pending.status).toBe(422);
    expect(pending.body.code).toBe("line-not-delivered".replace(/-/g, "_"));
    const foreign = await h
      .http()
      .post(`/v1/orders/lines/${LINE_PENDING}/fit-feedback`)
      .set(auth(TOKENS.buyerB))
      .set("Idempotency-Key", "0192f3a4-5b6c-7d8e-9f01-23456789abd2")
      .send({ rating: "ok" });
    expect(foreign.status).toBe(404);
  });

  it("validates the body strictly", async () => {
    const r = await h
      .http()
      .post(`/v1/orders/lines/${LINE_OK}/fit-feedback`)
      .set(auth(TOKENS.buyerA))
      .set("Idempotency-Key", "0192f3a4-5b6c-7d8e-9f01-23456789abd3")
      .send({ rating: "great", user_id: USER_B });
    expect(r.status).toBe(400);
  });
});

describe("seller size demand (k-anonymity)", () => {
  it("returns only cells with at least 50 and never anything personal", async () => {
    h.demand.seed(STORE_A, "tops", "M", "2026-W40", 49);
    h.demand.seed(STORE_A, "tops", "L", "2026-W40", 50);
    h.demand.seed(STORE_A, "tops", "S", "2026-W40", 1200);
    h.demand.seed(STORE_B, "tops", "M", "2026-W40", 900);
    const r = await h.http().get("/v1/seller/size-demand").set(auth(TOKENS.sellerOwnerA));
    expect(r.status).toBe(200);
    expect(r.body.min_cell_size).toBe(50);
    const sizes = r.body.items.map((i: { size_label: string; demand_count: number }) => `${i.size_label}:${i.demand_count}`);
    expect(sizes).toContain("L:50");
    expect(sizes).toContain("S:1200");
    expect(sizes).not.toContain("M:49");
    expect(sizes).not.toContain("M:900");
    for (const item of r.body.items) expect(Object.keys(item).sort()).toEqual(["demand_count", "product_type", "size_label", "week"]);
  });
});

describe("negative authorization", () => {
  const LINE = "0192f3a4-5b6c-7d8e-9f01-0000000c0001";
  const PROFILE = "0192f3a4-5b6c-7d8e-9f01-0000000d0001";
  const buyerRoutes: readonly [string, string, unknown][] = [
    ["get", "/v1/me/size-profiles", undefined],
    ["post", "/v1/me/size-profiles", { label: "x", kind: "me" }],
    ["get", `/v1/me/size-profiles/${PROFILE}`, undefined],
    ["patch", `/v1/me/size-profiles/${PROFILE}`, { label: "x" }],
    ["delete", `/v1/me/size-profiles/${PROFILE}`, undefined],
    ["get", `/v1/fit/recommend?sku_group=${PRODUCT_1}&profile_id=${PROFILE}`, undefined],
    ["get", `/v1/products/${PRODUCT_1}/fit?profile_id=${PROFILE}`, undefined],
    ["post", `/v1/orders/lines/${LINE}/fit-feedback`, { rating: "ok" }],
  ];
  const sellerRoutes: readonly [string, string, unknown][] = [
    ["get", "/v1/seller/size-charts", undefined],
    ["post", "/v1/seller/size-charts", { product_type: "tops", unit: "cm", rows: TOPS_ROWS }],
    ["get", "/v1/seller/size-demand", undefined],
  ];

  const call = (method: string, path: string, body: unknown, headers: Record<string, string>) => {
    const t = h.http() as unknown as Record<string, (p: string) => { set(h: Record<string, string>): { send(b?: unknown): Promise<{ status: number }> } }>;
    const fn = t[method];
    if (fn === undefined) throw new Error(`bad method ${method}`);
    return fn.call(t, path).set(headers).send(body);
  };

  it.each(buyerRoutes)("%s %s: 401 without credentials", async (m, p, b) => {
    expect((await call(m, p, b, { "Idempotency-Key": IDEM_1 })).status).toBe(401);
  });
  it.each(buyerRoutes)("%s %s: 401 with a seller audience token", async (m, p, b) => {
    expect((await call(m, p, b, { ...auth(TOKENS.sellerOwnerA), "Idempotency-Key": IDEM_1 })).status).toBe(401);
  });
  it.each(sellerRoutes)("%s %s: 401 without credentials", async (m, p, b) => {
    expect((await call(m, p, b, {})).status).toBe(401);
  });
  it.each(sellerRoutes)("%s %s: 401 with a buyer audience token, even one carrying a brand grant", async (m, p, b) => {
    expect((await call(m, p, b, auth(TOKENS.buyerA))).status).toBe(401);
    expect((await call(m, p, b, auth(TOKENS.buyerWithBrand))).status).toBe(401);
  });
  it("seller write: 403 for a support role", async () => {
    expect((await call("post", "/v1/seller/size-charts", { product_type: "tops", unit: "cm", rows: TOPS_ROWS }, auth(TOKENS.sellerSupportA))).status).toBe(403);
  });
  it.each([
    ["get", `/v1/me/size-profiles/${PROFILE}`, undefined],
    ["patch", `/v1/me/size-profiles/${PROFILE}`, { label: "x" }],
    ["delete", `/v1/me/size-profiles/${PROFILE}`, undefined],
    ["get", `/v1/fit/recommend?sku_group=${PRODUCT_1}&profile_id=${PROFILE}`, undefined],
    ["get", `/v1/products/${PRODUCT_1}/fit?profile_id=${PROFILE}`, undefined],
  ] as const)("%s %s: 404 for a profile that is not the caller's", async (m, p, b) => {
    h.consent.grant(USER_A);
    h.consent.grant(USER_B);
    // PROFILE does not exist for anyone, and A's real profile is not visible to B
    expect((await call(m, p, b, { ...auth(TOKENS.buyerB), "If-Match": "*" })).status).toBe(404);
    const mine = await makeProfile(TOKENS.buyerA, { label: "Mine" });
    const swapped = p.replace(PROFILE, mine);
    expect((await call(m, swapped, b, { ...auth(TOKENS.buyerB), "If-Match": "*" })).status).toBe(404);
    // the owner's data is intact
    const still = await h.http().get(`/v1/me/size-profiles/${mine}`).set(auth(TOKENS.buyerA));
    expect(still.status).toBe(200);
  });
  it("no seller route reaches profiles or feedback", async () => {
    for (const p of ["/v1/seller/size-profiles", "/v1/seller/fit-feedback", "/v1/seller/measurements"]) {
      expect((await h.http().get(p).set(auth(TOKENS.sellerOwnerA))).status).toBe(404);
    }
  });
});
