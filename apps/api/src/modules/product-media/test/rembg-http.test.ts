import { describe, expect, it } from "vitest";
import { RembgHttpBackgroundRemoval } from "../adapters/rembg-http";
import { BackgroundRemovalError, DEFAULT_CUTOUT_OPTIONS } from "../domain/ports";

const b64 = (bytes: number[]): string => Buffer.from(bytes).toString("base64");
const PNG = b64([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const JPG = b64([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const OK = {
  png_b64: PNG,
  mask_b64: PNG,
  white_jpg_b64: JPG,
  shadow_png_b64: PNG,
  stats: { width: 100, height: 120, coverage: 0.4, border_touch: 0, components: 1, hole_ratio: 0, soft_edge_ratio: 0.01, subject_bright_ratio: 0.1, border_bright_ratio: 0.9 },
  model_id: "u2netp",
  model_version: "rembg-2.0.57+u2netp",
  latency_ms: 321,
};
const json = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
const make = (f: typeof fetch, o: Partial<ConstructorParameters<typeof RembgHttpBackgroundRemoval>[0]> = {}) =>
  new RembgHttpBackgroundRemoval({ baseUrl: "http://bg-removal.internal:8080", allowedHosts: ["bg-removal.internal"], fetch: f, ...o });
const opts = { model: "u2netp" as const, ...DEFAULT_CUTOUT_OPTIONS };
const img = new Uint8Array([1, 2, 3]);
const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "none";
  } catch (e) {
    return e instanceof BackgroundRemovalError ? e.code : "other";
  }
};

describe("RembgHttpBackgroundRemoval", () => {
  it("maps a valid response, sending no redirects and the model in the query", async () => {
    let seen: { url: string; init: RequestInit | undefined } | null = null;
    const f = (async (u: URL | string, init?: RequestInit) => {
      seen = { url: String(u), init };
      return json(OK);
    }) as typeof fetch;
    const r = await make(f).cutout(img, opts);
    expect(r).toMatchObject({ modelId: "u2netp", latencyMs: 321, stats: { coverage: 0.4, borderTouch: 0, holeRatio: 0 } });
    expect(r.shadowPng).not.toBeNull();
    expect(seen!.url).toContain("/v1/cutout?model=u2netp");
    expect(seen!.init?.redirect).toBe("error");
  });
  it("refuses a base URL that is not allow-listed, has credentials or is not http(s)", () => {
    const f = (async () => json(OK)) as typeof fetch;
    expect(() => make(f, { baseUrl: "http://evil.example" })).toThrow(RangeError);
    expect(() => make(f, { baseUrl: "http://u:p@bg-removal.internal" })).toThrow(RangeError);
    expect(() => make(f, { baseUrl: "file:///etc/passwd" })).toThrow(RangeError);
  });
  it("classifies failures", async () => {
    expect(await codeOf(make((async () => json({}, { status: 503 })) as typeof fetch).cutout(img, opts))).toBe("provider_error");
    expect(await codeOf(make((async () => json({}, { status: 422 })) as typeof fetch).cutout(img, opts))).toBe("image_rejected");
    expect(await codeOf(make((async () => json({ ...OK, extra: 1 })) as typeof fetch).cutout(img, opts))).toBe("invalid_response");
    expect(await codeOf(make((async () => json({ ...OK, png_b64: b64([1, 2, 3, 4, 5, 6, 7, 8]) })) as typeof fetch).cutout(img, opts))).toBe("invalid_response");
    expect(await codeOf(make((async () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } })) as typeof fetch).cutout(img, opts))).toBe("invalid_response");
    expect(await codeOf(make((async () => { throw new TypeError("redirect"); }) as typeof fetch).cutout(img, opts))).toBe("provider_error");
    expect(await codeOf(make((async () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); }) as typeof fetch).cutout(img, opts))).toBe("timeout");
  });
  it("caps request and response sizes", async () => {
    expect(await codeOf(make((async () => json(OK)) as typeof fetch, { maxRequestBytes: 2 }).cutout(img, opts))).toBe("too_large");
    expect(await codeOf(make((async () => json(OK)) as typeof fetch, { maxResponseBytes: 50 }).cutout(img, opts))).toBe("invalid_response");
  });
});
