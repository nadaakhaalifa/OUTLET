import { withDbContext } from "@outlet/db";
import type { Queryable } from "@outlet/db";
import type { Principal } from "@outlet/policy";
import { SellerStore as SellerStoreSchema, StoreCreateInput, StorePatch } from "../domain/dto.js";
import type { SellerStore, StoreCreateInput as CreateInput, StoreDetail, StorePatch as Patch } from "../domain/dto.js";
import { CatalogError, notFound, validation } from "../domain/errors.js";
import { categoryUsable } from "./data.js";
import { asPublic, asStore, isUniqueViolation, makeEnv, requireAccess, toIso } from "./env.js";
import type { CatalogDeps, Env } from "./env.js";
import { emit } from "./events.js";
import { projectListing, projectStore } from "./projection.js";
import { authorize } from "@outlet/policy";

interface Row {
  id: string;
  seller_id: string;
  slug: string;
  display_name_ar: string;
  display_name_en: string | null;
  tagline_ar: string | null;
  tagline_en: string | null;
  kind: "local" | "global";
  ships_from_country: string;
  primary_category_id: string | null;
  status: SellerStore["status"];
  verified_badge: boolean;
  health_score: number | null;
  price_trust_score: number | null;
  discount_display_mode: SellerStore["discount_display_mode"];
  followers_count: number;
  launched_at: Date | null;
  version: number;
}
const COLS = `id, seller_id, slug, display_name_ar, display_name_en, tagline_ar, tagline_en, kind, ships_from_country, primary_category_id, status,
  verified_badge, health_score, price_trust_score, discount_display_mode, followers_count, launched_at, version`;

const dto = (r: Row): SellerStore => SellerStoreSchema.parse({ ...r, launched_at: r.launched_at === null ? null : toIso(r.launched_at) });

interface PublicRow {
  id: string;
  slug: string;
  display_name_ar: string;
  display_name_en: string | null;
  tagline_ar: string | null;
  tagline_en: string | null;
  kind: "local" | "global";
  status: "ACTIVE" | "VACATION";
  verified_badge: boolean;
  price_trust_score: number | null;
  followers_count: number;
  ships_from_country: string;
  discount_display_mode: "public" | "member_only" | "hidden";
  legal_identity: StoreDetail["legal_identity"];
}

export class StoreService {
  private readonly env: Env;
  constructor(deps: CatalogDeps) {
    this.env = makeEnv(deps);
  }

  /**
   * Seller owner creates a store. The new store id is generated first and the transaction runs in that store's context,
   * so RLS accepts the INSERT. The policy check treats the new id as the owner's own store.
   * Known gap: the link seller staff -> seller (seller_id) is not built yet, so seller_id is trusted from the caller;
   * the seller must exist in this market and must not be suspended or closed.
   */
  async create(actor: Principal, raw: CreateInput): Promise<SellerStore> {
    const input = StoreCreateInput.parse(raw);
    const id = this.env.newId();
    const asOwner: Principal = { ...actor, storeIds: [...(actor.storeIds ?? []), id] };
    requireAccess(this.env, asOwner, "store.write", id);
    const at = this.env.now();
    try {
      return await withDbContext(this.env.client, { kind: "store", marketId: this.env.marketId, storeId: id, ...(actor.userId === undefined ? {} : { userId: actor.userId }) }, async (tx) => {
        const seller = (await tx.query<{ status: string }>("SELECT status FROM sellers WHERE id = $1 AND market_id = $2", [input.seller_id, this.env.marketId])).rows[0];
        if (seller === undefined) throw notFound("seller");
        if (seller.status === "suspended" || seller.status === "closed") throw new CatalogError("conflict", `seller is ${seller.status}`);
        if (input.primary_category_id !== undefined && !(await categoryUsable(tx, this.env.marketId, input.primary_category_id))) throw validation("primary category is not available in this market");
        const r = await tx.query<Row>(
          `INSERT INTO stores (id, seller_id, market_id, slug, display_name_ar, display_name_en, tagline_ar, tagline_en, kind, ships_from_country, primary_category_id, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) RETURNING ${COLS}`,
          [id, input.seller_id, this.env.marketId, input.slug, input.display_name_ar, input.display_name_en ?? null, input.tagline_ar ?? null, input.tagline_en ?? null, input.kind, input.ships_from_country, input.primary_category_id ?? null, at],
        );
        const row = r.rows[0];
        if (row === undefined) throw new Error("store insert returned no row");
        return dto(row);
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new CatalogError("conflict", "store slug already taken in this market");
      throw e;
    }
  }

  /** Seller view of the own store (RLS: any other store is invisible, so a foreign id is not_found). */
  async getOwn(actor: Principal, storeId: string): Promise<SellerStore> {
    return await asStore(this.env, actor, "store.read", storeId, async (tx) => {
      const row = (await tx.query<Row>(`SELECT ${COLS} FROM stores WHERE id = $1`, [storeId])).rows[0];
      if (row === undefined) throw notFound("store");
      return dto(row);
    });
  }

  /** Admin moderation read (store.read for ops / trust_safety): the store in any status, or not_found. Runs in the store's own context like every store read. */
  async getForAdmin(admin: Principal, storeId: string): Promise<SellerStore> {
    this.requireAdminAction(admin, "store.read");
    return withDbContext(this.env.client, { kind: "store", marketId: this.env.marketId, storeId, ...(admin.userId === undefined ? {} : { userId: admin.userId }) }, async (tx) => {
      const row = (await tx.query<Row>(`SELECT ${COLS} FROM stores WHERE id = $1`, [storeId])).rows[0];
      if (row === undefined) throw notFound("store");
      return dto(row);
    });
  }

  private requireAdminAction(admin: Principal, action: "store.read" | "store.suspend" | "store.reinstate"): void {
    if (admin.kind !== "admin" || admin.userId === undefined) throw new CatalogError("forbidden", "forbidden");
    const d = authorize(admin, action, { type: "admin_console", marketId: this.env.marketId });
    if (d.effect === "deny") throw new CatalogError(d.reason, d.reason === "not_found" ? "not found" : "forbidden");
  }

  /**
   * Moderation status change (SellerOnboardingService.suspend/reinstate move the seller; this moves the store and the public read model).
   * suspend: ACTIVE or VACATION -> SUSPENDED, which deletes the store and all its listings from the published tables (projectStore).
   * reinstate: SUSPENDED -> ACTIVE (a vacation set before the suspension is not restored; there is no column for the prior status).
   * Idempotent: a store already in the target status is returned unchanged (an approval executor may run twice after a partial failure).
   * Listings keep their own status; reinstatement re-projects the store's published listings (suspension deleted them from the published tables).
   */
  async setModerationStatus(admin: Principal, storeId: string, to: "SUSPENDED" | "ACTIVE"): Promise<SellerStore> {
    this.requireAdminAction(admin, to === "SUSPENDED" ? "store.suspend" : "store.reinstate");
    return withDbContext(this.env.client, { kind: "store", marketId: this.env.marketId, storeId, ...(admin.userId === undefined ? {} : { userId: admin.userId }) }, async (tx) => {
      const cur = (await tx.query<Row>(`SELECT ${COLS} FROM stores WHERE id = $1 FOR UPDATE`, [storeId])).rows[0];
      if (cur === undefined) throw notFound("store");
      if (cur.status === to) return dto(cur);
      const from: readonly Row["status"][] = to === "SUSPENDED" ? ["ACTIVE", "VACATION"] : ["SUSPENDED"];
      if (!from.includes(cur.status)) throw new CatalogError("conflict", `store is ${cur.status}`);
      const r = await tx.query<Row>("UPDATE stores SET status = $2, version = version + 1, updated_at = $3 WHERE id = $1 RETURNING " + COLS, [storeId, to, this.env.now()]);
      const row = r.rows[0];
      if (row === undefined) throw notFound("store");
      await projectStore(this.env, tx, storeId);
      if (to === "ACTIVE") {
        // Bounded: a store with more published listings than this is re-projected by the next listing write.
        const ids = await tx.query<{ id: string }>("SELECT id FROM products WHERE store_id = $1 AND published_at IS NOT NULL ORDER BY id LIMIT 5000", [storeId]);
        for (const p of ids.rows) await projectListing(this.env, tx, p.id);
      }
      await emit(this.env, tx, "store.status_changed", "store", storeId, { from: cur.status, to });
      return dto(row);
    });
  }

  /** PATCH with If-Match: a stale version is a typed conflict. Keeps the public read model in step in the same transaction. */
  async update(actor: Principal, storeId: string, expectedVersion: number, rawPatch: Patch): Promise<SellerStore> {
    const patch = StorePatch.parse(rawPatch);
    return await asStore(this.env, actor, "store.write", storeId, async (tx) => {
      const cur = (await tx.query<{ version: number }>("SELECT version FROM stores WHERE id = $1 FOR UPDATE", [storeId])).rows[0];
      if (cur === undefined) throw notFound("store");
      if (cur.version !== expectedVersion) throw new CatalogError("conflict", "stale store version", [`current=${String(cur.version)}`, `expected=${String(expectedVersion)}`]);
      if (patch.primary_category_id !== undefined && !(await categoryUsable(tx, this.env.marketId, patch.primary_category_id))) throw validation("primary category is not available in this market");
      const sets: string[] = [];
      const params: unknown[] = [storeId, this.env.now()];
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) continue;
        params.push(v);
        sets.push(`${k} = $${String(params.length)}`); // k is a StorePatch key (strict schema), never user text
      }
      const r = await tx.query<Row>(`UPDATE stores SET ${[...sets, "version = version + 1", "updated_at = $2"].join(", ")} WHERE id = $1 RETURNING ${COLS}`, params);
      const row = r.rows[0];
      if (row === undefined) throw notFound("store");
      await projectStore(this.env, tx, storeId);
      return dto(row);
    });
  }

  // ---------------------------------------------------------------- public reads (published read model)
  async getStoreBySlug(slug: string): Promise<StoreDetail> {
    return await asPublic(this.env, (tx) => this.storeBySlug(tx, slug));
  }

  /** Same query, usable inside a larger public transaction (store page). */
  async storeBySlug(tx: Queryable, slug: string): Promise<StoreDetail> {
    const r = await tx.query<PublicRow>(
      `SELECT id, slug, display_name_ar, display_name_en, tagline_ar, tagline_en, kind, status, verified_badge, price_trust_score, followers_count,
              ships_from_country, discount_display_mode, legal_identity
         FROM catalog_public_stores WHERE market_id = $1 AND slug = $2`,
      [this.env.marketId, slug],
    );
    const s = r.rows[0];
    if (s === undefined) throw notFound("store");
    return {
      ...s,
      storefront: { template_code: "default", palette: {}, published_version: 0 },
      canonical_path: `/${this.env.marketId.toLowerCase()}/stores/${s.slug}`,
    };
  }
}
