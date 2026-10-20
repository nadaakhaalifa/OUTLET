/**
 * Development-only CutoutPort that talks to the local bg-removal sidecar (apps/ml-services/bg-removal) directly.
 * Selected only when __DEV__ is true, EXPO_PUBLIC_DEV_CUTOUT_URL is set and no API base URL is configured
 * (see state.ts). It never ships in a release build and only accepts loopback / private-LAN http origins.
 */
import { z } from "zod";
import { registerDevHint } from "../../services/dev-hints";
import {
  CUTOUT_MODELS, CutoutError, fakeJobId, isSettled, MAX_RUNS,
  type CutoutBlock, type CutoutJob, type CutoutModel, type CutoutPort, type CutoutVersion, type RefineParams, type RefineStroke,
} from "./model";
import { assessQuality, isReady } from "./quality";

const MAX_BYTES = 12 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 40_000;

/** Returns the normalised origin for an allowed dev URL (http on 127.0.0.1, localhost, 10.x or 192.168.x.x), else null. */
export function validateSidecarUrl(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (u.protocol !== "http:" || u.username !== "" || u.password !== "") return null;
  if (u.search !== "" || u.hash !== "" || (u.pathname !== "/" && u.pathname !== "")) return null;
  const h = u.hostname;
  const octet = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
  const ok = h === "127.0.0.1" || h === "localhost"
    || new RegExp(`^10\\.${octet}\\.${octet}\\.${octet}$`).test(h)
    || new RegExp(`^192\\.168\\.${octet}\\.${octet}$`).test(h);
  return ok ? u.origin : null;
}

const Stats = z.object({
  coverage: z.number(), border_touch: z.number(), components: z.number(), hole_ratio: z.number(),
  soft_edge_ratio: z.number(), subject_bright_ratio: z.number(), border_bright_ratio: z.number(),
});
const CutoutBody = z.object({
  png_b64: z.string().min(1), white_jpg_b64: z.string().min(1), shadow_png_b64: z.string().nullable().optional(),
  stats: Stats, model_id: z.string(), background_render_b64: z.string().nullable().optional(),
});
const Health = z.object({ status: z.string(), models_available: z.array(z.string()), default_model: z.string() });

export interface DevSidecarDeps {
  readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  readonly sleep?: (ms: number) => Promise<void>;
}

interface Entry {
  job: CutoutJob;
  body: Blob;
  mime: string;
  error: CutoutBlock | null;
  runs: number;
  /** Saved derivatives (in memory only); version 1 is the automatic cutout of the latest run. */
  versions: CutoutVersion[];
}

const asModel = (m: string): CutoutModel | null => (CUTOUT_MODELS as readonly string[]).includes(m) ? (m as CutoutModel) : null;

function mimeOf(blob: Blob, uri: string): string {
  if (blob.type === "image/png" || blob.type === "image/webp" || blob.type === "image/jpeg") return blob.type;
  const l = uri.toLowerCase().split("?")[0] ?? "";
  if (l.endsWith(".png")) return "image/png";
  if (l.endsWith(".webp")) return "image/webp";
  return "image/jpeg";
}

export class DevSidecarCutoutPort implements CutoutPort {
  private readonly entries = new Map<string, Entry>();
  private seq = 0;
  constructor(private readonly origin: string, private readonly deps: DevSidecarDeps = {}) {
    registerDevHint("cutout", `Background removal uses the local sidecar at ${origin}. Start it with: tooling/media/run-sidecar.sh`);
  }

  private f(url: string, init?: RequestInit): Promise<Response> { return (this.deps.fetch ?? fetch)(url, init); }

  private async call(url: string, init: RequestInit = {}): Promise<Response> {
    const ac = typeof AbortController === "undefined" ? null : new AbortController();
    const timer = ac === null ? null : setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await this.f(url, ac === null ? init : { ...init, signal: ac.signal });
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") throw new CutoutError("timeout");
      throw new CutoutError("service_down");
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  private async health(): Promise<readonly CutoutModel[]> {
    const res = await this.call(`${this.origin}/healthz`);
    if (!res.ok) throw new CutoutError("service_down");
    let parsed: z.infer<typeof Health>;
    try { parsed = Health.parse(await res.json()); } catch { throw new CutoutError("failed"); }
    return parsed.models_available.flatMap((m) => { const k = asModel(m); return k === null ? [] : [k]; });
  }

  private async process(body: Blob, mime: string, model: CutoutModel): Promise<{ job: Partial<CutoutJob> }> {
    const res = await this.call(`${this.origin}/v1/cutout?model=${encodeURIComponent(model)}&shadow=true`, {
      method: "POST", headers: { "content-type": mime }, body,
    });
    if (!res.ok) {
      if (res.status === 503) throw new CutoutError("model_missing");
      if (res.status === 429) throw new CutoutError("busy");
      if (res.status === 504) throw new CutoutError("timeout");
      if (res.status === 413) throw new CutoutError("too_large");
      throw new CutoutError("failed");
    }
    return { job: this.toPatch(await this.parseBody(res), model) };
  }

  private async parseBody(res: Response): Promise<z.infer<typeof CutoutBody>> {
    try { return CutoutBody.parse(await res.json()); } catch { throw new CutoutError("failed"); }
  }

  private toPatch(parsed: z.infer<typeof CutoutBody>, model: CutoutModel): Partial<CutoutJob> {
    const s = parsed.stats;
    const q = assessQuality({
      coverage: s.coverage, borderTouch: s.border_touch, components: s.components, holeRatio: s.hole_ratio,
      softEdgeRatio: s.soft_edge_ratio, subjectBrightRatio: s.subject_bright_ratio, borderBrightRatio: s.border_bright_ratio,
    });
    return {
      status: isReady(q) ? "READY" : "NEEDS_REVIEW", qualityScore: q.score, reasons: q.reasons, model: asModel(parsed.model_id) ?? model,
      cutoutUrl: `data:image/png;base64,${parsed.png_b64}`, whiteUrl: `data:image/jpeg;base64,${parsed.white_jpg_b64}`,
      errorCode: null,
    };
  }

  private run(jobId: string, model: CutoutModel): void {
    const e = this.entries.get(jobId);
    if (e === undefined) return;
    e.error = null;
    this.process(e.body, e.mime, model).then(
      (r) => {
        e.job = { ...e.job, ...r.job, version: 1 };
        e.versions = [{ version: 1, kind: "original", qualityScore: e.job.qualityScore, reasons: e.job.reasons, cutoutUrl: e.job.cutoutUrl, whiteUrl: e.job.whiteUrl, createdAtMs: Date.now() }];
      },
      (err: unknown) => { e.error = err instanceof CutoutError ? err.kind : "failed"; },
    );
  }

  async start(uri: string): Promise<CutoutJob> {
    let blob: Blob;
    try {
      const res = await this.call(uri);
      if (!res.ok) throw new CutoutError("failed");
      blob = await res.blob();
    } catch (e) {
      // Reading the local picked file failing is not "the service is down".
      throw e instanceof CutoutError && e.kind !== "service_down" ? e : new CutoutError("failed");
    }
    if (blob.size > MAX_BYTES) throw new CutoutError("too_large");
    const available = await this.health();
    const model = available.includes("u2netp") ? "u2netp" : available[0];
    if (model === undefined) throw new CutoutError("model_missing");
    const jobId = fakeJobId(++this.seq);
    const job: CutoutJob = {
      jobId, status: "PROCESSING", decision: "none", qualityScore: null, reasons: [], model, attempts: 1, errorCode: null,
      originalUrl: uri, cutoutUrl: null, whiteUrl: null, linksExpireAtMs: null, simulated: false, availableModels: available,
    };
    this.entries.set(jobId, { job, body: blob, mime: mimeOf(blob, uri), error: null, runs: 1, versions: [] });
    this.run(jobId, model);
    return job;
  }

  async refresh(jobId: string): Promise<CutoutJob> {
    const e = this.entries.get(jobId);
    if (e === undefined) throw new CutoutError("failed");
    if (e.error !== null) {
      const kind = e.error;
      e.error = null;
      e.job = { ...e.job, status: "FAILED", errorCode: kind };
      throw new CutoutError(kind);
    }
    return e.job;
  }

  private entry(jobId: string): Entry {
    const e = this.entries.get(jobId);
    if (e === undefined) throw new CutoutError("failed");
    return e;
  }

  async accept(jobId: string, version?: number): Promise<CutoutJob> {
    if (version !== undefined) await this.restoreVersion(jobId, version);
    const e = this.entry(jobId);
    e.job = { ...e.job, decision: "accepted", reviewed: version !== undefined ? true : e.job.reviewed ?? false };
    return e.job;
  }
  async useOriginal(jobId: string): Promise<CutoutJob> { const e = this.entry(jobId); e.job = { ...e.job, decision: "use_original" }; return e.job; }

  async rerun(jobId: string, model: CutoutModel): Promise<CutoutJob> {
    const e = this.entry(jobId);
    if (e.runs >= MAX_RUNS) throw new CutoutError("attempts");
    const avail = e.job.availableModels ?? CUTOUT_MODELS;
    if (!CUTOUT_MODELS.includes(model) || !avail.includes(model)) throw new CutoutError("failed");
    if (!isSettled(e.job.status) && e.error === null) throw new CutoutError("busy");
    e.runs += 1;
    e.job = { ...e.job, status: "PROCESSING", decision: "none", model, attempts: e.runs, cutoutUrl: null, whiteUrl: null, qualityScore: null, reasons: [], errorCode: null };
    this.run(jobId, model);
    return e.job;
  }

  /**
   * Re-derives the cutout from the original photo with the seller's strokes and edge settings (POST /v1/refine).
   * Each call is relative to the automatic cutout, so the full stroke list is sent every time.
   */
  async refine(jobId: string, strokes: readonly RefineStroke[], params: RefineParams): Promise<CutoutJob> {
    const e = this.entry(jobId);
    if (!isSettled(e.job.status) || e.job.status === "FAILED") throw new CutoutError("busy");
    const body = JSON.stringify({
      image_b64: await blobToBase64(e.body), strokes, feather_px: params.featherPx, smooth: params.smooth,
      edge_shift_px: params.edgeShiftPx, background: params.background,
    });
    const res = await this.call(`${this.origin}/v1/refine`, { method: "POST", headers: { "content-type": "application/json" }, body });
    if (!res.ok) {
      if (res.status === 404 || res.status === 405) throw new CutoutError("service_down");
      if (res.status === 503) throw new CutoutError("model_missing");
      if (res.status === 429) throw new CutoutError("busy");
      if (res.status === 504) throw new CutoutError("timeout");
      if (res.status === 413) throw new CutoutError("too_large");
      throw new CutoutError("failed");
    }
    const patch = this.toPatch(await this.parseBody(res), e.job.model ?? "u2netp");
    const version = Math.max(0, ...e.versions.map((v) => v.version)) + 1;
    const v: CutoutVersion = {
      version, kind: "edit", qualityScore: patch.qualityScore ?? null, reasons: patch.reasons ?? [],
      cutoutUrl: patch.cutoutUrl ?? null, whiteUrl: patch.whiteUrl ?? null, createdAtMs: Date.now(),
    };
    e.versions.push(v);
    e.job = { ...e.job, ...patch, version, decision: "none" };
    return e.job;
  }

  async versions(jobId: string): Promise<readonly CutoutVersion[]> { return [...this.entry(jobId).versions]; }

  async restoreVersion(jobId: string, version: number): Promise<CutoutJob> {
    const e = this.entry(jobId);
    const v = e.versions.find((x) => x.version === version);
    if (v === undefined) throw new CutoutError("failed");
    e.job = { ...e.job, version, qualityScore: v.qualityScore, reasons: v.reasons, cutoutUrl: v.cutoutUrl, whiteUrl: v.whiteUrl };
    return e.job;
  }
}

/** Blob -> base64 without a data-URL prefix (FileReader exists in React Native and the browser). */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new CutoutError("failed"));
    r.onloadend = () => {
      const out = typeof r.result === "string" ? r.result : "";
      const i = out.indexOf(",");
      resolve(i >= 0 ? out.slice(i + 1) : out);
    };
    r.readAsDataURL(blob);
  });
}
