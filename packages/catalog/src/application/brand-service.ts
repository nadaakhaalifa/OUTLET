import { createHash } from "node:crypto";
import type { Principal } from "@outlet/policy";
import { CatalogError, notFound } from "../domain/errors.js";
import { asPublic, asStore, isUniqueViolation, makeEnv } from "./env.js";
import type { CatalogDeps, Env } from "./env.js";

export interface BrandDto {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly is_verified: boolean;
}

interface Row {
  id: string;
  name: string;
  slug: string;
  is_verified: boolean;
}

const COLS = "id, name, slug, is_verified";

/** Folds Arabic and Latin spelling variants so "Zara", "zara " and "ZARA" (or أديداس / اديداس) are one brand. */
export const normalizeBrandName = (name: string): string =>
  name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[ً-ٰٟـ]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/\s+/g, " ")
    .trim();

const slugOf = (normalized: string, suffix: string): string => {
  const base = normalized.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return base.length > 0 ? base : `brand-${suffix}`;
};

export class BrandService {
  private readonly env: Env;
  constructor(deps: CatalogDeps) {
    this.env = makeEnv(deps);
  }

  async getBySlug(slug: string): Promise<BrandDto> {
    return await asPublic(this.env, async (tx) => {
      const r = await tx.query<Row>(`SELECT ${COLS} FROM brands WHERE slug = $1`, [slug]);
      const row = r.rows[0];
      if (row === undefined) throw notFound("brand");
      return row;
    });
  }

  /** Keyset by (name, id), at most 50. */
  async list(limit = 20, afterSlug?: string): Promise<BrandDto[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new CatalogError("validation", "limit must be 1..50");
    return await asPublic(this.env, async (tx) => (await tx.query<Row>(`SELECT ${COLS} FROM brands WHERE ($1::text IS NULL OR slug > $1) ORDER BY slug LIMIT $2`, [afterSlug ?? null, limit])).rows);
  }

  /**
   * Seller staff add the brand they sell. Names are deduplicated by normalized_name (an existing brand is returned, never
   * duplicated); new brands start unverified and only the admin console verifies them.
   */
  async register(actor: Principal, storeId: string, name: string): Promise<BrandDto> {
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed.length > 120) throw new CatalogError("validation", "brand name must be 1..120 characters");
    const normalized = normalizeBrandName(trimmed);
    return await asStore(this.env, actor, "listing.write", storeId, async (tx) => {
      const existing = (await tx.query<Row>(`SELECT ${COLS} FROM brands WHERE normalized_name = $1`, [normalized])).rows[0];
      if (existing !== undefined) return existing;
      const id = this.env.newId();
      const suffix = createHash("sha256").update(id).digest("hex").slice(0, 6);
      try {
        await tx.query("SAVEPOINT brand_insert");
        await tx.query("INSERT INTO brands (id, name, normalized_name, slug) VALUES ($1, $2, $3, $4)", [id, trimmed, normalized, slugOf(normalized, suffix)]);
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
        await tx.query("ROLLBACK TO SAVEPOINT brand_insert");
        const raced = (await tx.query<Row>(`SELECT ${COLS} FROM brands WHERE normalized_name = $1`, [normalized])).rows[0];
        if (raced !== undefined) return raced;
        // slug collision with a different brand: disambiguate with the id suffix
        await tx.query("INSERT INTO brands (id, name, normalized_name, slug) VALUES ($1, $2, $3, $4)", [id, trimmed, normalized, `${slugOf(normalized, suffix)}-${suffix}`]);
      }
      return { id, name: trimmed, slug: (await tx.query<Row>(`SELECT ${COLS} FROM brands WHERE id = $1`, [id])).rows[0]?.slug ?? "", is_verified: false };
    });
  }
}
