import { sql, type Kysely } from "kysely";
import { z } from "zod";
import { ART_VARIANTS, type BannerCta, type HomeBanner } from "../domain/banner";
import type { HomeBannerStore } from "../domain/ports";

/** Raw SQL, rows validated with Zod (same approach as the product-media adapter). */
export type HomeBannerDb = Kysely<Record<string, never>>;

const Num = z.union([z.number(), z.string()]).transform((v) => Number(v));
const Big = z.union([z.number(), z.string(), z.bigint(), z.null()]).transform((v) => (v === null ? null : BigInt(v)));
const Row = z.object({
  id: z.string(),
  status: z.enum(["draft", "scheduled", "paused"]),
  title_ar: z.string(),
  title_en: z.string().nullable(),
  subtitle_ar: z.string().nullable(),
  subtitle_en: z.string().nullable(),
  image_key: z.string().nullable(),
  art_variant: z.enum(ART_VARIANTS).nullable(),
  priority: Num,
  starts_ms: Num,
  ends_ms: Num,
  sponsored: z.boolean(),
  sponsor_ref: z.string().nullable(),
  cta_kind: z.enum(["drop", "store", "category", "search", "voucher"]),
  cta_target_id: z.string().nullable(),
  cta_query: z.string().nullable(),
  cta_price_min: Big,
  cta_price_max: Big,
  created_by: z.string(),
  updated_by: z.string(),
  version: Num,
  created_ms: Num,
  updated_ms: Num,
});

const COLS = sql`id, status, title_ar, title_en, subtitle_ar, subtitle_en, image_key, art_variant, priority,
  (extract(epoch from starts_at) * 1000)::bigint AS starts_ms, (extract(epoch from ends_at) * 1000)::bigint AS ends_ms,
  sponsored, sponsor_ref, cta_kind, cta_target_id, cta_query, cta_price_min::text AS cta_price_min, cta_price_max::text AS cta_price_max,
  created_by, updated_by, version,
  (extract(epoch from created_at) * 1000)::bigint AS created_ms, (extract(epoch from updated_at) * 1000)::bigint AS updated_ms`;

function ctaOf(r: z.infer<typeof Row>): BannerCta {
  switch (r.cta_kind) {
    case "drop":
    case "store":
    case "voucher":
      return { kind: r.cta_kind, targetId: r.cta_target_id ?? "" };
    case "category":
      return { kind: "category", targetId: r.cta_target_id ?? "", priceMin: r.cta_price_min, priceMax: r.cta_price_max };
    case "search":
      return { kind: "search", query: r.cta_query ?? "", priceMin: r.cta_price_min, priceMax: r.cta_price_max };
  }
}

const toBanner = (r: z.infer<typeof Row>): HomeBanner => ({
  id: r.id,
  status: r.status,
  titleAr: r.title_ar,
  titleEn: r.title_en,
  subtitleAr: r.subtitle_ar,
  subtitleEn: r.subtitle_en,
  imageKey: r.image_key,
  artVariant: r.art_variant,
  priority: r.priority,
  startsAtMs: r.starts_ms,
  endsAtMs: r.ends_ms,
  sponsored: r.sponsored,
  sponsorRef: r.sponsor_ref,
  cta: ctaOf(r),
  createdBy: r.created_by,
  updatedBy: r.updated_by,
  version: r.version,
  createdAtMs: r.created_ms,
  updatedAtMs: r.updated_ms,
});

const ctaCols = (c: BannerCta) => ({
  kind: c.kind,
  target: c.kind === "search" ? null : c.targetId,
  query: c.kind === "search" ? c.query : null,
  min: c.kind === "category" || c.kind === "search" ? c.priceMin : null,
  max: c.kind === "category" || c.kind === "search" ? c.priceMax : null,
});

export class KyselyHomeBannerStore implements HomeBannerStore {
  constructor(private readonly db: HomeBannerDb) {}

  async insert(b: HomeBanner): Promise<void> {
    const c = ctaCols(b.cta);
    await sql`
      INSERT INTO home_banners (id, status, title_ar, title_en, subtitle_ar, subtitle_en, image_key, art_variant, priority, starts_at, ends_at,
        sponsored, sponsor_ref, cta_kind, cta_target_id, cta_query, cta_price_min, cta_price_max, created_by, updated_by, version, created_at, updated_at)
      VALUES (${b.id}::uuid, ${b.status}, ${b.titleAr}, ${b.titleEn}, ${b.subtitleAr}, ${b.subtitleEn}, ${b.imageKey}, ${b.artVariant}, ${b.priority},
        to_timestamp(${b.startsAtMs} / 1000.0), to_timestamp(${b.endsAtMs} / 1000.0), ${b.sponsored}, ${b.sponsorRef},
        ${c.kind}, ${c.target}, ${c.query}, ${c.min === null ? null : c.min.toString()}::bigint, ${c.max === null ? null : c.max.toString()}::bigint,
        ${b.createdBy}::uuid, ${b.updatedBy}::uuid, ${b.version}, to_timestamp(${b.createdAtMs} / 1000.0), to_timestamp(${b.updatedAtMs} / 1000.0))`.execute(this.db);
  }

  async get(id: string): Promise<HomeBanner | null> {
    const r = await sql`SELECT ${COLS} FROM home_banners WHERE id = ${id}::uuid`.execute(this.db);
    const row = r.rows[0];
    return row === undefined ? null : toBanner(Row.parse(row));
  }

  async replace(next: HomeBanner, expectedVersion: number): Promise<HomeBanner | null> {
    const c = ctaCols(next.cta);
    const r = await sql`
      UPDATE home_banners SET status = ${next.status}, title_ar = ${next.titleAr}, title_en = ${next.titleEn}, subtitle_ar = ${next.subtitleAr},
        subtitle_en = ${next.subtitleEn}, image_key = ${next.imageKey}, art_variant = ${next.artVariant}, priority = ${next.priority},
        starts_at = to_timestamp(${next.startsAtMs} / 1000.0), ends_at = to_timestamp(${next.endsAtMs} / 1000.0),
        sponsored = ${next.sponsored}, sponsor_ref = ${next.sponsorRef}, cta_kind = ${c.kind}, cta_target_id = ${c.target}, cta_query = ${c.query},
        cta_price_min = ${c.min === null ? null : c.min.toString()}::bigint, cta_price_max = ${c.max === null ? null : c.max.toString()}::bigint,
        updated_by = ${next.updatedBy}::uuid, version = version + 1
      WHERE id = ${next.id}::uuid AND version = ${expectedVersion}
      RETURNING ${COLS}`.execute(this.db);
    const row = r.rows[0];
    return row === undefined ? null : toBanner(Row.parse(row));
  }

  async remove(id: string): Promise<boolean> {
    const r = await sql`DELETE FROM home_banners WHERE id = ${id}::uuid RETURNING id`.execute(this.db);
    return r.rows.length > 0;
  }

  async list(limit: number): Promise<readonly HomeBanner[]> {
    const r = await sql`SELECT ${COLS} FROM home_banners ORDER BY created_at DESC, id DESC LIMIT ${limit}`.execute(this.db);
    return r.rows.map((x) => toBanner(Row.parse(x)));
  }

  async listScheduledAt(nowMs: number, limit: number): Promise<readonly HomeBanner[]> {
    const r = await sql`
      SELECT ${COLS} FROM home_banners
      WHERE status = 'scheduled' AND starts_at <= to_timestamp(${nowMs} / 1000.0) AND ends_at > to_timestamp(${nowMs} / 1000.0)
      ORDER BY priority DESC, starts_at ASC, id ASC LIMIT ${limit}`.execute(this.db);
    return r.rows.map((x) => toBanner(Row.parse(x)));
  }
}
