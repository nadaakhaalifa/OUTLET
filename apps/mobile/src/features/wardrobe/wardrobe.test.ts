import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient, type FetchLike } from "../../services/api-client";
import type { AdapterContext } from "../../services/wire";
import { ApiWardrobePort } from "./api";
import {
  EMPTY_ATTRIBUTES, InMemoryWardrobePort, WARDROBE_CAP, atCapacity, canSuggest, isSafeUploadUrl, missingFields, photoTypeOf, reviewCount, sortItems, togglePalette, toggleSeason,
  wardrobeKindFor, type WardrobeAttributes, type WardrobeItem,
} from "./model";

const IID = "0192f3a4-5b6c-7d8e-9f01-23456789abc1";
const OID = "0192f3a4-5b6c-7d8e-9f01-23456789abc2";
const STORE = "0192f3a4-5b6c-7d8e-9f01-23456789abc4";
const TS = "2026-10-11T10:00:00Z";

const item = (over: Partial<WardrobeItem> = {}): WardrobeItem => ({ id: "w", attributes: EMPTY_ATTRIBUTES, source: "user", needsReview: false, complete: false, photo: "none", version: 1, ...over });
const full: WardrobeAttributes = { category: "dress", palette: ["navy"], pattern: "solid", formality: 3, seasons: ["all"], material: "silk", modest: true };

describe("attribute helpers", () => {
  it("lists what is still empty", () => {
    expect(missingFields(EMPTY_ATTRIBUTES)).toEqual(["category", "palette", "pattern", "formality", "seasons", "material"]);
    expect(missingFields(full)).toEqual([]);
  });
  it("keeps at most three colours, dropping the oldest", () => {
    expect(togglePalette(["red", "blue", "navy"], "black")).toEqual(["blue", "navy", "black"]);
    expect(togglePalette(["red", "blue"], "red")).toEqual(["blue"]);
  });
  it("treats 'all' seasons as exclusive", () => {
    expect(toggleSeason(["summer", "winter"], "all")).toEqual(["all"]);
    expect(toggleSeason(["all"], "summer")).toEqual(["summer"]);
    expect(toggleSeason(["all"], "all")).toEqual([]);
  });
  it("maps stylist occasions to wardrobe kinds", () => {
    expect(wardrobeKindFor("weddingGuest")).toBe("wedding_guest");
    expect(wardrobeKindFor("beach")).toBe("custom");
    expect(wardrobeKindFor("work")).toBe("work");
  });
});

describe("photos and review", () => {
  it("chooses an allowed content type and falls back to JPEG", () => {
    expect(photoTypeOf("image/png", "file:///a")).toBe("image/png");
    expect(photoTypeOf("", "file:///a/b.WEBP")).toBe("image/webp");
    expect(photoTypeOf("image/heic", "file:///a/b.heic")).toBe("image/jpeg");
  });
  it("accepts only https upload urls (plain http for local hosts)", () => {
    expect(isSafeUploadUrl("https://bucket.example/up")).toBe(true);
    expect(isSafeUploadUrl("http://evil.example/up")).toBe(false);
    expect(isSafeUploadUrl("http://localhost:9000/up")).toBe(true);
    expect(isSafeUploadUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeUploadUrl("file:///etc/passwd")).toBe(false);
  });
  it("suggests only for clean photos whose details are not already complete", () => {
    expect(canSuggest(item({ photo: "clean" }))).toBe(true);
    expect(canSuggest(item({ photo: "none" }))).toBe(false);
    expect(canSuggest(item({ photo: "pending_scan" }))).toBe(false);
    expect(canSuggest(item({ photo: "clean", complete: true, source: "user" }))).toBe(false);
  });
  it("puts items needing review first and counts them", () => {
    const items = [item({ id: "a" }), item({ id: "b", needsReview: true })];
    expect(sortItems(items).map((i) => i.id)).toEqual(["b", "a"]);
    expect(reviewCount(items)).toBe(1);
    expect(atCapacity(WARDROBE_CAP)).toBe(true);
    expect(atCapacity(WARDROBE_CAP - 1)).toBe(false);
  });
});

describe("in-memory wardrobe port", () => {
  it("adds, suggests (needs review), confirms with the version, and deletes everything", async () => {
    const port = new InMemoryWardrobePort();
    const a = await port.add({ photoUri: "file:///p.jpg", attributes: EMPTY_ATTRIBUTES });
    const s = await port.suggest(a.id);
    expect(s).toMatchObject({ needsReview: true, source: "vision" });
    const confirmed = await port.update(a.id, s.attributes, s.version);
    expect(confirmed).toMatchObject({ needsReview: false, source: "user" });
    await expect(port.update(a.id, s.attributes, s.version)).rejects.toMatchObject({ reason: "conflict" });
    await port.clear();
    expect(await port.list()).toEqual([]);
  });
  it("refuses a suggestion without a clean photo and enforces the cap", async () => {
    const port = new InMemoryWardrobePort(null, 1);
    const a = await port.add({ photoUri: null, attributes: full });
    await expect(port.suggest(a.id)).rejects.toMatchObject({ reason: "rejected" });
    await expect(port.add({ photoUri: null, attributes: full })).rejects.toMatchObject({ reason: "full" });
  });
  it("completes a look from owned pieces, and says so when nothing is owned", async () => {
    const port = new InMemoryWardrobePort();
    await expect(port.completeLook()).rejects.toMatchObject({ reason: "nothingOwned" });
    await port.add({ photoUri: null, attributes: { ...full, category: "dress" } });
    const look = await port.completeLook();
    expect(Object.values(look.ownedSlots)[0]).toContain("dress");
    expect(look.outfits[0]?.items.some((i) => i.slot === "dress")).toBe(false);
  });
});

interface Req { method: string; path: string; body: unknown }
function harness(routes: Record<string, (r: Req) => { status?: number; body?: unknown }>) {
  const calls: Req[] = [];
  const fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    const req: Req = { method: init?.method ?? "GET", path: u.pathname, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined };
    calls.push(req);
    const h = routes[`${req.method} ${req.path}`];
    if (h === undefined) return new Response(JSON.stringify({ type: "/p/nf", title: "nf", status: 404 }), { status: 404, headers: { "Content-Type": "application/problem+json" } });
    const r = h(req);
    const status = r.status ?? 200;
    if (status >= 400) return new Response(JSON.stringify({ type: "/p/x", title: "x", status, ...(r.body as object) }), { status, headers: { "Content-Type": "application/problem+json" } });
    return new Response(status === 204 ? null : JSON.stringify(r.body ?? {}), { status, headers: { "Content-Type": "application/json" } });
  };
  const client = createClient({ baseUrl: "https://api.test", fetch, getToken: () => "tok", sleep: async () => undefined, randomBytes: (n) => new Uint8Array(n).fill(3), maxRetries: 0 });
  const ctx: AdapterContext = { client, locale: () => "ar", nowMs: () => Date.parse(TS), deviceId: () => "install-device-1" };
  return { ctx, calls };
}

const wireItem = {
  id: IID, attributes: { category: "dress", palette: ["navy"], formality: 3 }, attributes_source: "vision", complete: false, needs_review: true,
  photo: { state: "clean" }, vision_model_version: "v1", version: 2, created_at: TS, updated_at: TS,
};

describe("ApiWardrobePort", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("lists items across pages and marks suggestions as needing review", async () => {
    const { ctx } = harness({ "GET /v1/me/wardrobe/items": () => ({ body: { items: [wireItem], next_cursor: "" } }) });
    const items = await new ApiWardrobePort(ctx).list();
    expect(items[0]).toMatchObject({ id: IID, needsReview: true, source: "vision", photo: "clean", attributes: { category: "dress", palette: ["navy"], formality: 3, pattern: null } });
  });

  it("uploads through the signed flow: issue, PUT the bytes, then create with the upload id", async () => {
    const uploadId = "wardrobe/2026/10/0192f3a4-5b6c-7d8e-9f01-23456789abc9";
    const puts: { url: string; type: string | null }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        puts.push({ url, type: new Headers(init.headers).get("Content-Type") });
        return new Response(null, { status: 200 });
      }
      return new Response(new Blob([new Uint8Array(2048)], { type: "image/png" }), { status: 200 });
    });
    const { ctx, calls } = harness({
      "POST /v1/me/wardrobe/uploads": () => ({
        status: 201,
        body: { upload_id: uploadId, url: "https://store.example/put", method: "PUT", headers: { "x-amz-meta": "1" }, expires_at: TS, max_bytes: 10485760 },
      }),
      "POST /v1/me/wardrobe/items": () => ({ status: 201, body: { ...wireItem, attributes_source: "user", needs_review: false, photo: { state: "pending_scan" } } }),
    });
    const created = await new ApiWardrobePort(ctx).add({ photoUri: "file:///photo.png", attributes: { ...EMPTY_ATTRIBUTES, category: "dress" } });
    expect(calls[0]?.body).toEqual({ content_type: "image/png", size_bytes: 2048 });
    expect(puts).toEqual([{ url: "https://store.example/put", type: "image/png" }]);
    expect(calls[1]?.body).toEqual({ upload_id: uploadId, attributes: { category: "dress" } });
    expect(created.photo).toBe("pending_scan");
  });

  it("refuses an unsafe upload url before sending any bytes", async () => {
    let putCalled = false;
    vi.stubGlobal("fetch", async (_u: string, init?: RequestInit) => {
      if (init?.method === "PUT") putCalled = true;
      return new Response(new Blob([new Uint8Array(10)], { type: "image/jpeg" }), { status: 200 });
    });
    const { ctx } = harness({
      "POST /v1/me/wardrobe/uploads": () => ({ status: 201, body: { upload_id: "wardrobe/2026/10/0192f3a4-5b6c-7d8e-9f01-23456789abc9", url: "http://evil.example/x", method: "PUT", headers: {}, expires_at: TS, max_bytes: 1 } }),
    });
    await expect(new ApiWardrobePort(ctx).add({ photoUri: "file:///p.jpg", attributes: EMPTY_ATTRIBUTES })).rejects.toMatchObject({ reason: "failed" });
    expect(putCalled).toBe(false);
  });

  it("confirms attributes with expected_version and maps a version conflict", async () => {
    const { ctx, calls } = harness({ [`PATCH /v1/me/wardrobe/items/${IID}`]: () => ({ body: { ...wireItem, attributes_source: "user", needs_review: false, version: 3 } }) });
    const r = await new ApiWardrobePort(ctx).update(IID, { ...EMPTY_ATTRIBUTES, category: "dress", palette: ["navy"] }, 2);
    expect(r.needsReview).toBe(false);
    expect(calls[0]?.body).toEqual({ attributes: { category: "dress", palette: ["navy"] }, expected_version: 2 });
  });

  it("completes a look from the wardrobe", async () => {
    const { ctx, calls } = harness({
      "POST /v1/me/wardrobe/complete": () => ({
        body: {
          owned: [{ slot: "dress", wardrobe_item_id: IID }], owned_only: false, source: "ml", fallback_reason: "none", remaining_today: 20, shortfall: [],
          outfits: [{
            outfit_id: OID, complete: true, source: "ml", total_piastres: "60000", remaining_budget_piastres: "0", owned_slots: ["dress"],
            items: [{ item_id: IID, store_id: STORE, slot: "shoes", price_piastres: "60000", verified_discount_pct: 0 }], missing: [],
          }],
        },
      }),
    });
    const look = await new ApiWardrobePort(ctx).completeLook({ kind: "wedding_guest", modest: true, budget: 300_000n });
    expect(calls[0]?.body).toEqual({ kind: "wedding_guest", modest: true, budget_piastres: "300000" });
    expect(look.ownedSlots[OID]).toEqual(["dress"]);
    expect(look.outfits[0]?.items[0]).toMatchObject({ slot: "shoes", unitPrice: 60_000n });
  });

  it("maps a missing personalization consent and clears the wardrobe", async () => {
    const { ctx } = harness({
      "POST /v1/me/wardrobe/complete": () => ({ status: 403, body: { code: "consent_required" } }),
      "DELETE /v1/me/wardrobe": () => ({ status: 204 }),
    });
    const port = new ApiWardrobePort(ctx);
    await expect(port.completeLook({ kind: "work", modest: false, budget: null })).rejects.toMatchObject({ reason: "consent" });
    await expect(port.clear()).resolves.toBeUndefined();
  });
});
