import type { Queryable } from "@outlet/db";
import type { Principal } from "@outlet/policy";
import { activationReasons } from "../domain/activation.js";
import { assertAttributes, attributeIssues } from "../domain/attributes.js";
import { hasArabicLetters } from "../domain/conditions.js";
import { DetailsInput, PhotosConditionInput, ProductDraftInput, PublishResult, SellerProduct, SellerProductSummaryPage } from "../domain/dto.js";
import type { DetailsInput as Details, PhotosConditionInput as Photos, ProductDraftInput as Draft, SellerProduct as SellerProductDto } from "../domain/dto.js";
import { CatalogError, notFound, validation } from "../domain/errors.js";
import { PUBLIC_STATUSES, transition, transitionPath } from "../domain/listing-state.js";
import type { ListingStatus } from "../domain/listing-state.js";
import { decodeCursor, encodeCursor, pageLimit } from "./cursor.js";
import { PRODUCT_COLS, categoryUsable, lockProduct, defectCardDto, loadAttributeSet, loadCard, loadGrade, loadMedia, loadSkus, loadStoreWithSeller, mediaRef } from "./data.js";
import type { ProductRow } from "./data.js";
import { asStore, makeEnv, toIso } from "./env.js";
import type { CatalogDeps, Env } from "./env.js";
import { emit } from "./events.js";
import { projectListing, projectStore } from "./projection.js";
import { sellerListSql } from "./queries.js";

interface Locked {
  status: ListingStatus;
  version: number;
}

const EDITABLE: readonly ListingStatus[] = ["DRAFT", "IN_REVIEW", "PUBLISHED", "PAUSED", "SOLD_OUT"];

/** Listing (products row) lifecycle: draft, details, photos and condition, readiness, activate, pause, resume, archive. All seller-scoped. */
export class ListingService {
  private readonly env: Env;
  constructor(deps: CatalogDeps) {
    this.env = makeEnv(deps);
  }

  // ---------------------------------------------------------------- reads
  async get(actor: Principal, storeId: string, id: string): Promise<SellerProductDto> {
    return await asStore(this.env, actor, "listing.read", storeId, (tx) => this.view(tx, id));
  }

  /** Keyset page (updated_at desc, id desc), max 50, only the summary columns; sku_count comes from one correlated count in the same statement. */
  async listOwn(actor: Principal, storeId: string, opts: { status?: ListingStatus; cursor?: string; limit?: number } = {}): Promise<ReturnType<typeof SellerProductSummaryPage.parse>> {
    const limit = pageLimit(opts.limit);
    const cur = decodeCursor(opts.cursor);
    return await asStore(this.env, actor, "listing.read", storeId, async (tx) => {
      const params: unknown[] = [storeId];
      if (opts.status !== undefined) params.push(opts.status);
      if (cur !== undefined) params.push(cur.t, cur.id);
      params.push(limit + 1);
      const r = await tx.query<{ id: string; status: string; title_ar: string; condition_grade_code: string; updated_at: Date; cur_t: string; sku_count: number }>(
        sellerListSql({ status: opts.status !== undefined, cursor: cur !== undefined }),
        params,
      );
      const rows = r.rows.slice(0, limit);
      const last = rows[rows.length - 1];
      return SellerProductSummaryPage.parse({
        items: rows.map((x) => ({ id: x.id, status: x.status, title_ar: x.title_ar === "" ? null : x.title_ar, condition_grade_code: x.condition_grade_code, sku_count: x.sku_count, updated_at: toIso(x.updated_at) })),
        next_cursor: r.rows.length > limit && last !== undefined ? encodeCursor({ t: last.cur_t, id: last.id }) : null,
      });
    });
  }

  /** What would block activation, without changing anything (PublishResult.blocked_reasons). */
  async readiness(actor: Principal, storeId: string, id: string): Promise<ReturnType<typeof PublishResult.parse>> {
    return await asStore(this.env, actor, "listing.read", storeId, async (tx) => {
      const p = await this.row(tx, id);
      const reasons = await this.reasons(tx, p);
      return PublishResult.parse({ product_id: id, status: reasons.length === 0 ? "PUBLISHED" : "DRAFT", blocked_reasons: reasons });
    });
  }

  // ---------------------------------------------------------------- writes
  async createDraft(actor: Principal, storeId: string, raw: Draft): Promise<SellerProductDto> {
    const input = ProductDraftInput.parse(raw);
    return await asStore(this.env, actor, "listing.write", storeId, async (tx) => {
      const grade = await loadGrade(tx, input.condition_grade_code);
      if (grade?.active !== true) throw validation("unknown or disabled condition grade", [input.condition_grade_code]);
      await this.assertCategory(tx, input.primary_category_id);
      const id = this.env.newId();
      const at = this.env.now();
      await tx.query(
        `INSERT INTO products (id, store_id, market_id, primary_category_id, condition_grade_code, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6)`,
        [id, storeId, this.env.marketId, input.primary_category_id, input.condition_grade_code, at],
      );
      await tx.query("INSERT INTO product_categories (product_id, category_id, store_id, is_primary) VALUES ($1,$2,$3,true)", [id, input.primary_category_id, storeId]);
      return this.view(tx, id);
    });
  }

  async updateDetails(actor: Principal, storeId: string, id: string, expectedVersion: number, raw: Details): Promise<SellerProductDto> {
    const input = DetailsInput.parse(raw);
    return await asStore(this.env, actor, "listing.write", storeId, async (tx) => {
      const p = await this.lock(tx, id, expectedVersion);
      ListingService.assertEditable(p);
      if (!hasArabicLetters(input.title_ar)) throw validation("the Arabic title must contain Arabic letters", ["TITLE_NOT_ARABIC"]);
      const categories = [...new Set([input.primary_category_id, ...(input.category_ids ?? [])])];
      for (const c of categories) await this.assertCategory(tx, c);
      assertAttributes(await loadAttributeSet(tx, input.primary_category_id), input.attributes, p.status !== "DRAFT");
      if (input.brand_id !== undefined && (await tx.query("SELECT 1 FROM brands WHERE id = $1", [input.brand_id])).rows.length === 0) throw validation("unknown brand", [input.brand_id]);
      await tx.query(
        `UPDATE products SET title_ar = $2, title_en = $3, description_ar = $4, description_en = $5, brand_id = $6, primary_category_id = $7, attributes = $8::jsonb,
                size_chart_id = $9, warranty_months = $10, warranty_kind = $11, included_accessories_ar = $12, origin_country = $13
          WHERE id = $1`,
        [id, input.title_ar, input.title_en ?? null, input.description_ar, input.description_en ?? null, input.brand_id ?? null, input.primary_category_id, JSON.stringify(input.attributes),
         input.size_chart_id ?? null, input.warranty_months ?? null, input.warranty_kind ?? null, input.included_accessories_ar ?? null, input.origin_country ?? null],
      );
      await tx.query("DELETE FROM product_categories WHERE product_id = $1", [id]);
      for (const c of categories) await tx.query("INSERT INTO product_categories (product_id, category_id, store_id, is_primary) VALUES ($1,$2,$3,$4)", [id, c, storeId, c === input.primary_category_id]);
      await this.touch(tx, id);
      await this.afterChange(tx, id, storeId);
      return this.view(tx, id);
    });
  }

  async setConditionAndMedia(actor: Principal, storeId: string, id: string, expectedVersion: number, raw: Photos): Promise<SellerProductDto> {
    const input = PhotosConditionInput.parse(raw);
    return await asStore(this.env, actor, "listing.write", storeId, async (tx) => {
      ListingService.assertEditable(await this.lock(tx, id, expectedVersion));
      const grade = await loadGrade(tx, input.condition_grade_code);
      if (grade?.active !== true) throw validation("unknown or disabled condition grade", [input.condition_grade_code]);
      if (new Set(input.media.map((m) => m.position)).size !== input.media.length) throw validation("media positions must be unique");
      await tx.query("UPDATE products SET condition_grade_code = $2, stock_reason = $3 WHERE id = $1", [id, input.condition_grade_code, input.stock_reason ?? null]);
      await tx.query("DELETE FROM product_media WHERE product_id = $1", [id]);
      for (const m of input.media) {
        await tx.query("INSERT INTO product_media (id, product_id, store_id, media_id, role, position, alt_ar, alt_en) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [
          this.env.newId(), id, storeId, m.media_id, m.role, m.position, m.alt_ar ?? null, m.alt_en ?? null,
        ]);
      }
      await this.touch(tx, id);
      await this.afterChange(tx, id, storeId);
      return this.view(tx, id);
    });
  }

  /**
   * Goes live. Order matters: a transition that the state machine forbids is reported first (invalid_transition), then every
   * missing requirement at once (activation_blocked with the reason codes). Emits listing.activated in the same transaction.
   */
  async activate(actor: Principal, storeId: string, id: string, expectedVersion: number): Promise<SellerProductDto> {
    return await asStore(this.env, actor, "listing.write", storeId, async (tx) => {
      const locked = await this.lock(tx, id, expectedVersion);
      const target = locked.status === "DRAFT" ? transitionPath("DRAFT", "IN_REVIEW", "PUBLISHED") : transition(locked.status, "PUBLISHED");
      const p = await this.row(tx, id);
      const reasons = await this.reasons(tx, p);
      if (reasons.length > 0) throw new CatalogError("activation_blocked", "listing cannot be activated", reasons);
      await tx.query("UPDATE products SET status = $2, published_at = COALESCE(published_at, $3) WHERE id = $1", [id, target, this.env.now()]);
      if (p.defect_card_id !== null) await tx.query("UPDATE defect_cards SET published_at = $2 WHERE id = $1 AND published_at IS NULL", [p.defect_card_id, this.env.now()]);
      await this.touch(tx, id);
      await projectStore(this.env, tx, storeId);
      await projectListing(this.env, tx, id);
      const skus = (await loadSkus(tx, id)).filter((s) => s.status === "active");
      const after = await this.row(tx, id);
      await emit(
        this.env, tx, "listing.activated", "listing", id,
        { listing_id: id, store_id: storeId, version: after.version, status: after.status, skus: skus.map((s) => ({ sku_id: s.id, price_minor: s.price_minor, currency: s.currency })) },
        "internal",
      );
      return this.view(tx, id);
    });
  }

  pause(actor: Principal, storeId: string, id: string, expectedVersion: number): Promise<SellerProductDto> {
    return this.move(actor, storeId, id, expectedVersion, "PAUSED");
  }

  /** PAUSED or SOLD_OUT back to PUBLISHED. Goes through the same readiness check as the first activation. */
  resume(actor: Principal, storeId: string, id: string, expectedVersion: number): Promise<SellerProductDto> {
    return this.activate(actor, storeId, id, expectedVersion);
  }

  archive(actor: Principal, storeId: string, id: string, expectedVersion: number): Promise<SellerProductDto> {
    return this.move(actor, storeId, id, expectedVersion, "ARCHIVED");
  }

  // ---------------------------------------------------------------- internals
  private async move(actor: Principal, storeId: string, id: string, expectedVersion: number, to: ListingStatus): Promise<SellerProductDto> {
    return await asStore(this.env, actor, "listing.write", storeId, async (tx) => {
      const locked = await this.lock(tx, id, expectedVersion);
      transition(locked.status, to);
      await tx.query("UPDATE products SET status = $2 WHERE id = $1", [id, to]);
      await this.touch(tx, id);
      await projectListing(this.env, tx, id);
      const after = await this.row(tx, id);
      await emit(this.env, tx, "listing.updated", "listing", id, { listing_id: id, store_id: storeId, version: after.version, status: after.status }, "internal");
      return this.view(tx, id);
    });
  }

  private lock(tx: Queryable, id: string, expectedVersion: number): Promise<Locked> {
    return lockProduct(tx, id, expectedVersion);
  }

  private static assertEditable(l: Locked): void {
    if (!EDITABLE.includes(l.status)) throw new CatalogError("conflict", `listing is ${l.status} and cannot be edited`);
  }

  /** Bumps the optimistic version and the search version once per logical change. */
  private async touch(tx: Queryable, id: string): Promise<void> {
    await tx.query("UPDATE products SET version = version + 1, search_version = search_version + 1, updated_at = $2 WHERE id = $1", [id, this.env.now()]);
  }

  /** After an edit of a shopper-visible listing: refresh the read model and announce it. */
  private async afterChange(tx: Queryable, id: string, storeId: string): Promise<void> {
    const p = await this.row(tx, id);
    if (!PUBLIC_STATUSES.includes(p.status)) return;
    await projectListing(this.env, tx, id);
    await emit(this.env, tx, "listing.updated", "listing", id, { listing_id: id, store_id: storeId, version: p.version, status: p.status }, "internal");
  }

  private async row(tx: Queryable, id: string): Promise<ProductRow> {
    const p = (await tx.query<ProductRow>(`SELECT ${PRODUCT_COLS} FROM products WHERE id = $1`, [id])).rows[0];
    if (p === undefined) throw notFound("listing");
    return p;
  }

  private async assertCategory(tx: Queryable, categoryId: string): Promise<void> {
    if (!(await categoryUsable(tx, this.env.marketId, categoryId))) throw validation("category is not available in this market", [categoryId]);
    if ((await loadAttributeSet(tx, categoryId)).length === 0) throw validation("category has no attribute set (choose a leaf category)", [categoryId]);
  }

  private async reasons(tx: Queryable, p: ProductRow): Promise<string[]> {
    const grade = await loadGrade(tx, p.condition_grade_code);
    if (grade === undefined) throw validation("unknown condition grade");
    const set = await loadAttributeSet(tx, p.primary_category_id);
    const skus = await loadSkus(tx, p.id);
    const media = await loadMedia(tx, p.id);
    const card = p.defect_card_id === null ? undefined : await loadCard(tx, p.defect_card_id);
    const store = await loadStoreWithSeller(tx, p.store_id);
    if (store === undefined) throw notFound("store");
    return activationReasons({
      titleAr: p.title_ar,
      descriptionAr: p.description_ar,
      hasCategory: set.length > 0,
      attributeIssues: attributeIssues(set, p.attributes, true),
      grade: { code: grade.code, active: grade.active, requiresDefectCard: grade.requires_defect_card, requiresConditionPhoto: grade.requires_condition_photo },
      defectCard: card === undefined ? null : { gradeCode: card.card.grade_code, itemCount: card.items.length },
      mediaRoles: media.map((m) => m.role),
      activeVariantPrices: skus.filter((s) => s.status === "active").map((s) => BigInt(s.price_minor)),
      seller: { status: store.seller_status, legalNameAr: store.legal_name_ar, commercialRegisterNo: store.commercial_register_no, taxCardNo: store.tax_card_no, governorateNameAr: store.governorate_name_ar },
      storeStatus: store.status,
    });
  }

  /** Seller detail view: five statements (product, categories, skus, media, defect card + items), independent of the sku count. */
  private async view(tx: Queryable, id: string): Promise<SellerProductDto> {
    const p = await this.row(tx, id);
    const cats = (await tx.query<{ category_id: string }>("SELECT category_id FROM product_categories WHERE product_id = $1 ORDER BY is_primary DESC, category_id", [id])).rows;
    const skus = await loadSkus(tx, id);
    const media = await loadMedia(tx, id);
    const card = p.defect_card_id === null ? undefined : await loadCard(tx, p.defect_card_id);
    return SellerProduct.parse({
      id: p.id,
      status: p.status,
      title_ar: p.title_ar === "" ? null : p.title_ar,
      title_en: p.title_en,
      description_ar: p.description_ar === "" ? null : p.description_ar,
      description_en: p.description_en,
      brand_id: p.brand_id,
      primary_category_id: p.primary_category_id,
      category_ids: cats.map((c) => c.category_id),
      condition_grade_code: p.condition_grade_code,
      stock_reason: p.stock_reason,
      defect_card: card === undefined ? null : defectCardDto(this.env, card.card, card.items),
      attributes: p.attributes,
      colour_code: p.colour_code,
      size_chart_id: p.size_chart_id,
      warranty_months: p.warranty_months,
      warranty_kind: p.warranty_kind,
      included_accessories_ar: p.included_accessories_ar,
      origin_country: p.origin_country,
      media: media.map((m) => ({ id: m.id, role: m.role, position: m.position, media: mediaRef(this.env, m.media_id, { ar: m.alt_ar, en: m.alt_en }), defect_item_id: null })),
      skus: skus.map((s) => ({ id: s.id, seller_sku: s.seller_sku, gtin: s.gtin, option_values: s.option_values, size_label: s.size_label, price: { amount_minor: s.price_minor, currency: s.currency }, status: s.status, version: s.version })),
      published_at: p.published_at === null ? null : toIso(p.published_at),
      updated_at: toIso(p.updated_at),
      version: p.version,
    });
  }
}
