import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BackgroundRemovalError, FLAG_BACKGROUND_REMOVAL } from "../domain/ports";
import { STORE_A, STORE_B, TINY_PNG, TOKENS, U, bearer, createMediaHarness, idemKey, type MediaHarness } from "./harness";

let h: MediaHarness;
const base = (store: string): string => `/v1/seller/stores/${store}/product-media`;

beforeAll(async () => {
  h = await createMediaHarness();
}, 30_000);
afterAll(async () => {
  await h.close();
});
beforeEach(() => {
  h.flags.set(FLAG_BACKGROUND_REMOVAL, true);
  h.removal.failWith = null;
  h.removal.calls = 0;
});

const post = (token: string, path: string, body: unknown = {}) =>
  h.http().post(path).set({ ...bearer(token), ...idemKey() }).send(body as object);

async function newJob(token: string = TOKENS.ownerA, store: string = STORE_A, upload: "clean" | "pending_scan" | "infected" | "none" = "clean") {
  const r = await post(token, `${base(store)}/uploads`, { content_type: "image/png", size_bytes: TINY_PNG.length });
  expect(r.status).toBe(201);
  const jobId = r.body.job_id as string;
  const key = r.body.upload.upload_id as string;
  if (upload !== "none") h.blobs.put(key, TINY_PNG, upload);
  return { jobId, key };
}

describe("flow", () => {
  it("issues a signed upload, processes, scores, signs private links and accepts", async () => {
    const { jobId, key } = await newJob();
    expect(key.startsWith("product-media/")).toBe(true);
    const run = await post(TOKENS.ownerA, `${base(STORE_A)}/${jobId}/process`);
    expect(run.status).toBe(200);
    expect(run.body).toMatchObject({ status: "READY", decision: "none", model_id: "u2netp" });
    expect(run.body.quality_score).toBeGreaterThanOrEqual(70);
    for (const k of ["original", "png", "white_jpg", "shadow"]) {
      const l = run.body.links[k] as { url: string };
      expect(l.url).toContain("ttl=600");
    }
    const get = await h.http().get(`${base(STORE_A)}/${jobId}`).set(bearer(TOKENS.supportA));
    expect(get.status).toBe(200);
    const acc = await post(TOKENS.managerA, `${base(STORE_A)}/${jobId}/accept`);
    expect(acc.body).toMatchObject({ status: "READY", decision: "accepted" });
    const list = await h.http().get(base(STORE_A)).set(bearer(TOKENS.ownerA));
    expect(list.body.items.map((i: { id: string }) => i.id)).toContain(jobId);
  });

  it("is idempotent per upload: a second process does not call the model again", async () => {
    const { jobId } = await newJob();
    await post(TOKENS.ownerA, `${base(STORE_A)}/${jobId}/process`);
    const calls = h.removal.calls;
    const again = await post(TOKENS.ownerA, `${base(STORE_A)}/${jobId}/process`);
    expect(again.status).toBe(200);
    expect(h.removal.calls).toBe(calls);
  });

  it("409s while the original is not uploaded or scanned, and fails an infected one", async () => {
    const none = await newJob(TOKENS.ownerA, STORE_A, "none");
    const r1 = await post(TOKENS.ownerA, `${base(STORE_A)}/${none.jobId}/process`);
    expect(r1.status).toBe(409);
    expect(r1.body.code).toBe("upload_not_ready");
    const infected = await newJob(TOKENS.ownerA, STORE_A, "infected");
    const r2 = await post(TOKENS.ownerA, `${base(STORE_A)}/${infected.jobId}/process`);
    expect(r2.body).toMatchObject({ status: "FAILED", error_code: "infected" });
    expect(h.removal.calls).toBe(0);
  });

  it("sends a low-quality cutout to NEEDS_REVIEW and lets the seller use the original or re-run", async () => {
    const prev = h.removal.statsFor;
    h.removal.statsFor = () => ({ width: 800, height: 800, coverage: 0.5, borderTouch: 0.3, components: 3, holeRatio: 0.12, softEdgeRatio: 0.3, subjectBrightRatio: 0.9, borderBrightRatio: 0.95 });
    const { jobId } = await newJob();
    const run = await post(TOKENS.ownerA, `${base(STORE_A)}/${jobId}/process`);
    h.removal.statsFor = prev;
    expect(run.body.status).toBe("NEEDS_REVIEW");
    expect(run.body.quality_reasons).toEqual(expect.arrayContaining(["subject_cut_by_frame", "multiple_components", "mask_holes", "soft_edges", "white_on_white_risk"]));
    const orig = await post(TOKENS.ownerA, `${base(STORE_A)}/${jobId}/use-original`);
    expect(orig.body.decision).toBe("use_original");
    const re = await post(TOKENS.ownerA, `${base(STORE_A)}/${jobId}/rerun`, { model: "birefnet-general-lite" });
    expect(re.status).toBe(200);
    expect(re.body).toMatchObject({ status: "READY", decision: "none", model_id: "birefnet-general-lite" });
  });

  it("rejects a model outside the allow-list and unknown body fields", async () => {
    const { jobId } = await newJob();
    await post(TOKENS.ownerA, `${base(STORE_A)}/${jobId}/process`);
    expect((await post(TOKENS.ownerA, `${base(STORE_A)}/${jobId}/rerun`, { model: "bria-rmbg-2.0" })).status).toBe(400);
    expect((await post(TOKENS.ownerA, `${base(STORE_A)}/${jobId}/rerun`, { model: "u2net", store_id: STORE_B })).status).toBe(400);
    expect((await post(TOKENS.ownerA, `${base(STORE_A)}/uploads`, { content_type: "image/gif", size_bytes: 10 })).status).toBe(400);
    expect((await post(TOKENS.ownerA, `${base(STORE_A)}/uploads`, { content_type: "image/png", size_bytes: 13 * 1024 * 1024 })).status).toBe(400);
  });

  it("a sidecar failure ends FAILED with a code, never a 500", async () => {
    h.removal.failWith = new BackgroundRemovalError("timeout", "slow");
    const { jobId } = await newJob();
    const r = await post(TOKENS.ownerA, `${base(STORE_A)}/${jobId}/process`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "FAILED", error_code: "timeout" });
    h.removal.failWith = null;
    const re = await post(TOKENS.ownerA, `${base(STORE_A)}/${jobId}/rerun`, { model: "u2net" });
    expect(re.body.status).toBe("READY");
  });

  it("rejects a corrupt image after sanitizing without calling the model", async () => {
    const r0 = await post(TOKENS.ownerA, `${base(STORE_A)}/uploads`, { content_type: "image/png", size_bytes: 12 });
    h.blobs.put(r0.body.upload.upload_id, new TextEncoder().encode("not an image"), "clean");
    const r = await post(TOKENS.ownerA, `${base(STORE_A)}/${r0.body.job_id}/process`);
    expect(r.body).toMatchObject({ status: "FAILED", error_code: "image_unsupported_type" });
    expect(h.removal.calls).toBe(0);
  });
});

describe("kill switch and quota", () => {
  it("blocked switch: process and rerun 503, decisions and reads still work", async () => {
    const { jobId } = await newJob();
    h.flags.set(FLAG_BACKGROUND_REMOVAL, false);
    const r = await post(TOKENS.ownerA, `${base(STORE_A)}/${jobId}/process`);
    expect(r.status).toBe(503);
    expect(r.body.code).toBe("background_removal_disabled");
    expect((await post(TOKENS.ownerA, `${base(STORE_A)}/${jobId}/rerun`, { model: "u2net" })).status).toBe(503);
    expect((await post(TOKENS.ownerA, `${base(STORE_A)}/${jobId}/use-original`)).status).toBe(200);
    expect((await h.http().get(`${base(STORE_A)}/${jobId}`).set(bearer(TOKENS.ownerA))).status).toBe(200);
  });

  it("per-store daily quota answers 429, is isolated per store and resets the next UTC day", async () => {
    const q = await createMediaHarness({ dailyRuns: 3 });
    try {
      const run = async (token: string, store: string) => {
        const up = await q.http().post(`${base(store)}/uploads`).set({ ...bearer(token), ...idemKey() }).send({ content_type: "image/png", size_bytes: TINY_PNG.length });
        q.blobs.put(up.body.upload.upload_id, TINY_PNG, "clean");
        return (await q.http().post(`${base(store)}/${up.body.job_id}/process`).set({ ...bearer(token), ...idemKey() }).send({})).status;
      };
      const a = [await run(TOKENS.ownerA, STORE_A), await run(TOKENS.ownerA, STORE_A), await run(TOKENS.ownerA, STORE_A), await run(TOKENS.ownerA, STORE_A)];
      expect(a).toEqual([200, 200, 200, 429]);
      expect(await run(TOKENS.ownerB, STORE_B)).toBe(200);
      q.clock.advance(24 * 3_600_000);
      expect(await run(TOKENS.ownerA, STORE_A)).toBe(200);
    } finally {
      await q.close();
    }
  });
});

describe("authorization (BOLA / BFLA)", () => {
  it("another seller gets 404 on every job route, indistinguishable from a missing job", async () => {
    const { jobId } = await newJob();
    await post(TOKENS.ownerA, `${base(STORE_A)}/${jobId}/process`);
    const missing = U(424_242);
    const routes: ReadonlyArray<readonly [string, string, unknown]> = [
      ["get", `${base(STORE_A)}/${jobId}`, undefined],
      ["post", `${base(STORE_A)}/${jobId}/process`, {}],
      ["post", `${base(STORE_A)}/${jobId}/accept`, {}],
      ["post", `${base(STORE_A)}/${jobId}/use-original`, {}],
      ["post", `${base(STORE_A)}/${jobId}/rerun`, { model: "u2net" }],
      ["get", base(STORE_A), undefined],
      ["post", `${base(STORE_A)}/uploads`, { content_type: "image/png", size_bytes: 10 }],
    ];
    for (const [m, path, body] of routes) {
      const r = m === "get" ? await h.http().get(path).set(bearer(TOKENS.ownerB)) : await post(TOKENS.ownerB, path, body);
      expect(r.status, `${m} ${path}`).toBe(404);
    }
    // Own store, someone else's job id in the path: also a 404.
    expect((await h.http().get(`${base(STORE_B)}/${jobId}`).set(bearer(TOKENS.ownerB))).status).toBe(404);
    expect((await h.http().get(`${base(STORE_A)}/${missing}`).set(bearer(TOKENS.ownerB))).status).toBe(404);
  });

  it("is 403 for suspended, shopper, no-scope and read-only roles on writes; 401 for the wrong audience", async () => {
    const { jobId } = await newJob();
    for (const t of [TOKENS.suspendedA, TOKENS.shopper, TOKENS.noScopeA]) {
      expect((await h.http().get(`${base(STORE_A)}/${jobId}`).set(bearer(t))).status).toBe(403);
    }
    for (const t of [TOKENS.financeA, TOKENS.supportA, TOKENS.warehouseA]) {
      expect((await post(t, `${base(STORE_A)}/${jobId}/process`)).status, t).toBe(403);
      expect((await post(t, `${base(STORE_A)}/uploads`, { content_type: "image/png", size_bytes: 10 })).status, t).toBe(403);
    }
    expect((await h.http().get(`${base(STORE_A)}/${jobId}`).set(bearer(TOKENS.buyerAudSeller))).status).toBe(401);
    expect((await h.http().get(`${base(STORE_A)}/${jobId}`)).status).toBe(401);
  });

  it("requires an Idempotency-Key on writes", async () => {
    const r = await h.http().post(`${base(STORE_A)}/uploads`).set(bearer(TOKENS.ownerA)).send({ content_type: "image/png", size_bytes: 10 });
    expect(r.status).toBe(400);
  });
});
