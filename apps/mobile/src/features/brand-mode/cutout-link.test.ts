import { describe, expect, it } from "vitest";
import { createClient, type FetchLike } from "../../services/api-client";
import type { AdapterContext } from "../../services/wire";
import { REFRESH_LEAD_MS, MIN_REFRESH_DELAY_MS, refreshDelayMs, type CutoutJob } from "../background-removal/model";
import { ApiBrandPort } from "./api";
import { freshLink, imageEntries, linkedJobId, previewUri, syncJobLinks } from "./cutout-link";
import { EMPTY_DRAFT, type PhotoItem, type ProductDraft } from "./model";

const U = (n: number) => `0192f3a4-5b6c-7d8e-9f01-23456789cd${String(n).padStart(2, "0")}`;
const STORE = U(1), PROD = U(2), CAT = U(4), UP1 = U(8), JOB = U(9), JOB2 = U(10);
const TS = "2026-10-11T10:00:00Z";

const job = (over: Partial<CutoutJob> = {}): CutoutJob => ({
  jobId: JOB, status: "READY", decision: "accepted", qualityScore: 90, reasons: [], model: "u2netp", attempts: 1, errorCode: null,
  originalUrl: "https://s/o", cutoutUrl: "https://s/c", whiteUrl: "https://s/w", linksExpireAtMs: 10_000, simulated: false, ...over,
});
const photo = (over: Partial<PhotoItem> = {}): PhotoItem => ({ localId: "a", uri: "file://a.jpg", uploadId: UP1, progress: 1, state: "done", ...over });

describe("linking cutouts to the product", () => {
  it("only a settled, decided, real job is linked", () => {
    expect(linkedJobId(job())).toBe(JOB);
    expect(linkedJobId(job({ decision: "use_original" }))).toBe(JOB);
    expect(linkedJobId(job({ decision: "none" }))).toBeNull();
    expect(linkedJobId(job({ status: "PROCESSING" }))).toBeNull();
    expect(linkedJobId(job({ status: "FAILED" }))).toBeNull();
    expect(linkedJobId(job({ simulated: true }))).toBeNull();
    expect(linkedJobId(null)).toBeNull();
  });

  it("syncJobLinks sets and clears mediaJobId from the job decision and leaves unknown photos alone", () => {
    const photos = [photo(), photo({ localId: "b", uploadId: null, mediaJobId: JOB2 })];
    const r = syncJobLinks(photos, (id) => (id === "a" ? job() : null));
    expect(r.changed).toBe(true);
    expect(r.photos[0]?.mediaJobId).toBe(JOB);
    expect(r.photos[1]?.mediaJobId).toBe(JOB2);
    const cleared = syncJobLinks(r.photos, (id) => (id === "a" ? job({ decision: "none" }) : null));
    expect(cleared.photos[0]?.mediaJobId).toBeNull();
    expect(syncJobLinks(cleared.photos, (id) => (id === "a" ? job({ decision: "none" }) : null)).changed).toBe(false);
  });

  it("imageEntries is null without a linked photo, else ordered entries", () => {
    expect(imageEntries([photo()])).toBeNull();
    expect(imageEntries([photo(), photo({ localId: "b", uploadId: UP1, mediaJobId: JOB }), photo({ localId: "c", uploadId: null })])).toEqual([
      { upload_id: UP1 },
      { media_job_id: JOB },
    ]);
  });

  it("never hands an expired signed link to an image view", () => {
    const j = job();
    expect(freshLink("https://s/c", j, 9_999)).toBe("https://s/c");
    expect(freshLink("https://s/c", j, 10_000)).toBeNull();
    const view = { phase: "accepted", display: "cutout", canToggle: true } as const;
    expect(previewUri(photo(), j, view, 1_000)).toBe("https://s/c");
    expect(previewUri(photo(), j, view, 20_000)).toBe("file://a.jpg"); // expired: the local file, not a dead link
    expect(previewUri(photo({ uri: "" }), j, view, 20_000)).toBeNull(); // nothing safe to show: placeholder
  });

  it("refreshes signed links 30 s before they expire, never sooner than 5 s", () => {
    expect(refreshDelayMs(job({ linksExpireAtMs: 900_000 }), 0)).toBe(900_000 - REFRESH_LEAD_MS);
    expect(refreshDelayMs(job({ linksExpireAtMs: 10_000 }), 0)).toBe(MIN_REFRESH_DELAY_MS);
    expect(refreshDelayMs(job({ linksExpireAtMs: null }), 0)).toBeNull();
  });
});

describe("brand adapter sends media_job_id", () => {
  const egp = (n: number) => ({ amount: String(n), currency: "EGP" as const });
  const server = (over: Record<string, unknown> = {}) => ({
    id: PROD, status: "draft", title: { ar: "فستان كتان" }, category_id: CAT, condition: "new_with_tags", department: "unisex", image_upload_ids: [UP1, JOB], image_media_job_ids: [JOB],
    skus: [{ id: U(3), size_label: "M", price: egp(125000), on_hand: 4, available: 4 }], updated_at: TS, ...over,
  });
  function harness(routes: Record<string, () => { status?: number; body: unknown; headers?: Record<string, string> }>) {
    const calls: { method: string; path: string; body: unknown }[] = [];
    const base: typeof routes = {
      "GET /v1/seller/me": () => ({ body: { user_id: U(11), memberships: [{ store_id: STORE, role: "owner" }] } }),
      "GET /v1/seller/store": () => ({ body: { id: STORE, slug: "s", name: { ar: "متجر", en: "S" }, kind: "local", verified_badge: true, live_drop: false, is_favorite: false, status: "active", legal_identity: { legal_name: "S" }, kyc_status: "APPROVED" } }),
    };
    const all = { ...base, ...routes };
    const fetch: FetchLike = async (url, init) => {
      const u = new URL(url);
      const method = init?.method ?? "GET";
      calls.push({ method, path: u.pathname, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
      const h = all[`${method} ${u.pathname}`];
      if (h === undefined) return new Response("{}", { status: 404, headers: { "Content-Type": "application/problem+json" } });
      const r = h();
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "Content-Type": "application/json", ...(r.headers ?? {}) } });
    };
    const client = createClient({ baseUrl: "https://api.test", fetch, getToken: () => "tok", sleep: async () => undefined, randomBytes: (n) => new Uint8Array(n).fill(3), maxRetries: 0 });
    const ctx: AdapterContext = { client, locale: () => "ar", nowMs: () => Date.parse(TS), deviceId: () => "d" };
    return { ctx, calls };
  }
  const draft: ProductDraft = {
    ...EMPTY_DRAFT,
    photos: [photo({ localId: "a", uploadId: UP1 }), photo({ localId: "b", uploadId: null, mediaJobId: JOB })],
    titleAr: "فستان كتان", categoryId: CAT, condition: "new_with_tags", priceInput: "1,250", sizes: [{ label: "M", stock: "4" }],
  };

  it("create sends ordered images with the job id and no image_upload_ids", async () => {
    const { ctx, calls } = harness({ "POST /v1/seller/products": () => ({ status: 201, body: server(), headers: { ETag: '"c1"' } }) });
    await new ApiBrandPort(ctx).saveProduct({ ...draft, id: null }, false);
    const body = calls.find((c) => c.method === "POST" && c.path === "/v1/seller/products")?.body as Record<string, unknown>;
    expect(body.images).toEqual([{ upload_id: UP1 }, { media_job_id: JOB }]);
    expect(body.image_upload_ids).toBeUndefined();
  });

  it("without a linked photo the legacy image_upload_ids is unchanged", async () => {
    const { ctx, calls } = harness({ "POST /v1/seller/products": () => ({ status: 201, body: server(), headers: { ETag: '"c1"' } }) });
    await new ApiBrandPort(ctx).saveProduct({ ...draft, id: null, photos: [photo({ uploadId: UP1 })] }, false);
    const body = calls.find((c) => c.method === "POST" && c.path === "/v1/seller/products")?.body as Record<string, unknown>;
    expect(body.image_upload_ids).toEqual([UP1]);
    expect(body.images).toBeUndefined();
  });

  it("update sends images and reads linked photos back as job-backed", async () => {
    const { ctx, calls } = harness({
      [`GET /v1/seller/products/${PROD}`]: () => ({ body: server(), headers: { ETag: '"e1"' } }),
      [`PATCH /v1/seller/products/${PROD}`]: () => ({ body: server() }),
    });
    const port = new ApiBrandPort(ctx);
    await port.saveProduct({ ...draft, id: PROD }, false);
    const patch = calls.find((c) => c.method === "PATCH")?.body as Record<string, unknown>;
    expect(patch.images).toEqual([{ upload_id: UP1 }, { media_job_id: JOB }]);
    const back = await port.getProduct(PROD);
    expect(back.photos.map((p) => [p.uploadId, p.mediaJobId ?? null])).toEqual([[UP1, null], [null, JOB]]);
  });
});
