import { describe, expect, it } from "vitest";
import { fakeApi, problem } from "../../services/fake-api";
import { PortError } from "../worlds/model";
import { ApiVisualSearchPort, visualReasonFromError, type ImageUploader } from "./api";
import {
  FakeImageSource, FIXTURE_VISUAL_ITEMS, InMemoryVisualSearchPort, MAX_IMAGE_BYTES, VisualSearchError, buildVisualView, canRetry, checkImage,
  normalizeImageType, runVisualSearch, toTile, type PickedImage, type VisualResults,
} from "./model";

const U1 = "0192f3a4-5b6c-7d8e-9f01-23456789abc1";
const U2 = "0192f3a4-5b6c-7d8e-9f01-23456789abc2";
const img = (over: Partial<PickedImage> = {}): PickedImage => ({ uri: "file:///p.jpg", contentType: "image/jpeg", sizeBytes: 1000, width: 800, height: 1000, ...over });
const results = (over: Partial<VisualResults> = {}): VisualResults => ({ items: FIXTURE_VISUAL_ITEMS, lowConfidence: false, degraded: false, categoryGuess: null, ...over });

describe("image checks", () => {
  it("accepts jpeg, png and webp within limits", () => {
    expect(checkImage(img())).toBeNull();
    expect(checkImage(img({ contentType: "image/png" }))).toBeNull();
  });
  it("rejects unknown types, empty files and oversize bytes or pixels", () => {
    expect(checkImage(img({ contentType: null }))).toBe("unsupportedType");
    expect(checkImage(img({ sizeBytes: 0 }))).toBe("empty");
    expect(checkImage(img({ sizeBytes: MAX_IMAGE_BYTES + 1 }))).toBe("tooLarge");
    expect(checkImage(img({ width: 5000 }))).toBe("tooLarge");
    expect(checkImage(img({ sizeBytes: null }))).toBeNull();
  });
  it("normalises mime types, falling back to the extension only when no mime is given", () => {
    expect(normalizeImageType("image/JPG", "x")).toBe("image/jpeg");
    expect(normalizeImageType(undefined, "file:///a.PNG?x=1")).toBe("image/png");
    expect(normalizeImageType("image/heic", "file:///a.jpg")).toBeNull();
  });
});

describe("result view", () => {
  it("splits close matches from similar ones", () => {
    const v = buildVisualView(results());
    expect(v.sections.map((s) => s.key)).toEqual(["closest", "similar"]);
    expect(v.banner).toBeNull();
    expect(v.empty).toBe(false);
  });
  it("low confidence: one neutral section, a banner, and no item is presented as a close match", () => {
    const v = buildVisualView(results({ lowConfidence: true }));
    expect(v.banner).toBe("lowConfidence");
    expect(v.sections.map((s) => s.key)).toEqual(["closestWeHave"]);
  });
  it("degraded results say so; empty results are an empty view", () => {
    expect(buildVisualView(results({ degraded: true })).banner).toBe("degraded");
    expect(buildVisualView(results({ items: [] })).empty).toBe(true);
  });
  it("never builds a reference price from a verified percentage", () => {
    const tile = toTile(FIXTURE_VISUAL_ITEMS[0]!);
    expect(tile.referencePrice).toBeNull();
    expect(tile.sponsored).toBe(false);
  });
});

describe("runVisualSearch", () => {
  it("cancelled picker leaves the screen idle and makes no request", async () => {
    const port = new InMemoryVisualSearchPort();
    const s = await runVisualSearch(new FakeImageSource({ kind: "cancelled" }), port, "camera");
    expect(s.status).toBe("idle");
    expect(port.searched).toHaveLength(0);
  });
  it("denied permission is its own state", async () => {
    expect((await runVisualSearch(new FakeImageSource({ kind: "denied" }), new InMemoryVisualSearchPort(), "library")).status).toBe("denied");
  });
  it("an invalid photo never reaches the port", async () => {
    const port = new InMemoryVisualSearchPort();
    const s = await runVisualSearch(new FakeImageSource({ kind: "picked", image: img({ contentType: null }) }), port, "library");
    expect(s).toEqual({ status: "invalid", problem: "unsupportedType" });
    expect(port.searched).toHaveLength(0);
  });
  it("returns results and signals the searching state once a valid photo exists", async () => {
    let searching = 0;
    const s = await runVisualSearch(new FakeImageSource(), new InMemoryVisualSearchPort(), "camera", false, () => { searching += 1; });
    expect(searching).toBe(1);
    expect(s.status).toBe("results");
  });
  it("maps expected failures to reasons and offline to the offline state", async () => {
    const port = new InMemoryVisualSearchPort(results(), new VisualSearchError("rateLimited"));
    expect(await runVisualSearch(new FakeImageSource(), port, "library")).toEqual({ status: "error", offline: false, reason: "rateLimited" });
    port.setFailure(new PortError("offline"));
    expect(await runVisualSearch(new FakeImageSource(), port, "library")).toEqual({ status: "error", offline: true, reason: null });
  });
  it("retry is offered only when another attempt can change the outcome", () => {
    expect(canRetry("rateLimited")).toBe(true);
    expect(canRetry(null)).toBe(true);
    expect(canRetry("rejected")).toBe(false);
    expect(canRetry("disabled")).toBe(false);
  });
});

const wireItem = (id: string, over: Record<string, unknown> = {}) => ({
  product_id: id, store_id: U2, category_id: "dresses", price_piastres: "129900", verified_discount_pct: null, match: "close", sponsored: false, ...over,
});
const wireResults = (items: unknown[], over: Record<string, unknown> = {}) => ({ items, groups: [], low_confidence: false, degraded: false, model_version: null, category_guess: null, ...over });

class FakeUploader implements ImageUploader {
  readonly puts: { uri: string; url: string; headers: Record<string, string> }[] = [];
  measured = 0;
  async measure(): Promise<number> { this.measured += 1; return 4321; }
  async put(uri: string, target: { url: string; headers: Readonly<Record<string, string>> }): Promise<void> { this.puts.push({ uri, url: target.url, headers: { ...target.headers } }); }
}

describe("ApiVisualSearchPort", () => {
  it("runs the signed flow: issue upload, PUT to the target, then search by upload id", async () => {
    const { ctx, calls } = fakeApi({
      "POST /v1/search/visual/uploads": () => ({ status: 200, body: { upload_id: "upload-abc-123", url: "https://objects.test/u1", headers: { "content-type": "image/jpeg" }, expires_at: "2026-10-11T10:10:00Z" } }),
      "POST /v1/search/visual": () => ({ body: wireResults([wireItem(U1, { verified_discount_pct: 20 })]) }),
    });
    const up = new FakeUploader();
    const r = await new ApiVisualSearchPort(ctx, up).search(img({ sizeBytes: null }), { limit: 12 });
    expect(up.measured).toBe(1);
    expect(up.puts).toEqual([{ uri: "file:///p.jpg", url: "https://objects.test/u1", headers: { "content-type": "image/jpeg" } }]);
    expect(calls[0]?.body).toEqual({ content_type: "image/jpeg", size_bytes: 4321 });
    expect(calls[1]?.body).toEqual({ upload_id: "upload-abc-123", limit: 12 });
    expect(r.items[0]).toMatchObject({ productId: U1, price: 129_900n, verifiedPct: 20, match: "close", title: "" });
  });

  it("retries while the scan is pending (409 upload_not_ready), then succeeds", async () => {
    let n = 0;
    const { ctx } = fakeApi({
      "POST /v1/search/visual/uploads": () => ({ body: { upload_id: "upload-abc-123", url: "https://objects.test/u1", headers: {}, expires_at: "2026-10-11T10:10:00Z" } }),
      "POST /v1/search/visual": () => (++n < 3 ? problem(409, "upload_not_ready") : { body: wireResults([wireItem(U1)]) }),
    });
    const r = await new ApiVisualSearchPort(ctx, new FakeUploader(), async () => undefined).search(img());
    expect(n).toBe(3);
    expect(r.items).toHaveLength(1);
  });

  it("maps documented problem codes to reasons", async () => {
    const cases: [number, string, string][] = [
      [503, "visual_search_disabled", "disabled"], [503, "embedder_unavailable", "unavailable"], [429, "daily_limit", "rateLimited"],
      [422, "image_unsafe", "rejected"], [422, "image_unsupported_type", "unsupportedType"], [422, "image_too_large_bytes", "tooLarge"],
    ];
    for (const [status, code, reason] of cases) {
      const { ctx } = fakeApi({
        "POST /v1/search/visual/uploads": () => ({ body: { upload_id: "upload-abc-123", url: "https://objects.test/u1", headers: {}, expires_at: "2026-10-11T10:10:00Z" } }),
        "POST /v1/search/visual": () => problem(status, code),
      });
      await expect(new ApiVisualSearchPort(ctx, new FakeUploader()).search(img())).rejects.toMatchObject({ reason });
    }
    expect(visualReasonFromError(new Error("x"))).toBeNull();
  });

  it("similarTo uses the visually-similar route and tolerates failing product lookups", async () => {
    const { ctx, calls } = fakeApi({ [`GET /v1/products/${U1}/visually-similar`]: () => ({ body: wireResults([wireItem(U2, { match: "similar" })], { degraded: true }) }) });
    const r = await new ApiVisualSearchPort(ctx, new FakeUploader()).similarTo(U1, 6);
    expect(calls[0]?.query.get("limit")).toBe("6");
    expect(r.degraded).toBe(true);
    expect(r.items[0]).toMatchObject({ productId: U2, match: "similar", title: "" });
  });
});
