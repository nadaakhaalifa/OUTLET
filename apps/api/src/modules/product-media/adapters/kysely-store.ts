import { sql, type Kysely } from "kysely";
import { z } from "zod";
import { assertTransition } from "../domain/machine";
import { QUOTA_UNITS_PER_RUN, type JobPatch, type ProductMediaJob, type ProductMediaStore, type ProductMediaVersion } from "../domain/ports";

/** Raw SQL only, rows validated with Zod (same approach as the forecasting adapter). */
export type ProductMediaDb = Kysely<Record<string, never>>;

const Ms = z.union([z.number(), z.string()]).transform((v) => Number(v));
const MODELS = z.enum(["u2netp", "u2net", "birefnet-general-lite", "isnet-general-use"]);
const Row = z.object({
  id: z.string(),
  store_id: z.string(),
  created_by: z.string(),
  original_ref: z.string(),
  content_type: z.enum(["image/jpeg", "image/png", "image/webp"]),
  size_bytes: Ms,
  status: z.enum(["PENDING", "PROCESSING", "READY", "NEEDS_REVIEW", "FAILED"]),
  decision: z.enum(["none", "accepted", "use_original"]),
  requested_model: MODELS.nullable(),
  model_id: z.string().nullable(),
  model_version: z.string().nullable(),
  quality_score: z.union([z.number(), z.string(), z.null()]).transform((v) => (v === null ? null : Number(v))),
  quality_reasons: z.array(z.string()),
  png_ref: z.string().nullable(),
  white_jpg_ref: z.string().nullable(),
  shadow_ref: z.string().nullable(),
  latency_ms: z.union([z.number(), z.string(), z.null()]).transform((v) => (v === null ? null : Number(v))),
  error_code: z.string().nullable(),
  attempts: Ms,
  attached_product_id: z.string().nullable(),
  promoted_image_ref: z.string().nullable(),
  promoted_cutout_ref: z.string().nullable(),
  version: Ms,
  current_version: Ms,
  edit_count: Ms,
  promoted_version: Ms,
  background_render_ref: z.string().nullable(),
  created_ms: Ms,
  updated_ms: Ms,
});

const VersionRow = z.object({
  id: z.string(),
  job_id: z.string(),
  store_id: z.string(),
  version: Ms,
  op: z.enum(["initial", "rerun", "refine"]),
  params: z.record(z.string(), z.unknown()),
  mask_ref: z.string().nullable(),
  png_ref: z.string(),
  white_jpg_ref: z.string(),
  shadow_ref: z.string().nullable(),
  background_render_ref: z.string().nullable(),
  model_id: z.string().nullable(),
  model_version: z.string().nullable(),
  latency_ms: z.union([z.number(), z.string(), z.null()]).transform((v) => (v === null ? null : Number(v))),
  quality_score: Ms,
  quality_reasons: z.array(z.string()),
  created_ms: Ms,
});
const VCOLS = sql`id, job_id, store_id, version, op, params, mask_ref, png_ref, white_jpg_ref, shadow_ref, background_render_ref, model_id,
  model_version, latency_ms, quality_score, quality_reasons, (extract(epoch from created_at) * 1000)::bigint AS created_ms`;
const toVersion = (r: z.infer<typeof VersionRow>): ProductMediaVersion => ({
  id: r.id,
  jobId: r.job_id,
  storeId: r.store_id,
  version: r.version,
  op: r.op,
  params: r.params,
  maskRef: r.mask_ref,
  pngRef: r.png_ref,
  whiteJpgRef: r.white_jpg_ref,
  shadowRef: r.shadow_ref,
  backgroundRenderRef: r.background_render_ref,
  modelId: r.model_id,
  modelVersion: r.model_version,
  latencyMs: r.latency_ms,
  qualityScore: r.quality_score,
  qualityReasons: r.quality_reasons,
  createdAtMs: r.created_ms,
});

const COLS = sql`id, store_id, created_by, original_ref, content_type, size_bytes, status, decision, requested_model, model_id,
  model_version, quality_score, quality_reasons, png_ref, white_jpg_ref, shadow_ref, latency_ms, error_code, attempts, attached_product_id, promoted_image_ref, promoted_cutout_ref, version,
  current_version, edit_count, promoted_version, background_render_ref,
  (extract(epoch from created_at) * 1000)::bigint AS created_ms, (extract(epoch from updated_at) * 1000)::bigint AS updated_ms`;

const toJob = (r: z.infer<typeof Row>): ProductMediaJob => ({
  id: r.id,
  storeId: r.store_id,
  createdBy: r.created_by,
  originalRef: r.original_ref,
  contentType: r.content_type,
  sizeBytes: r.size_bytes,
  status: r.status,
  decision: r.decision,
  requestedModel: r.requested_model,
  modelId: r.model_id,
  modelVersion: r.model_version,
  qualityScore: r.quality_score,
  qualityReasons: r.quality_reasons,
  pngRef: r.png_ref,
  whiteJpgRef: r.white_jpg_ref,
  shadowRef: r.shadow_ref,
  latencyMs: r.latency_ms,
  errorCode: r.error_code,
  attempts: r.attempts,
  attachedProductId: r.attached_product_id,
  promotedImageRef: r.promoted_image_ref,
  promotedCutoutRef: r.promoted_cutout_ref,
  version: r.version,
  currentVersion: r.current_version,
  editCount: r.edit_count,
  promotedVersion: r.promoted_version,
  backgroundRenderRef: r.background_render_ref,
  createdAtMs: r.created_ms,
  updatedAtMs: r.updated_ms,
});

const ts = (ms: number) => sql`to_timestamp(${ms}::double precision / 1000.0)`;
const textArray = (a: readonly string[]) => sql`${`{${a.map((s) => `"${s.replace(/["\\]/g, "")}"`).join(",")}}`}::text[]`;

export class KyselyProductMediaStore implements ProductMediaStore {
  constructor(private readonly db: ProductMediaDb) {}

  async insertJob(j: ProductMediaJob): Promise<"created" | "duplicate"> {
    const r = await sql<{ id: string }>`
      INSERT INTO product_media_jobs (id, store_id, created_by, original_ref, content_type, size_bytes, status, decision, attempts, version, created_at, updated_at)
      VALUES (${j.id}::uuid, ${j.storeId}::uuid, ${j.createdBy}::uuid, ${j.originalRef}, ${j.contentType}, ${j.sizeBytes}, ${j.status}, ${j.decision},
        ${j.attempts}, ${j.version}, ${ts(j.createdAtMs)}, ${ts(j.updatedAtMs)})
      ON CONFLICT (store_id, original_ref) DO NOTHING
      RETURNING id`.execute(this.db);
    return r.rows.length === 1 ? "created" : "duplicate";
  }

  async getJob(id: string): Promise<ProductMediaJob | null> {
    const r = await sql`SELECT ${COLS} FROM product_media_jobs WHERE id = ${id}::uuid`.execute(this.db);
    const row = r.rows[0];
    return row === undefined ? null : toJob(Row.parse(row));
  }

  async update(id: string, expectedVersion: number, p: JobPatch): Promise<ProductMediaJob | null> {
    const cur = await this.getJob(id);
    if (cur === null || cur.version !== expectedVersion) return null;
    if (p.status !== undefined && p.status !== cur.status) assertTransition(cur.status, p.status);
    const m = { ...cur, ...p };
    const r = await sql`
      UPDATE product_media_jobs SET
        status = ${m.status}, decision = ${m.decision}, requested_model = ${m.requestedModel}, model_id = ${m.modelId},
        model_version = ${m.modelVersion}, quality_score = ${m.qualityScore}, quality_reasons = ${textArray(m.qualityReasons)},
        png_ref = ${m.pngRef}, white_jpg_ref = ${m.whiteJpgRef}, shadow_ref = ${m.shadowRef}, latency_ms = ${m.latencyMs},
        error_code = ${m.errorCode}, attempts = ${m.attempts}, current_version = ${m.currentVersion}, edit_count = ${m.editCount},
        background_render_ref = ${m.backgroundRenderRef}, version = version + 1, updated_at = ${ts(p.updatedAtMs)}
      WHERE id = ${id}::uuid AND version = ${expectedVersion}
      RETURNING ${COLS}`.execute(this.db);
    const row = r.rows[0];
    return row === undefined ? null : toJob(Row.parse(row));
  }

  async listByStore(storeId: string, limit: number): Promise<readonly ProductMediaJob[]> {
    const r = await sql`SELECT ${COLS} FROM product_media_jobs WHERE store_id = ${storeId}::uuid ORDER BY created_at DESC, id DESC LIMIT ${limit}`.execute(this.db);
    return r.rows.map((x) => toJob(Row.parse(x)));
  }

  async claimAttachment(jobId: string, storeId: string, productId: string): Promise<ProductMediaJob | null> {
    const r = await sql`
      UPDATE product_media_jobs SET attached_product_id = ${productId}::uuid
      WHERE id = ${jobId}::uuid AND store_id = ${storeId}::uuid
        AND (attached_product_id IS NULL OR attached_product_id = ${productId}::uuid)
      RETURNING ${COLS}`.execute(this.db);
    const row = r.rows[0];
    return row === undefined ? null : toJob(Row.parse(row));
  }

  async releaseAttachment(jobId: string, storeId: string, productId: string): Promise<void> {
    await sql`
      UPDATE product_media_jobs SET attached_product_id = NULL
      WHERE id = ${jobId}::uuid AND store_id = ${storeId}::uuid AND attached_product_id = ${productId}::uuid`.execute(this.db);
  }

  async setPromoted(jobId: string, refs: { readonly image: string; readonly cutout: string | null }): Promise<ProductMediaJob | null> {
    await sql`
      UPDATE product_media_jobs SET promoted_image_ref = ${refs.image}, promoted_cutout_ref = ${refs.cutout}, promoted_version = current_version
      WHERE id = ${jobId}::uuid AND promoted_image_ref IS NULL`.execute(this.db);
    return this.getJob(jobId);
  }

  async replacePromoted(
    jobId: string,
    expectedImage: string,
    refs: { readonly image: string; readonly cutout: string | null },
    version: number,
  ): Promise<ProductMediaJob | null> {
    const r = await sql`
      UPDATE product_media_jobs SET promoted_image_ref = ${refs.image}, promoted_cutout_ref = ${refs.cutout}, promoted_version = ${version}
      WHERE id = ${jobId}::uuid AND promoted_image_ref = ${expectedImage}
      RETURNING ${COLS}`.execute(this.db);
    const row = r.rows[0];
    return row === undefined ? null : toJob(Row.parse(row));
  }

  async consumeQuota(storeId: string, day: string, limit: number): Promise<boolean> {
    return this.consumeQuotaUnits(storeId, day, QUOTA_UNITS_PER_RUN, limit);
  }

  /** runs * 4 + refine_units + units <= limit * 4, atomically (a full run is 4 units, a refine 1). */
  async consumeQuotaUnits(storeId: string, day: string, units: number, limitRuns: number): Promise<boolean> {
    if (units < 1 || units > QUOTA_UNITS_PER_RUN) throw new RangeError("units out of range");
    if (units > limitRuns * QUOTA_UNITS_PER_RUN) return false;
    const full = units === QUOTA_UNITS_PER_RUN;
    const r = await sql<{ runs: number }>`
      INSERT INTO product_media_usage (store_id, day, runs, refine_units)
      VALUES (${storeId}::uuid, ${day}::date, ${full ? 1 : 0}, ${full ? 0 : units})
      ON CONFLICT (store_id, day) DO UPDATE SET
        runs = product_media_usage.runs + ${full ? 1 : 0},
        refine_units = product_media_usage.refine_units + ${full ? 0 : units}
        WHERE product_media_usage.runs * ${QUOTA_UNITS_PER_RUN} + product_media_usage.refine_units + ${units} <= ${limitRuns * QUOTA_UNITS_PER_RUN}
      RETURNING runs`.execute(this.db);
    return r.rows.length === 1;
  }

  async listVersions(jobId: string): Promise<readonly ProductMediaVersion[]> {
    const r = await sql`SELECT ${VCOLS} FROM product_media_versions WHERE job_id = ${jobId}::uuid ORDER BY version ASC`.execute(this.db);
    return r.rows.map((x) => toVersion(VersionRow.parse(x)));
  }

  async getVersion(jobId: string, version: number): Promise<ProductMediaVersion | null> {
    const r = await sql`SELECT ${VCOLS} FROM product_media_versions WHERE job_id = ${jobId}::uuid AND version = ${version}`.execute(this.db);
    const row = r.rows[0];
    return row === undefined ? null : toVersion(VersionRow.parse(row));
  }

  async insertVersion(v: ProductMediaVersion): Promise<"created" | "duplicate"> {
    const r = await sql<{ id: string }>`
      INSERT INTO product_media_versions (id, job_id, store_id, version, op, params, mask_ref, png_ref, white_jpg_ref, shadow_ref,
        background_render_ref, model_id, model_version, latency_ms, quality_score, quality_reasons, created_at)
      VALUES (${v.id}::uuid, ${v.jobId}::uuid, ${v.storeId}::uuid, ${v.version}, ${v.op}, ${JSON.stringify(v.params)}::jsonb, ${v.maskRef},
        ${v.pngRef}, ${v.whiteJpgRef}, ${v.shadowRef}, ${v.backgroundRenderRef}, ${v.modelId}, ${v.modelVersion}, ${v.latencyMs},
        ${v.qualityScore}, ${textArray(v.qualityReasons)}, ${ts(v.createdAtMs)})
      ON CONFLICT (job_id, version) DO NOTHING
      RETURNING id`.execute(this.db);
    return r.rows.length === 1 ? "created" : "duplicate";
  }

  async deleteVersion(jobId: string, version: number): Promise<ProductMediaVersion | null> {
    const found = await this.getVersion(jobId, version);
    if (found === null) return null;
    await sql`DELETE FROM product_media_versions WHERE job_id = ${jobId}::uuid AND version = ${version}`.execute(this.db);
    return found;
  }
}
