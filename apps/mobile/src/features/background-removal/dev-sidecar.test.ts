import { describe, expect, it } from "vitest";
import { DevSidecarCutoutPort, validateSidecarUrl } from "./dev-sidecar";
import { CutoutError, pollUntilSettled, otherModels, MAX_RUNS } from "./model";

const ORIGIN = "http://127.0.0.1:8099";
const STATS = { width: 10, height: 10, coverage: 0.4, border_touch: 0, components: 1, hole_ratio: 0, soft_edge_ratio: 0.01, subject_bright_ratio: 0.1, border_bright_ratio: 0.9 };
const OK_BODY = { png_b64: "AAA", mask_b64: "BBB", white_jpg_b64: "CCC", shadow_png_b64: null, stats: STATS, model_id: "u2netp", model_version: "1", latency_ms: 5 };

interface Opts { health?: unknown; healthStatus?: number; cutout?: () => Response; down?: boolean; photo?: Blob; calls?: string[] }
function fakeFetch(o: Opts = {}) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    o.calls?.push(`${init?.method ?? "GET"} ${url}`);
    if (url.startsWith("file://")) return new Response(o.photo ?? new Blob([new Uint8Array(8)], { type: "image/jpeg" }));
    if (o.down === true) throw new TypeError("network request failed");
    if (url.endsWith("/healthz")) return Response.json(o.health ?? { status: "ok", models_available: ["u2netp", "u2net"], default_model: "u2netp" }, { status: o.healthStatus ?? 200 });
    return o.cutout?.() ?? Response.json(OK_BODY);
  };
}
const port = (o?: Opts) => new DevSidecarCutoutPort(ORIGIN, { fetch: fakeFetch(o) });

describe("validateSidecarUrl", () => {
  it("allows loopback and private LAN http only", () => {
    expect(validateSidecarUrl("http://127.0.0.1:8099")).toBe(ORIGIN);
    expect(validateSidecarUrl("http://localhost:8099/")).toBe("http://localhost:8099");
    expect(validateSidecarUrl("http://10.0.0.5:8099")).toBe("http://10.0.0.5:8099");
    expect(validateSidecarUrl("http://192.168.1.20:8099")).toBe("http://192.168.1.20:8099");
  });
  it("rejects everything else", () => {
    for (const bad of [
      "https://127.0.0.1:8099", "http://example.com", "http://172.16.0.1", "http://192.169.1.1", "http://10.0.0.256",
      "http://127.0.0.1.evil.com", "http://user:pw@127.0.0.1", "ftp://127.0.0.1", "http://127.0.0.1/path", "http://127.0.0.1?x=1",
      "not a url", "", "   ", "http://[::1]:8099", "http://0.0.0.0:8099",
    ]) expect(validateSidecarUrl(bad), bad).toBeNull();
    expect(validateSidecarUrl(undefined)).toBeNull();
    expect(validateSidecarUrl(null)).toBeNull();
  });
});

describe("DevSidecarCutoutPort", () => {
  it("success: posts raw bytes, builds data URIs, scores locally", async () => {
    const calls: string[] = [];
    const p = port({ calls });
    const first = await p.start("file:///a.jpg");
    expect(first.status).toBe("PROCESSING");
    expect(first.simulated).toBe(false);
    expect(first.availableModels).toEqual(["u2netp", "u2net"]);
    const done = await pollUntilSettled(p, first, { sleep: async () => { await Promise.resolve(); await Promise.resolve(); } });
    expect(done.status).toBe("READY");
    expect(done.qualityScore).toBe(100);
    expect(done.cutoutUrl).toBe("data:image/png;base64,AAA");
    expect(done.whiteUrl).toBe("data:image/jpeg;base64,CCC");
    expect(calls).toContain(`POST ${ORIGIN}/v1/cutout?model=u2netp&shadow=true`);
    expect(otherModels(done)).toEqual(["u2net"]);
  });
  it("sidecar down -> service_down", async () => {
    await expect(port({ down: true }).start("file:///a.jpg")).rejects.toMatchObject({ kind: "service_down" });
  });
  it("429 busy, 503 model missing, 504 timeout surface on refresh", async () => {
    for (const [status, kind] of [[429, "busy"], [503, "model_missing"], [504, "timeout"]] as const) {
      const p = port({ cutout: () => new Response("{}", { status }) });
      const j = await p.start("file:///a.jpg");
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      await expect(p.refresh(j.jobId)).rejects.toMatchObject({ kind });
    }
  });
  it("malformed JSON -> failed", async () => {
    const p = port({ cutout: () => new Response("not json", { status: 200 }) });
    const j = await p.start("file:///a.jpg");
    await new Promise((r) => setTimeout(r, 0));
    await expect(p.refresh(j.jobId)).rejects.toMatchObject({ kind: "failed" });
  });
  it("oversize photo is refused before any request", async () => {
    const calls: string[] = [];
    const big = { size: 12 * 1024 * 1024 + 1, type: "image/jpeg" } as Blob;
    const p = new DevSidecarCutoutPort(ORIGIN, {
      fetch: async (url) => { calls.push(url); return { ok: true, status: 200, blob: async () => big } as unknown as Response; },
    });
    await expect(p.start("file:///big.jpg")).rejects.toBeInstanceOf(CutoutError);
    expect(calls).toEqual(["file:///big.jpg"]);
  });
  it("model choice limited to installed models and runs capped at 5", async () => {
    const p = port({ health: { status: "ok", models_available: ["u2netp"], default_model: "u2netp" } });
    const j = await p.start("file:///a.jpg");
    await new Promise((r) => setTimeout(r, 0));
    await expect(p.rerun(j.jobId, "u2net")).rejects.toMatchObject({ kind: "failed" });
    for (let i = 1; i < MAX_RUNS; i++) { await p.rerun(j.jobId, "u2netp"); await new Promise((r) => setTimeout(r, 0)); }
    await expect(p.rerun(j.jobId, "u2netp")).rejects.toMatchObject({ kind: "attempts" });
  });
  it("healthz non-200 -> service_down", async () => {
    await expect(port({ healthStatus: 500 }).start("file:///a.jpg")).rejects.toMatchObject({ kind: "service_down" });
  });
});
