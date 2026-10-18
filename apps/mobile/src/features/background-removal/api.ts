/** Generated-client adapter for CutoutPort. Originals and derivatives are private; only signed links come back. */
import { ApiError, dataOf, type ApiResponse, type schemas } from "../../services/api-client";
import { ms, type AdapterContext } from "../../services/wire";
import { CutoutError, type CutoutJob, type CutoutModel, type CutoutPort, type CutoutVersion, type RefineParams, type RefineStroke } from "./model";

const MAX_BYTES = 12 * 1024 * 1024;

export interface CutoutApiDeps {
  readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  readonly sleep?: (ms: number) => Promise<void>;
}

export function mapCutoutError(e: unknown): never {
  if (e instanceof CutoutError) throw e;
  if (e instanceof ApiError) {
    if (e.status === 401) throw new CutoutError("session_expired");
    if (e.status === 503 && e.code === "background_removal_disabled") throw new CutoutError("disabled");
    if (e.status === 503) throw new CutoutError("not_configured");
    if (e.status === 429) throw new CutoutError("quota");
    if (e.status === 403 && e.code === "consent_required") throw new CutoutError("consent");
    if (e.status === 409 && e.code === "attempts_exceeded") throw new CutoutError("attempts");
    throw new CutoutError("failed");
  }
  throw new CutoutError("offline");
}

export function toJob(j: schemas.ProductMediaJob, simulated = false): CutoutJob {
  const exp = [j.links.original, j.links.png, j.links.white_jpg].flatMap((l) => (l === null ? [] : [ms(l.expires_at)]));
  return {
    jobId: j.id, status: j.status, decision: j.decision, qualityScore: j.quality_score, reasons: j.quality_reasons,
    model: (j.model_id ?? j.requested_model) as CutoutModel | null, attempts: j.attempts, errorCode: j.error_code,
    originalUrl: j.links.original?.url ?? null, cutoutUrl: j.links.png?.url ?? null, whiteUrl: j.links.white_jpg?.url ?? null,
    linksExpireAtMs: exp.length === 0 ? null : Math.min(...exp), simulated,
  };
}

export class ApiCutoutPort implements CutoutPort {
  constructor(private readonly ctx: AdapterContext, private readonly storeId: string, private readonly deps: CutoutApiDeps = {}) {}

  private f(input: string, init?: RequestInit): Promise<Response> { return (this.deps.fetch ?? fetch)(input, init); }
  private sleep(n: number): Promise<void> { return (this.deps.sleep ?? ((t: number) => new Promise<void>((r) => setTimeout(r, t))))(n); }
  private path(jobId: string) { return { storeId: this.storeId, jobId }; }

  async start(uri: string): Promise<CutoutJob> {
    try {
      const blob = await (await this.f(uri)).blob();
      const type = blob.type === "image/png" || blob.type === "image/webp" ? blob.type : "image/jpeg";
      if (blob.size > MAX_BYTES) throw new CutoutError("too_large");
      const up = dataOf(await this.ctx.client.createSellerProductMediaUpload({ path: { storeId: this.storeId }, body: { content_type: type, size_bytes: blob.size } }));
      const put = await this.f(up.upload.url, { method: "PUT", headers: up.upload.headers, body: blob });
      if (!put.ok) throw new CutoutError("failed");
      // The scan can still be pending (409 upload_not_ready): a few short retries.
      for (let attempt = 0; ; attempt++) {
        try {
          return toJob(dataOf(await this.ctx.client.processSellerProductMedia({ path: this.path(up.job_id) })));
        } catch (e) {
          const pending = e instanceof ApiError && e.status === 409 && e.code === "upload_not_ready";
          if (!pending || attempt >= 4) throw e;
          await this.sleep(600 * (attempt + 1));
        }
      }
    } catch (e) {
      return mapCutoutError(e);
    }
  }
  async refresh(jobId: string): Promise<CutoutJob> {
    try { return toJob(dataOf(await this.ctx.client.getSellerProductMediaJob({ path: this.path(jobId) }))); } catch (e) { return mapCutoutError(e); }
  }
  async accept(jobId: string, version?: number): Promise<CutoutJob> {
    try {
      if (version !== undefined) await this.restoreVersion(jobId, version); return toJob(dataOf(await this.ctx.client.acceptSellerProductMedia({ path: this.path(jobId) }))); } catch (e) { return mapCutoutError(e); }
  }
  async useOriginal(jobId: string): Promise<CutoutJob> {
    try { return toJob(dataOf(await this.ctx.client.useOriginalSellerProductMedia({ path: this.path(jobId) }))); } catch (e) { return mapCutoutError(e); }
  }
  async rerun(jobId: string, model: CutoutModel): Promise<CutoutJob> {
    try { return toJob(dataOf(await this.ctx.client.rerunSellerProductMedia({ path: this.path(jobId), body: { model } }))); } catch (e) { return mapCutoutError(e); }
  }

  /**
   * The refine/versions/restore operations are generated from the API contract. Until the client is regenerated they are
   * reached through this narrow structural view; a missing operation is an honest "not configured", never a fake result.
   */
  private editOps(): EditOps {
    const c = this.ctx.client as unknown as Partial<EditOps>;
    if (typeof c.refineSellerProductMedia !== "function" || typeof c.listSellerProductMediaVersions !== "function" || typeof c.restoreSellerProductMediaVersion !== "function") {
      throw new CutoutError("not_configured");
    }
    return c as EditOps;
  }

  async refine(jobId: string, strokes: readonly RefineStroke[], params: RefineParams): Promise<CutoutJob> {
    try {
      const body = { strokes, feather_px: params.featherPx, smooth: params.smooth, edge_shift_px: params.edgeShiftPx, background: params.background };
      return toJob(dataOf(await this.editOps().refineSellerProductMedia({ path: this.path(jobId), body })) as schemas.ProductMediaJob);
    } catch (e) { return mapCutoutError(e); }
  }

  async versions(jobId: string): Promise<readonly CutoutVersion[]> {
    try {
      const raw = dataOf(await this.editOps().listSellerProductMediaVersions({ path: this.path(jobId) })) as { items?: readonly WireVersion[] };
      return (raw.items ?? []).map((v) => ({
        version: v.version, kind: v.op === "initial" || v.version === 1 ? "original" : "edit", qualityScore: v.quality_score ?? null, reasons: v.quality_reasons ?? [],
        cutoutUrl: v.thumbnail?.url ?? null, whiteUrl: null, createdAtMs: v.created_at === undefined ? 0 : ms(v.created_at),
      }));
    } catch (e) { return mapCutoutError(e); }
  }

  async restoreVersion(jobId: string, version: number): Promise<CutoutJob> {
    try {
      return toJob(dataOf(await this.editOps().restoreSellerProductMediaVersion({ path: { ...this.path(jobId), version } })) as schemas.ProductMediaJob);
    } catch (e) { return mapCutoutError(e); }
  }
}

interface WireVersion {
  readonly version: number;
  readonly quality_score?: number | null;
  readonly quality_reasons?: readonly string[];
  readonly created_at?: string;
  readonly op?: string;
  readonly thumbnail?: { readonly url: string } | null;
}
interface EditOps {
  refineSellerProductMedia(a: { path: { storeId: string; jobId: string }; body: unknown }): Promise<ApiResponse<unknown>>;
  listSellerProductMediaVersions(a: { path: { storeId: string; jobId: string } }): Promise<ApiResponse<unknown>>;
  restoreSellerProductMediaVersion(a: { path: { storeId: string; jobId: string; version: number } }): Promise<ApiResponse<unknown>>;
}
