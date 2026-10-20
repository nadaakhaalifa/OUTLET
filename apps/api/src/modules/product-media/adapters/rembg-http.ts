import { z } from "zod";
import {
  BackgroundRemovalError,
  REFINE_LIMITS,
  type BackgroundRemovalPort,
  type CutoutOptions,
  type CutoutResult,
  type RefineRequest,
  type RefineResult,
} from "../domain/ports";

export interface RembgHttpOptions {
  /** Internal URL of the sidecar, e.g. http://bg-removal.internal:8080 */
  readonly baseUrl: string;
  /** Exact host names (no wildcards) the adapter may call. The base URL's host must be one of them. */
  readonly allowedHosts: readonly string[];
  readonly timeoutMs?: number;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  /** Injected for tests. */
  readonly fetch?: typeof fetch;
}

const Ratio = z.number().min(0).max(1);
const ResponseSchema = z
  .object({
    png_b64: z.string().min(8),
    mask_b64: z.string().min(8),
    white_jpg_b64: z.string().min(8),
    shadow_png_b64: z.string().min(8).nullable(),
    stats: z
      .object({
        width: z.number().int().min(1).max(8192),
        height: z.number().int().min(1).max(8192),
        coverage: Ratio,
        border_touch: Ratio,
        components: z.number().int().min(0).max(1000),
        hole_ratio: Ratio,
        soft_edge_ratio: Ratio,
        subject_bright_ratio: Ratio,
        border_bright_ratio: Ratio,
      })
      .strict(),
    model_id: z.string().min(1).max(60),
    model_version: z.string().min(1).max(100),
    latency_ms: z.number().int().min(0).max(600_000),
  })
  .strict();

const RefineResponseSchema = ResponseSchema.extend({ background_render_b64: z.string().min(8).nullable().optional() }).strict();

function validate<S extends z.ZodType>(schema: S, raw: unknown): z.infer<S> {
  const r = schema.safeParse(raw);
  if (!r.success) throw new BackgroundRemovalError("invalid_response", "sidecar response failed validation");
  return r.data;
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
const JPG_MAGIC = [0xff, 0xd8, 0xff];
const hasMagic = (b: Uint8Array, m: readonly number[]): boolean => m.every((v, i) => b[i] === v);

/** Calls the self-hosted rembg sidecar (apps/ml-services/bg-removal) over an internal, allow-listed URL. */
export class RembgHttpBackgroundRemoval implements BackgroundRemovalPort {
  readonly configured = true;
  readonly residency = "in_region" as const;
  private readonly base: URL;
  private readonly timeoutMs: number;
  private readonly maxReq: number;
  private readonly maxRes: number;
  private readonly doFetch: typeof fetch;

  constructor(o: RembgHttpOptions) {
    const u = new URL(o.baseUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new RangeError("sidecar url must be http(s)");
    if (u.username !== "" || u.password !== "") throw new RangeError("sidecar url must not carry credentials");
    if (!o.allowedHosts.includes(u.hostname)) throw new RangeError("sidecar host is not allow-listed");
    this.base = u;
    this.timeoutMs = o.timeoutMs ?? 30_000;
    this.maxReq = o.maxRequestBytes ?? 12 * 1024 * 1024;
    this.maxRes = o.maxResponseBytes ?? 48 * 1024 * 1024;
    this.doFetch = o.fetch ?? fetch;
  }

  async cutout(image: Uint8Array, o: CutoutOptions): Promise<CutoutResult> {
    if (image.length === 0 || image.length > this.maxReq) throw new BackgroundRemovalError("too_large", "image size out of range");
    const url = new URL("/v1/cutout", this.base);
    url.searchParams.set("model", o.model);
    url.searchParams.set("feather_px", String(o.featherPx));
    url.searchParams.set("padding_ratio", String(o.paddingRatio));
    url.searchParams.set("white_max_side", String(o.whiteMaxSide));
    url.searchParams.set("shadow", o.shadow ? "true" : "false");
    const parsed = validate(ResponseSchema, await this.call(url, new Uint8Array(image), "application/octet-stream"));
    return this.decode(parsed);
  }

  async refine(image: Uint8Array, r: RefineRequest): Promise<RefineResult> {
    if (image.length === 0 || image.length > this.maxReq) throw new BackgroundRemovalError("too_large", "image size out of range");
    if (r.mask !== null && r.mask.length > this.maxReq) throw new BackgroundRemovalError("too_large", "mask size out of range");
    // Same bounds the API enforces; a violation here is a programming error, not a sidecar fault.
    let points = 0;
    if (r.strokes.length > REFINE_LIMITS.maxStrokes) throw new BackgroundRemovalError("image_rejected", "too many strokes");
    for (const s of r.strokes) {
      points += s.points.length;
      if (s.points.length > REFINE_LIMITS.maxPointsPerStroke || s.radius <= 0 || s.radius > REFINE_LIMITS.maxRadius) {
        throw new BackgroundRemovalError("image_rejected", "stroke out of range");
      }
    }
    if (points > REFINE_LIMITS.maxTotalPoints) throw new BackgroundRemovalError("image_rejected", "too many points");
    const body = JSON.stringify({
      image_b64: Buffer.from(image).toString("base64"),
      ...(r.mask === null ? {} : { mask_b64: Buffer.from(r.mask).toString("base64") }),
      strokes: r.strokes.map((s) => ({ mode: s.mode, radius: s.radius, points: s.points.map((p) => [p[0], p[1]]) })),
      feather_px: r.featherPx,
      smooth: r.smooth,
      edge_shift_px: r.edgeShiftPx,
      background: r.background,
    });
    if (Buffer.byteLength(body) > this.maxReq * 3) throw new BackgroundRemovalError("too_large", "request too large");
    const raw = await this.call(new URL("/v1/refine", this.base), body, "application/json");
    const parsed = validate(RefineResponseSchema, raw);
    const base = this.decode(parsed);
    let render: Uint8Array | null = null;
    if (parsed.background_render_b64 !== undefined && parsed.background_render_b64 !== null) {
      const b = Buffer.from(parsed.background_render_b64, "base64");
      if (!hasMagic(b, PNG_MAGIC) && !hasMagic(b, JPG_MAGIC)) throw new BackgroundRemovalError("invalid_response", "sidecar returned an unexpected image format");
      render = new Uint8Array(b);
    }
    return { ...base, backgroundRender: render };
  }

  /** POST with the shared guards (redirect error, timeout, status mapping, content type, size cap); returns validated-by-caller JSON. */
  private async call(url: URL, body: Uint8Array<ArrayBuffer> | string, contentType: string): Promise<unknown> {
    let res: Response;
    try {
      res = await this.doFetch(url, {
        method: "POST",
        body,
        headers: { "content-type": contentType, accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      throw new BackgroundRemovalError(timedOut ? "timeout" : "provider_error", timedOut ? "sidecar timed out" : "sidecar unreachable");
    }
    if (res.status === 413 || res.status === 422) throw new BackgroundRemovalError("image_rejected", `sidecar rejected the image (${res.status})`);
    if (!res.ok) throw new BackgroundRemovalError("provider_error", `sidecar answered ${res.status}`);
    const type = res.headers.get("content-type") ?? "";
    if (!type.toLowerCase().startsWith("application/json")) throw new BackgroundRemovalError("invalid_response", "unexpected content type");
    const text = await this.readCapped(res);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new BackgroundRemovalError("invalid_response", "sidecar response failed validation");
    }
  }

  private decode(parsed: z.infer<typeof ResponseSchema>): CutoutResult {
    const png = Buffer.from(parsed.png_b64, "base64");
    const mask = Buffer.from(parsed.mask_b64, "base64");
    const jpg = Buffer.from(parsed.white_jpg_b64, "base64");
    const shadow = parsed.shadow_png_b64 === null ? null : Buffer.from(parsed.shadow_png_b64, "base64");
    if (!hasMagic(png, PNG_MAGIC) || !hasMagic(mask, PNG_MAGIC) || !hasMagic(jpg, JPG_MAGIC) || (shadow !== null && !hasMagic(shadow, PNG_MAGIC))) {
      throw new BackgroundRemovalError("invalid_response", "sidecar returned an unexpected image format");
    }
    const s = parsed.stats;
    return {
      png: new Uint8Array(png),
      mask: new Uint8Array(mask),
      whiteJpg: new Uint8Array(jpg),
      shadowPng: shadow === null ? null : new Uint8Array(shadow),
      stats: {
        width: s.width,
        height: s.height,
        coverage: s.coverage,
        borderTouch: s.border_touch,
        components: s.components,
        holeRatio: s.hole_ratio,
        softEdgeRatio: s.soft_edge_ratio,
        subjectBrightRatio: s.subject_bright_ratio,
        borderBrightRatio: s.border_bright_ratio,
      },
      modelId: parsed.model_id,
      modelVersion: parsed.model_version,
      latencyMs: parsed.latency_ms,
    };
  }

  private async readCapped(res: Response): Promise<string> {
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > this.maxRes) throw new BackgroundRemovalError("invalid_response", "response too large");
    if (res.body === null) throw new BackgroundRemovalError("invalid_response", "empty response");
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > this.maxRes) {
        await reader.cancel();
        throw new BackgroundRemovalError("invalid_response", "response too large");
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  }
}
