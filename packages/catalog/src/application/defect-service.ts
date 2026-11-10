import { createHash, randomBytes } from "node:crypto";
import type { Queryable } from "@outlet/db";
import type { Principal } from "@outlet/policy";
import { DefectCardInput, DefectPassport } from "../domain/dto.js";
import type { DefectCard, DefectCardInput as CardIn, DefectPassport as PassportDto } from "../domain/dto.js";
import { CatalogError, notFound, validation } from "../domain/errors.js";
import { PUBLIC_STATUSES } from "../domain/listing-state.js";
import { defectCardDto, loadCard, loadGrade, loadStoreWithSeller, lockProduct } from "./data.js";
import { asPublic, asStore, makeEnv, toIso } from "./env.js";
import type { CatalogDeps, Env } from "./env.js";
import { emit } from "./events.js";
import { projectListing } from "./projection.js";
import { PASSPORT_SQL } from "./queries.js";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 128 random bits as 26 Crockford base32 characters (the QR payload). */
export const encodeToken = (bytes: Uint8Array): string => {
  let out = "";
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(acc >>> (bits - 5)) & 31] ?? "";
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += CROCKFORD[(acc << (5 - bits)) & 31] ?? "";
  return out;
};

/** Accepts what a person might type or scan: case-insensitive, dashes and spaces ignored, O/I/L mapped like Crockford. */
export const normalizeToken = (raw: string): string | undefined => {
  const t = raw.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(t) ? t : undefined;
};

export const hashToken = (token: string): Buffer => createHash("sha256").update(token).digest();

interface PassportRow {
  product_id: string;
  title_ar: string;
  title_en: string | null;
  store_slug: string;
  store_name_ar: string;
  unit_status: PassportDto["unit_status"];
  condition_grade: PassportDto["condition_grade"];
  defect_card: DefectCard;
  content_hash: string;
  inspections: PassportDto["inspection_history"];
}

/** Defect cards (immutable versions) and the QR defect passport (ADR-0009). */
export class DefectService {
  private readonly env: Env;
  constructor(deps: CatalogDeps) {
    this.env = makeEnv(deps);
  }

  /**
   * Creates a NEW card version for the listing's condition grade and points the listing at it. Rules: the grade must take a card,
   * at least one defect, each defect has a real close-up photo (schema-required), critical (safety) defect types can never be listed.
   */
  async putDefectCard(actor: Principal, storeId: string, productId: string, expectedVersion: number, raw: CardIn): Promise<DefectCard> {
    const input = DefectCardInput.parse(raw);
    return await asStore(this.env, actor, "listing.write", storeId, async (tx) => {
      const p = await lockProduct(tx, productId, expectedVersion);
      if (p.status === "ARCHIVED" || p.status === "BLOCKED") throw new CatalogError("conflict", `listing is ${p.status} and cannot be edited`);
      const grade = await loadGrade(tx, p.condition_grade_code);
      if (grade?.requires_defect_card !== true) throw validation("this condition grade does not take a defect card", [p.condition_grade_code]);
      if (input.items.length < 1) throw validation("a defect card needs at least one defect with a photo", ["DEFECT_CARD_EMPTY"]);
      if (input.summary_ar === undefined || input.summary_ar.trim().length === 0) throw validation("summary_ar is required", ["SUMMARY_AR_REQUIRED"]);
      const codes = [...new Set(input.items.map((i) => i.defect_type_code))];
      const types = (await tx.query<{ code: string; is_critical: boolean; active: boolean }>("SELECT code, is_critical, active FROM defect_types WHERE code = ANY($1::text[])", [codes])).rows;
      const bad = codes.filter((c) => !types.some((t) => t.code === c && t.active));
      if (bad.length > 0) throw validation("unknown defect type", bad);
      const critical = types.filter((t) => t.is_critical).map((t) => t.code);
      if (critical.length > 0) throw validation("critical (safety) defects cannot be listed", critical);

      const next = (await tx.query<{ v: number }>("SELECT COALESCE(max(version), 0) + 1 AS v FROM defect_cards WHERE product_id = $1", [productId])).rows[0]?.v ?? 1;
      const cardId = this.env.newId();
      const at = this.env.now();
      const isPublic = PUBLIC_STATUSES.includes(p.status);
      await tx.query(
        `INSERT INTO defect_cards (id, product_id, store_id, market_id, version, grade_code, stock_reason, summary_ar, summary_en, affects_function, defect_count,
                                   inspected_by, inspected_at, published_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'seller',$12,$13,$12)`,
        [cardId, productId, storeId, this.env.marketId, next, p.condition_grade_code, p.stock_reason, input.summary_ar, input.summary_en ?? null, input.affects_function, input.items.length, at, isPublic ? at : null],
      );
      for (const [i, it] of input.items.entries()) {
        await tx.query(
          `INSERT INTO defect_items (id, defect_card_id, store_id, defect_type_code, location_ar, location_en, size_mm, severity, affects_function, photo_media_id,
                                     hotspot_media_id, hotspot_x_bp, hotspot_y_bp, note_ar, note_en, position)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [this.env.newId(), cardId, storeId, it.defect_type_code, it.location_ar, it.location_en ?? null, it.size_mm ?? null, it.severity, it.affects_function, it.photo_media_id,
           it.hotspot_media_id ?? null, it.hotspot_x_bp ?? null, it.hotspot_y_bp ?? null, it.note_ar ?? null, it.note_en ?? null, i],
        );
      }
      await tx.query("UPDATE products SET defect_card_id = $2, version = version + 1, search_version = search_version + 1, updated_at = $3 WHERE id = $1", [productId, cardId, at]);
      if (isPublic) {
        await projectListing(this.env, tx, productId);
        const v = (await tx.query<{ version: number }>("SELECT version FROM products WHERE id = $1", [productId])).rows[0]?.version ?? 0;
        await emit(this.env, tx, "listing.updated", "listing", productId, { listing_id: productId, store_id: storeId, version: v, status: p.status });
      }
      const loaded = await loadCard(tx, cardId);
      if (loaded === undefined) throw notFound("defect card");
      return defectCardDto(this.env, loaded.card, loaded.items);
    });
  }

  /**
   * Issues one passport for a physical unit: a 128-bit random token (shown once, only its SHA-256 is stored), a content hash of the
   * graded card version (tamper evidence), and the public read-model row. No buyer data is ever written here.
   */
  async issuePassport(actor: Principal, storeId: string, input: { productId: string; skuId: string }): Promise<{ unitId: string; passportCode: string; contentHash: string }> {
    return await asStore(this.env, actor, "listing.write", storeId, async (tx) => {
      const p = await lockProduct(tx, input.productId);
      if (p.defect_card_id === null) throw validation("the listing has no defect card; passports are for graded items", ["DEFECT_CARD_REQUIRED"]);
      if ((await tx.query("SELECT 1 FROM skus WHERE id = $1 AND product_id = $2", [input.skuId, input.productId])).rows.length === 0) throw notFound("variant");
      const loaded = await loadCard(tx, p.defect_card_id);
      const grade = await loadGrade(tx, p.condition_grade_code);
      const store = await loadStoreWithSeller(tx, storeId);
      if (loaded === undefined || grade === undefined || store === undefined) throw notFound("defect card");
      const card = defectCardDto(this.env, loaded.card, loaded.items);
      const gradeDto = { code: grade.code, label_ar: grade.label_ar, label_en: grade.label_en, schema_org_condition: grade.schema_org_condition };
      const contentHash = createHash("sha256").update(JSON.stringify({ grade: grade.code, card })).digest();
      const token = encodeToken(randomBytes(16));
      const tokenHash = hashToken(token);
      const unitId = this.env.newId();
      const at = this.env.now();
      await tx.query(
        `INSERT INTO item_units (id, store_id, market_id, product_id, sku_id, defect_card_id, passport_token_hash, content_hash, inspected_at, issued_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$10)`,
        [unitId, storeId, this.env.marketId, input.productId, input.skuId, p.defect_card_id, tokenHash, contentHash, loaded.card.inspected_at, at],
      );
      const history = (
        await tx.query<{ version: number; inspected_by: string; inspected_at: Date }>(
          "SELECT version, inspected_by, inspected_at FROM defect_cards WHERE product_id = $1 AND version <= $2 ORDER BY version",
          [input.productId, loaded.card.version],
        )
      ).rows.map((h) => ({ version: h.version, inspected_by: h.inspected_by, inspected_at: toIso(h.inspected_at) }));
      await tx.query(
        `INSERT INTO catalog_public_passports (token_hash, market_id, product_id, title_ar, title_en, store_slug, store_name_ar, unit_status, condition_grade, defect_card, content_hash, inspections, issued_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'IN_STOCK',$8::jsonb,$9::jsonb,$10,$11::jsonb,$12)`,
        [tokenHash, this.env.marketId, input.productId, p.title_ar, null, store.slug, store.display_name_ar, JSON.stringify(gradeDto), JSON.stringify(card), contentHash.toString("hex"), JSON.stringify(history), at],
      );
      return { unitId, passportCode: token, contentHash: contentHash.toString("hex") };
    });
  }

  /** Public lookup by QR token: one indexed read of the published model, never any seller or buyer identity beyond the store's public name. */
  async lookupPassport(rawToken: string): Promise<PassportDto> {
    const token = normalizeToken(rawToken);
    if (token === undefined) throw notFound("passport");
    return await asPublic(this.env, async (tx: Queryable) => {
      const r = (await tx.query<PassportRow>(PASSPORT_SQL, [hashToken(token), this.env.marketId])).rows[0];
      if (r === undefined) throw notFound("passport");
      return DefectPassport.parse({
        passport_code: token,
        unit_status: r.unit_status,
        product_id: r.product_id,
        title_ar: r.title_ar,
        title_en: r.title_en,
        store_slug: r.store_slug,
        store_display_name_ar: r.store_name_ar,
        condition_grade: r.condition_grade,
        defect_card: r.defect_card,
        content_hash: r.content_hash,
        inspection_history: r.inspections,
        product_path: `/${this.env.marketId.toLowerCase()}/products/${r.product_id}`,
      });
    });
  }
}
