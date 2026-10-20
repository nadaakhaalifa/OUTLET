import { describe, expect, it } from "vitest";
import { createClient, type FetchLike } from "../../services/api-client";
import type { AdapterContext } from "../../services/wire";
import { ApiCutoutPort, mapCutoutError } from "./api";
import { InMemoryCutoutPort } from "./fake";
import { CUTOUT_MODELS, CutoutError, canRerun, linksExpired, otherModels, pollDelayMs, pollUntilSettled, reasonKey, viewOf, type CutoutJob } from "./model";

const noSleep = async () => undefined;
const STORE = "0192f3a4-5b6c-7d8e-9f01-23456789ab01";
const JOB = "0192f3a4-5b6c-7d8e-9f01-23456789ab02";

describe("model", () => {
  it("backs off 1s -> 8s cap", () => {
    expect([0, 1, 2, 3, 9].map(pollDelayMs)).toEqual([1000, 1500, 2250, 3375, 8000]);
  });
  it("maps unknown reasons to a generic line, never raw codes", () => {
    expect(reasonKey("white_on_white_risk")).toBe("white_on_white_risk");
    expect(reasonKey("surprise")).toBe("other");
  });
  it("viewOf: unavailable, working, review, accepted", async () => {
    expect(viewOf(null, "disabled", false).phase).toBe("unavailable");
    expect(viewOf(null, null, true).phase).toBe("working");
    const p = new InMemoryCutoutPort({ outcome: "review", processingPolls: 0 });
    const j = await pollUntilSettled(p, await p.start("file://a.jpg"), { sleep: noSleep });
    expect(viewOf(j, null, false)).toEqual({ phase: "review", display: "original", canToggle: true });
    expect(viewOf(await p.accept(j.jobId), null, false)).toEqual({ phase: "accepted", display: "cutout", canToggle: true });
  });
  it("other models exclude the current one and rerun stops at 5 runs", async () => {
    const p = new InMemoryCutoutPort({ processingPolls: 0 });
    const j = await pollUntilSettled(p, await p.start("file://a.jpg"), { sleep: noSleep });
    expect(otherModels(j)).toEqual(CUTOUT_MODELS.filter((m) => m !== "u2netp"));
    expect(canRerun({ ...j, attempts: 5 })).toBe(false);
  });
  it("links expire 5 s early", () => {
    const j = { linksExpireAtMs: 10_000 } as CutoutJob;
    expect(linksExpired(j, 4_999)).toBe(false);
    expect(linksExpired(j, 5_000)).toBe(true);
  });
  it("polling stops when cancelled and when the budget is spent", async () => {
    const p = new InMemoryCutoutPort({ processingPolls: 100 });
    const first = await p.start("file://a.jpg");
    const spent = await pollUntilSettled(p, first, { sleep: noSleep, maxAttempts: 3 });
    expect(spent.status).toBe("PROCESSING");
    expect((await pollUntilSettled(p, first, { sleep: noSleep, cancelled: () => true })).status).toBe("PROCESSING");
  });
});

describe("fake port", () => {
  it("is deterministic and flags itself simulated", async () => {
    const a = new InMemoryCutoutPort({ processingPolls: 1 });
    const b = new InMemoryCutoutPort({ processingPolls: 1 });
    const ja = await a.start("file://x.jpg");
    expect(ja.jobId).toBe((await b.start("file://x.jpg")).jobId);
    expect(ja.simulated).toBe(true);
    const done = await pollUntilSettled(a, ja, { sleep: noSleep });
    expect(done).toMatchObject({ status: "READY", qualityScore: 91 });
  });
  it("blocked outcomes throw typed errors", async () => {
    await expect(new InMemoryCutoutPort({ outcome: "quota" }).start("x")).rejects.toMatchObject({ kind: "quota" });
    await expect(new InMemoryCutoutPort({ outcome: "not_configured" }).start("x")).rejects.toBeInstanceOf(CutoutError);
  });
});

function api(handlers: Record<string, (b: unknown) => { status?: number; body: unknown }>) {
  const calls: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    const key = `${init?.method ?? "GET"} ${u.pathname}`;
    calls.push(key);
    const h = handlers[key];
    if (h === undefined) return new Response(JSON.stringify({ type: "/problems/not-found", title: "nf", status: 404 }), { status: 404, headers: { "Content-Type": "application/problem+json" } });
    const r = h(typeof init?.body === "string" ? JSON.parse(init.body) : undefined);
    const status = r.status ?? 200;
    return new Response(JSON.stringify(r.body), { status, headers: { "Content-Type": status >= 400 ? "application/problem+json" : "application/json" } });
  };
  const client = createClient({ baseUrl: "https://api.test", fetch, getToken: () => "tok", sleep: async () => undefined, randomBytes: (n) => new Uint8Array(n).fill(3), maxRetries: 0 });
  const ctx: AdapterContext = { client, locale: () => "en", nowMs: () => 0, deviceId: () => "install-device-1" };
  return { ctx, calls };
}
const TS = "2026-10-12T10:00:00Z";
const jobBody = (over: Record<string, unknown> = {}) => ({
  id: JOB, store_id: STORE, status: "READY", decision: "none", requested_model: "u2netp", model_id: "u2netp", model_version: "1", quality_score: 82,
  quality_reasons: ["soft_edges"], latency_ms: 900, error_code: null, attempts: 1, attached_product_id: null, version: 2, created_at: TS, updated_at: TS,
  links: { original: { url: "https://s.test/o", expires_at: "2026-10-12T10:10:00Z" }, png: { url: "https://s.test/c.png", expires_at: "2026-10-12T10:10:00Z" }, white_jpg: null, shadow: null }, ...over,
});
const BASE = `/v1/seller/stores/${STORE}/product-media`;

describe("ApiCutoutPort", () => {
  it("uploads, processes with scan retries, then reads, accepts and reruns", async () => {
    let tries = 0;
    const { ctx, calls } = api({
      [`POST ${BASE}/uploads`]: () => ({ status: 201, body: { job_id: JOB, status: "PENDING", upload: { upload_id: "u1", url: "https://up.test/put", headers: {}, expires_at: "2026-10-12T10:15:00Z" } } }),
      [`POST ${BASE}/${JOB}/process`]: () => (++tries < 2 ? { status: 409, body: { type: "/problems/upload-not-ready", title: "x", status: 409, code: "upload_not_ready" } } : { body: jobBody() }),
      [`GET ${BASE}/${JOB}`]: () => ({ body: jobBody() }),
      [`POST ${BASE}/${JOB}/accept`]: () => ({ body: jobBody({ decision: "accepted" }) }),
      [`POST ${BASE}/${JOB}/rerun`]: (b) => ({ body: jobBody({ status: "PENDING", requested_model: (b as { model: string }).model, quality_score: null, attempts: 2 }) }),
    });
    const f = async (input: string) => (new URL(input).host === "up.test" ? new Response(null, { status: 200 }) : new Response(new Blob(["x"], { type: "image/jpeg" })));
    const port = new ApiCutoutPort(ctx, STORE, { fetch: f, sleep: noSleep });
    const j = await port.start("file://a.jpg");
    expect(j).toMatchObject({ status: "READY", qualityScore: 82, cutoutUrl: "https://s.test/c.png", simulated: false });
    expect(tries).toBe(2);
    expect((await port.refresh(JOB)).reasons).toEqual(["soft_edges"]);
    expect((await port.accept(JOB)).decision).toBe("accepted");
    expect((await port.rerun(JOB, "u2net")).status).toBe("PENDING");
    expect(calls).toContain(`POST ${BASE}/${JOB}/rerun`);
  });
  it("maps 503 codes, 429 and 409 attempts", async () => {
    const mk = (status: number, code: string) => api({ [`GET ${BASE}/${JOB}`]: () => ({ status, body: { type: "/p", title: "t", status, code } }) });
    const kind = async (status: number, code: string) => {
      const { ctx } = mk(status, code);
      return new ApiCutoutPort(ctx, STORE).refresh(JOB).catch((e: unknown) => (e as CutoutError).kind);
    };
    expect(await kind(503, "background_removal_disabled")).toBe("disabled");
    expect(await kind(503, "provider_not_configured")).toBe("not_configured");
    expect(await kind(429, "quota_exceeded")).toBe("quota");
    expect(await kind(409, "attempts_exceeded")).toBe("attempts");
    expect(() => mapCutoutError(new TypeError("net"))).toThrowError(CutoutError);
  });
});
