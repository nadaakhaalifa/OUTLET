import { randomUUID } from "node:crypto";
import { assertTenantTablesProtected, withDbContext } from "@outlet/db";
import { OutboxWriter } from "@outlet/outbox";
import type { Principal } from "@outlet/policy";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CatalogError, DefectPassport, ProductCardPage, ProductDetail, SellerProduct, StoreDetail } from "../src/index.js";
import { DefectService, ListingService } from "../src/index.js";
import { countQueries, expectQueryCount } from "../src/testing.js";
import { CAT, SIZE_RUN, WOMEN_ATTRS, anonymous, buildListing, buildWorld, errorOf, projectStoreViaPatch, staff } from "./fixtures.js";
import type { World } from "./fixtures.js";

let w: World;
beforeAll(async () => {
  w = await buildWorld();
});
afterAll(async () => {
  await w.close();
});

const A = (): ReturnType<typeof staff> => staff([w.seed.storeA]);
const B = (): ReturnType<typeof staff> => staff([w.seed.storeB]);

const events = async (type?: string): Promise<{ event_type: string; aggregate_id: string; payload: Record<string, unknown>; visibility: string }[]> =>
  (
    await w.raw.query<{ event_type: string; aggregate_id: string; payload: Record<string, unknown>; visibility: string }>(
      "SELECT event_type, aggregate_id, payload, visibility FROM outbox_events WHERE ($1::text IS NULL OR event_type = $1) ORDER BY occurred_at, id",
      [type ?? null],
    )
  ).rows;

describe("migration, taxonomy and RLS audit", () => {
  it("passes the RLS audit with every catalog tenant table protected and no new exception policies", async () => {
    const rows = await assertTenantTablesProtected(w.raw);
    const names = rows.map((r) => r.table);
    for (const t of ["products", "skus", "product_media", "product_categories", "defect_cards", "defect_items", "item_units"]) expect(names).toContain(t);
    const pol = await w.raw.query<{ polname: string }>("SELECT polname FROM pg_policy WHERE polname LIKE '%public%'");
    expect(pol.rows).toEqual([]);
  });

  it("the published read model has no tenant column and no personal columns", async () => {
    const cols = await w.raw.query<{ table_name: string; column_name: string }>(
      "SELECT table_name, column_name FROM information_schema.columns WHERE table_name LIKE 'catalog_public_%'",
    );
    expect(cols.rows.filter((c) => ["store_id", "user_id"].includes(c.column_name))).toEqual([]);
    expect(cols.rows.filter((c) => /phone|email|dob|address|national_id|user/.test(c.column_name))).toEqual([]);
  });

  it("seeds the D6 launch tree with AR and EN names for EG only", async () => {
    const tree = await w.categories.tree("en");
    const fashion = tree[0];
    expect(fashion?.code).toBe("fashion");
    expect(fashion?.children.map((c) => c.code)).toEqual(["women", "modest", "kids"]);
    expect(fashion?.children[0]?.children.map((c) => c.code)).toEqual(["women_dresses", "women_tops", "women_bottoms", "women_outerwear"]);
    const ar = await w.categories.tree("ar");
    expect(ar[0]?.name).toBe("أزياء");
    expect(ar[0]?.children[1]?.name).toBe("أزياء محتشمة");
    const other = new (await import("../src/index.js")).CategoryService({ ...w.deps, marketId: "SA" });
    expect(await other.tree()).toEqual([]);
  });

  it("pages categories by path with a keyset cursor and finds one by code", async () => {
    const p1 = await w.categories.list({ locale: "en", limit: 5 });
    expect(p1.items).toHaveLength(5);
    expect(p1.next_cursor).not.toBeNull();
    const p2 = await w.categories.list({ locale: "en", limit: 50, ...(p1.next_cursor === null ? {} : { cursor: p1.next_cursor }) });
    expect(p1.items.length + p2.items.length).toBe(14);
    expect(p2.next_cursor).toBeNull();
    expect(new Set([...p1.items, ...p2.items].map((c) => c.id)).size).toBe(14);
    expect((await w.categories.getByCode("kids_girls", "en")).name).toBe("Girls");
    expect(await errorOf(w.categories.getByCode("nope"))).toMatchObject({ code: "not_found" });
    expect(await errorOf(w.categories.list({ limit: 51 }))).toMatchObject({ code: "validation" });
    expect(await errorOf(w.categories.list({ cursor: Buffer.from("A/B").toString("base64url") }))).toMatchObject({ code: "validation" });
  });

  it("each launch attribute set exists with its required attributes (kids needs drawstring_free, modest needs coverage)", async () => {
    const r = await w.raw.query<{ code: string; attribute_code: string }>(
      "SELECT s.code, i.attribute_code FROM attribute_sets s JOIN attribute_set_items i ON i.attribute_set_id = s.id WHERE i.required ORDER BY 1, 2",
    );
    const by = (c: string): string[] => r.rows.filter((x) => x.code === c).map((x) => x.attribute_code);
    expect(by("fashion_kids")).toContain("drawstring_free");
    expect(by("fashion_modest")).toContain("coverage");
    expect(by("fashion_women")).toEqual(["colour", "material", "size_run"]);
  });
});

describe("brands", () => {
  it("registers once per normalised name, returns the existing brand, starts unverified", async () => {
    const a = await w.brands.register(A(), w.seed.storeA, "Zara");
    const b = await w.brands.register(B(), w.seed.storeB, "  ZARA ");
    expect(b.id).toBe(a.id);
    expect(a).toMatchObject({ name: "Zara", slug: "zara", is_verified: false });
    const ar1 = await w.brands.register(A(), w.seed.storeA, "أديداس");
    const ar2 = await w.brands.register(A(), w.seed.storeA, "اديداس");
    expect(ar2.id).toBe(ar1.id);
    expect(ar1.slug).toMatch(/^brand-[0-9a-f]{6}$/);
    expect((await w.brands.getBySlug("zara")).id).toBe(a.id);
    expect((await w.brands.list(50)).length).toBeGreaterThanOrEqual(2);
    expect(await w.brands.list(1)).toHaveLength(1);
    expect(await w.brands.list(50, "zara")).toEqual([]);
  });

  it("handles a slug clash between different names, bad input and missing brands", async () => {
    const x = await w.brands.register(A(), w.seed.storeA, "H&M");
    const y = await w.brands.register(A(), w.seed.storeA, "H M");
    expect(y.id).not.toBe(x.id);
    expect(y.slug).not.toBe(x.slug);
    expect(await errorOf(w.brands.register(A(), w.seed.storeA, "  "))).toMatchObject({ code: "validation" });
    expect(await errorOf(w.brands.getBySlug("nope"))).toMatchObject({ code: "not_found" });
    expect(await errorOf(w.brands.list(0))).toMatchObject({ code: "validation" });
  });

  it("requires listing.write on the store", async () => {
    expect(await errorOf(w.brands.register(staff([w.seed.storeA], ["support"]), w.seed.storeA, "Mango"))).toMatchObject({ code: "forbidden" });
    expect(await errorOf(w.brands.register(A(), w.seed.storeB, "Mango"))).toMatchObject({ code: "not_found" });
  });
});

describe("stores", () => {
  it("creates a store as seller owner, enforces slug uniqueness per market and the seller state", async () => {
    const owner = staff([]);
    const s = await w.stores.create(owner, { seller_id: w.seed.sellerA, slug: "brand-street-one", display_name_ar: "شارع البراند", kind: "local", ships_from_country: "EG", primary_category_id: CAT.women });
    expect(s).toMatchObject({ slug: "brand-street-one", status: "DRAFT", version: 1, seller_id: w.seed.sellerA });
    expect(await errorOf(w.stores.create(owner, { seller_id: w.seed.sellerA, slug: "brand-street-one", display_name_ar: "م", kind: "local", ships_from_country: "EG" }))).toMatchObject({ code: "conflict" });
    expect(await errorOf(w.stores.create(owner, { seller_id: randomUUID(), slug: "ghost", display_name_ar: "م", kind: "local", ships_from_country: "EG" }))).toMatchObject({ code: "not_found" });
    expect(await errorOf(w.stores.create(staff([], ["support"]), { seller_id: w.seed.sellerA, slug: "support-store", display_name_ar: "م", kind: "local", ships_from_country: "EG" }))).toMatchObject({ code: "forbidden" });
    expect(await errorOf(w.stores.create(owner, { seller_id: w.seed.sellerA, slug: "bad-cat", display_name_ar: "م", kind: "local", ships_from_country: "EG", primary_category_id: randomUUID() }))).toMatchObject({ code: "validation" });
    await w.raw.query("UPDATE sellers SET status = 'suspended' WHERE id = $1", [w.seed.sellerDraft]);
    expect(await errorOf(w.stores.create(owner, { seller_id: w.seed.sellerDraft, slug: "suspended-one", display_name_ar: "م", kind: "local", ships_from_country: "EG" }))).toMatchObject({ code: "conflict" });
    await w.raw.query("UPDATE sellers SET status = 'draft' WHERE id = $1", [w.seed.sellerDraft]);
  });

  it("updates with If-Match semantics and keeps the public read model in step", async () => {
    await projectStoreViaPatch(w, w.seed.storeA);
    const cur = await w.stores.getOwn(A(), w.seed.storeA);
    const next = await w.stores.update(A(), w.seed.storeA, cur.version, { display_name_ar: "متجر أ المحدث", discount_display_mode: "member_only" });
    expect(next.version).toBe(cur.version + 1);
    const pub = StoreDetail.parse(await w.stores.getStoreBySlug("store-a"));
    expect(pub).toMatchObject({ display_name_ar: "متجر أ المحدث", discount_display_mode: "member_only", status: "ACTIVE", canonical_path: "/eg/stores/store-a" });
    expect(pub.legal_identity).toEqual({ legal_name_ar: "شركة A", legal_name_en: "Company A", commercial_register_no: "CR-A", tax_card_no: "TX-A", governorate_name_ar: "القاهرة" });
    expect(await errorOf(w.stores.update(A(), w.seed.storeA, cur.version, { tagline_ar: "x" }))).toMatchObject({ code: "conflict", details: [`current=${String(next.version)}`, `expected=${String(cur.version)}`] });
    expect(await errorOf(w.stores.update(A(), w.seed.storeA, next.version, { primary_category_id: randomUUID() }))).toMatchObject({ code: "validation" });
    expect(await errorOf(w.stores.getStoreBySlug("missing"))).toMatchObject({ code: "not_found" });
  });

  it("admin moderation: suspend hides the store and its listings, reinstate brings them back, both are idempotent, audited by event", async () => {
    const admin = (roles: string[]): Principal => ({ kind: "admin", userId: randomUUID(), marketId: "EG", roles, scopes: [] });
    await projectStoreViaPatch(w, w.seed.storeB);
    expect(await errorOf(w.stores.setModerationStatus(admin(["finance"]), w.seed.storeB, "SUSPENDED"))).toMatchObject({ code: "forbidden" });
    expect(await errorOf(w.stores.setModerationStatus(A(), w.seed.storeB, "SUSPENDED"))).toMatchObject({ code: "forbidden" });
    expect(await errorOf(w.stores.setModerationStatus(admin(["ops"]), randomUUID(), "SUSPENDED"))).toMatchObject({ code: "not_found" });
    expect((await w.stores.getForAdmin(admin(["ops"]), w.seed.storeB)).status).toBe("ACTIVE");
    const off = await w.stores.setModerationStatus(admin(["trust_safety"]), w.seed.storeB, "SUSPENDED");
    expect(off.status).toBe("SUSPENDED");
    expect(await errorOf(w.stores.getStoreBySlug("store-b"))).toMatchObject({ code: "not_found" });
    expect((await w.raw.query("SELECT 1 FROM catalog_public_listings WHERE store_ref = $1", [w.seed.storeB])).rows).toHaveLength(0);
    expect((await w.stores.setModerationStatus(admin(["ops"]), w.seed.storeB, "SUSPENDED")).version).toBe(off.version);
    const on = await w.stores.setModerationStatus(admin(["ops"]), w.seed.storeB, "ACTIVE");
    expect(on.status).toBe("ACTIVE");
    expect((await w.stores.getStoreBySlug("store-b")).slug).toBe("store-b");
    expect((await w.raw.query("SELECT 1 FROM outbox_events WHERE event_type = 'store.status_changed' AND aggregate_id = $1", [w.seed.storeB])).rows).toHaveLength(2);
    await w.raw.query("UPDATE stores SET status = 'DRAFT' WHERE id = $1", [w.seed.storeB]);
    expect(await errorOf(w.stores.setModerationStatus(admin(["ops"]), w.seed.storeB, "SUSPENDED"))).toMatchObject({ code: "conflict" });
    await w.raw.query("UPDATE stores SET status = 'ACTIVE' WHERE id = $1", [w.seed.storeB]);
  });

  it("hides a store from the public model when it is no longer active", async () => {
    await projectStoreViaPatch(w, w.seed.storeB);
    expect((await w.stores.getStoreBySlug("store-b")).slug).toBe("store-b");
    await w.raw.query("UPDATE stores SET status = 'SUSPENDED' WHERE id = $1", [w.seed.storeB]);
    await projectStoreViaPatch(w, w.seed.storeB);
    expect(await errorOf(w.stores.getStoreBySlug("store-b"))).toMatchObject({ code: "not_found" });
    await w.raw.query("UPDATE stores SET status = 'ACTIVE' WHERE id = $1", [w.seed.storeB]);
    await projectStoreViaPatch(w, w.seed.storeB);
    expect((await w.stores.getStoreBySlug("store-b")).slug).toBe("store-b");
  });

  it("tenant isolation: another store, another market and the wrong role", async () => {
    expect(await errorOf(w.stores.getOwn(B(), w.seed.storeA))).toMatchObject({ code: "not_found" });
    expect(await errorOf(w.stores.getOwn(staff([w.seed.storeA], ["owner"], "SA"), w.seed.storeA))).toMatchObject({ code: "not_found" });
    expect(await errorOf(w.stores.getOwn(staff([w.seed.storeA], ["warehouse"]), w.seed.storeA))).toMatchObject({ code: "forbidden" });
    expect(await errorOf(w.stores.update(staff([w.seed.storeA], ["catalog"]), w.seed.storeA, 1, { tagline_ar: "x" }))).toMatchObject({ code: "forbidden" });
    expect(await errorOf(w.stores.getOwn(anonymous(), w.seed.storeA))).toMatchObject({ code: "forbidden" });
    expect(await errorOf(w.stores.getOwn({ kind: "shopper", userId: randomUUID(), marketId: "EG", roles: [], scopes: [] }, w.seed.storeA))).toMatchObject({ code: "forbidden" });
  });
});

describe("listing lifecycle, activation rules and events", () => {
  it("happy path: draft, details, media, variant, activate, public read, events in order", async () => {
    const before = (await events()).length;
    const p = await buildListing(w, w.seed.storeA, A());
    expect(p).toMatchObject({ status: "DRAFT", title_ar: "فستان صيفي", colour_code: "black", category_ids: [CAT.womenDresses] });
    expect((await events()).slice(before).map((e) => e.event_type)).toEqual(["price.changed"]);

    const live = await w.listings.activate(A(), w.seed.storeA, p.id, p.version);
    expect(live.status).toBe("PUBLISHED");
    expect(live.published_at).not.toBeNull();
    const ev = (await events()).slice(before);
    expect(ev.map((e) => e.event_type)).toEqual(["price.changed", "listing.activated"]);
    expect(ev[0]?.payload).toMatchObject({ old_price_minor: null, new_price_minor: "129900", currency: "EGP", source: "seller", product_id: p.id, store_id: w.seed.storeA });
    expect(ev[1]?.payload).toMatchObject({ listing_id: p.id, status: "PUBLISHED", version: live.version });

    const detail = ProductDetail.parse(await w.pub.getListing(p.id));
    expect(detail).toMatchObject({ title_ar: "فستان صيفي", status: "PUBLISHED", condition_grade: { code: "new_with_tags", schema_org_condition: "NewCondition" }, canonical_path: `/eg/products/${p.id}` });
    expect(detail.skus[0]?.price).toEqual({ current_price: { amount_minor: "129900", currency: "EGP" }, claim_type: "plain", price_proof_path: `/eg/products/${p.id}/price-evidence` });
    expect(detail.store.legal_identity.commercial_register_no).toBe("CR-A");
    expect(JSON.stringify(detail)).not.toMatch(/reference_price|display_discount|compare_at/);
    expect(w.listings).toBeInstanceOf(ListingService);
  });

  it("does not show an unpublished listing or another market's id", async () => {
    const draft = await buildListing(w, w.seed.storeA, A());
    expect(await errorOf(w.pub.getListing(draft.id))).toMatchObject({ code: "not_found" });
    const other = new (await import("../src/index.js")).PublicCatalogService({ ...w.deps, marketId: "SA" });
    const live = await w.listings.activate(A(), w.seed.storeA, draft.id, draft.version);
    expect(await errorOf(other.getListing(live.id))).toMatchObject({ code: "not_found" });
  });

  it("blocks activation with the exact reasons, changes nothing and emits no activation event", async () => {
    const before = (await events("listing.activated")).length;
    const p = await buildListing(w, w.seed.storeA, A(), { skip: ["media", "variant"], attrs: { colour: "black" } });
    const e = await errorOf(w.listings.activate(A(), w.seed.storeA, p.id, p.version));
    expect(e.code).toBe("activation_blocked");
    expect(e.details).toEqual(["ATTRIBUTES_INCOMPLETE", "NO_ACTIVE_VARIANT", "MAIN_PHOTO_REQUIRED"]);
    const ready = await w.listings.readiness(A(), w.seed.storeA, p.id);
    expect(ready).toMatchObject({ status: "DRAFT", blocked_reasons: e.details });
    expect((await w.listings.get(A(), w.seed.storeA, p.id)).status).toBe("DRAFT");
    expect((await events("listing.activated")).length).toBe(before);
    expect(await w.raw.query("SELECT 1 FROM catalog_public_listings WHERE id = $1", [p.id])).toMatchObject({ rows: [] });
  });

  it("requires an Arabic title and description (CPL 181/2018)", async () => {
    const p = await buildListing(w, w.seed.storeA, A(), { skip: ["details", "variant"] });
    expect((await w.listings.readiness(A(), w.seed.storeA, p.id)).blocked_reasons).toEqual(expect.arrayContaining(["TITLE_AR_REQUIRED", "DESCRIPTION_AR_REQUIRED"]));
    const e = await errorOf(w.listings.updateDetails(A(), w.seed.storeA, p.id, p.version, { title_ar: "Summer dress", description_ar: "وصف", primary_category_id: CAT.womenDresses, attributes: WOMEN_ATTRS }));
    expect(e).toMatchObject({ code: "validation", details: ["TITLE_NOT_ARABIC"] });
    expect((await errorOf(w.raw.query("UPDATE products SET status = 'PUBLISHED' WHERE id = $1", [p.id]))).message).toContain("check");
  });

  it("seller legal identity must be complete on the seller (draft seller cannot go live)", async () => {
    const owner = staff([w.seed.storeDraft]);
    const p = await buildListing(w, w.seed.storeDraft, owner);
    const e = await errorOf(w.listings.activate(owner, w.seed.storeDraft, p.id, p.version));
    expect(e.details).toEqual(["SELLER_NOT_ACTIVE", "SELLER_LEGAL_IDENTITY_INCOMPLETE"]);
    await w.raw.query("UPDATE stores SET status = 'VACATION' WHERE id = $1", [w.seed.storeDraft]);
    expect((await errorOf(w.listings.activate(owner, w.seed.storeDraft, p.id, p.version))).details).toContain("STORE_NOT_ACTIVE");
    await w.raw.query("UPDATE stores SET status = 'ACTIVE' WHERE id = $1", [w.seed.storeDraft]);
  });

  it("defect grades need a card with at least one photographed defect, and a condition photo", async () => {
    const p = await buildListing(w, w.seed.storeA, A(), { grade: "new_with_imperfections", skip: ["card", "conditionPhoto"] });
    expect((await errorOf(w.listings.activate(A(), w.seed.storeA, p.id, p.version))).details).toEqual(["DEFECT_CARD_REQUIRED", "CONDITION_PHOTO_REQUIRED"]);
    const ok = await buildListing(w, w.seed.storeA, A(), { grade: "new_with_imperfections" });
    expect(ok.defect_card).toMatchObject({ version: 1, grade_code: "new_with_imperfections", defect_count: 1 });
    const live = await w.listings.activate(A(), w.seed.storeA, ok.id, ok.version);
    expect(live.defect_card?.published_at).not.toBeNull();
    const pub = await w.pub.getListing(ok.id);
    expect(pub.defect_card?.items[0]).toMatchObject({ defect_type_code: "stain", label_ar: "بقعة أو تغير لون", severity: "minor" });
    expect(pub.condition_grade.schema_org_condition).toBe("DamagedCondition");
    // changing the grade after the card was written is caught at activation
    const mismatch = await buildListing(w, w.seed.storeA, A(), { grade: "new_with_imperfections" });
    const switched = await w.listings.setConditionAndMedia(A(), w.seed.storeA, mismatch.id, mismatch.version, { media: [{ media_id: randomUUID(), role: "main", position: 0 }, { media_id: randomUUID(), role: "condition", position: 1 }], condition_grade_code: "open_box" });
    expect((await errorOf(w.listings.activate(A(), w.seed.storeA, switched.id, switched.version))).details).toEqual(["DEFECT_CARD_GRADE_MISMATCH"]);
  });

  it("rejects disabled or unknown grades and categories without an attribute set", async () => {
    expect(await errorOf(w.listings.createDraft(A(), w.seed.storeA, { condition_grade_code: "refurbished", primary_category_id: CAT.womenDresses }))).toMatchObject({ code: "validation" });
    expect(await errorOf(w.listings.createDraft(A(), w.seed.storeA, { condition_grade_code: "nope", primary_category_id: CAT.womenDresses }))).toMatchObject({ code: "validation" });
    expect(await errorOf(w.listings.createDraft(A(), w.seed.storeA, { condition_grade_code: "new_with_tags", primary_category_id: CAT.fashion }))).toMatchObject({ code: "validation" });
    expect(await errorOf(w.listings.createDraft(A(), w.seed.storeA, { condition_grade_code: "new_with_tags", primary_category_id: randomUUID() }))).toMatchObject({ code: "validation" });
  });

  it("modest and kids categories validate their own sets (multi-category ready)", async () => {
    const modest = await buildListing(w, w.seed.storeA, A(), { categoryId: CAT.modestAbayas, attrs: { ...WOMEN_ATTRS, coverage: "full", sleeve_length: "long" } });
    expect((await w.listings.activate(A(), w.seed.storeA, modest.id, modest.version)).status).toBe("PUBLISHED");
    const missing = await buildListing(w, w.seed.storeA, A(), { categoryId: CAT.modestAbayas, skip: ["details", "variant"] });
    const e = await errorOf(w.listings.updateDetails(A(), w.seed.storeA, missing.id, missing.version, { title_ar: "عباية", description_ar: "وصف", primary_category_id: CAT.modestAbayas, attributes: { ...WOMEN_ATTRS, coverage: "full", sleeve_length: "long" } }));
    expect(e.code).toBeUndefined();
    const kids = await buildListing(w, w.seed.storeA, A(), { categoryId: CAT.kidsGirls, attrs: { ...WOMEN_ATTRS, age_group: "kids", drawstring_free: true } });
    expect(kids.primary_category_id).toBe(CAT.kidsGirls);
    const noSafety = await buildListing(w, w.seed.storeA, A(), { categoryId: CAT.kidsGirls, skip: ["details", "variant"] });
    const upd = await w.listings.updateDetails(A(), w.seed.storeA, noSafety.id, noSafety.version, { title_ar: "فستان بنات", description_ar: "وصف", primary_category_id: CAT.kidsGirls, attributes: { colour: "pink" } });
    expect((await w.listings.readiness(A(), w.seed.storeA, upd.id)).blocked_reasons).toContain("ATTRIBUTES_INCOMPLETE");
    expect(await errorOf(w.listings.updateDetails(A(), w.seed.storeA, upd.id, upd.version, { title_ar: "فستان بنات", description_ar: "وصف", primary_category_id: CAT.kidsGirls, attributes: { colour: "neon" } }))).toMatchObject({ code: "validation" });
  });

  it("pause, resume, archive follow the machine; invalid moves are typed", async () => {
    const p = await buildListing(w, w.seed.storeA, A());
    expect(await errorOf(w.listings.pause(A(), w.seed.storeA, p.id, p.version))).toMatchObject({ code: "invalid_transition" });
    const live = await w.listings.activate(A(), w.seed.storeA, p.id, p.version);
    expect(await errorOf(w.listings.activate(A(), w.seed.storeA, p.id, live.version))).toMatchObject({ code: "invalid_transition" });
    const paused = await w.listings.pause(A(), w.seed.storeA, p.id, live.version);
    expect(paused.status).toBe("PAUSED");
    expect((await w.pub.getListing(p.id)).status).toBe("PAUSED");
    const resumed = await w.listings.resume(A(), w.seed.storeA, p.id, paused.version);
    expect(resumed.status).toBe("PUBLISHED");
    const gone = await w.listings.archive(A(), w.seed.storeA, p.id, resumed.version);
    expect(gone.status).toBe("ARCHIVED");
    expect(await errorOf(w.pub.getListing(p.id))).toMatchObject({ code: "not_found" });
    expect(await errorOf(w.listings.resume(A(), w.seed.storeA, p.id, gone.version))).toMatchObject({ code: "invalid_transition" });
    expect(await errorOf(w.listings.updateDetails(A(), w.seed.storeA, p.id, gone.version, { title_ar: "فستان", description_ar: "وصف", primary_category_id: CAT.womenDresses, attributes: WOMEN_ATTRS }))).toMatchObject({ code: "conflict" });
    expect(await errorOf(w.listings.setConditionAndMedia(A(), w.seed.storeA, p.id, gone.version, { media: [{ media_id: randomUUID(), role: "main", position: 0 }], condition_grade_code: "new_with_tags" }))).toMatchObject({ code: "conflict" });
    const updates = (await events("listing.updated")).filter((e) => e.aggregate_id === p.id).map((e) => e.payload.status);
    expect(updates).toEqual(["PAUSED", "ARCHIVED"]);
    expect((await events("listing.activated")).filter((e) => e.aggregate_id === p.id)).toHaveLength(2);
  });

  it("optimistic locking: a stale version is a typed CONFLICT and a replay of the same version loses", async () => {
    const p = await buildListing(w, w.seed.storeA, A());
    const input = { title_ar: "فستان جديد", description_ar: "وصف", primary_category_id: CAT.womenDresses, attributes: WOMEN_ATTRS };
    const first = await w.listings.updateDetails(A(), w.seed.storeA, p.id, p.version, input);
    expect(first.version).toBe(p.version + 1);
    const stale = await errorOf(w.listings.updateDetails(A(), w.seed.storeA, p.id, p.version, { ...input, title_ar: "فستان آخر" }));
    expect(stale).toMatchObject({ code: "conflict", message: "stale listing version" });
    expect((await w.listings.get(A(), w.seed.storeA, p.id)).title_ar).toBe("فستان جديد");
    for (const op of [
      w.listings.setConditionAndMedia(A(), w.seed.storeA, p.id, p.version, { media: [{ media_id: randomUUID(), role: "main", position: 0 }], condition_grade_code: "new_with_tags" }),
      w.listings.activate(A(), w.seed.storeA, p.id, p.version),
      w.listings.archive(A(), w.seed.storeA, p.id, p.version),
    ]) expect(await errorOf(op)).toMatchObject({ code: "conflict" });
  });

  it("keeps the public row current when a published listing or its price changes", async () => {
    const p = await buildListing(w, w.seed.storeA, A());
    const live = await w.listings.activate(A(), w.seed.storeA, p.id, p.version);
    const before = (await events("listing.updated")).length;
    await w.listings.updateDetails(A(), w.seed.storeA, p.id, live.version, { title_ar: "فستان معدل", description_ar: "وصف", primary_category_id: CAT.womenDresses, attributes: WOMEN_ATTRS, brand_id: (await w.brands.register(A(), w.seed.storeA, "Zara")).id });
    const pub = await w.pub.getListing(p.id);
    expect(pub).toMatchObject({ title_ar: "فستان معدل", brand_name: "Zara" });
    const sku = (await w.variants.list(A(), w.seed.storeA, p.id))[0];
    if (sku === undefined) throw new Error("no sku");
    const priceEvents = (await events("price.changed")).length;
    const next = await w.variants.update(A(), w.seed.storeA, p.id, sku.id, sku.version, { price: { amount_minor: "99900", currency: "EGP" } });
    expect(next.price.amount_minor).toBe("99900");
    expect((await events("price.changed")).length).toBe(priceEvents + 1);
    expect((await events("price.changed")).at(-1)?.payload).toMatchObject({ old_price_minor: "129900", new_price_minor: "99900" });
    expect((await w.pub.getListing(p.id)).skus[0]?.price.current_price.amount_minor).toBe("99900");
    expect((await events("listing.updated")).length).toBeGreaterThanOrEqual(before + 2);
    // unchanged price emits no price event
    await w.variants.update(A(), w.seed.storeA, p.id, sku.id, next.version, { gtin: "6221234567890" });
    expect((await events("price.changed")).length).toBe(priceEvents + 1);
  });

  it("rolls the whole change back when the outbox write fails (state and event are one transaction)", async () => {
    let failing = false;
    const w2 = await buildWorld({
      outbox: new OutboxWriter({
        insertEvent: async (tx, e) => {
          if (failing && e.type === "listing.activated") throw new Error("outbox down");
          await tx.query(
            "INSERT INTO outbox_events (id, market_id, aggregate_type, aggregate_id, event_type, visibility, payload, trace_id, occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)",
            [e.id, e.marketId, e.aggregateType, e.aggregateId, e.type, e.visibility, JSON.stringify(e.payload), null, e.occurredAt],
          );
        },
      }),
    });
    try {
      const owner = staff([w2.seed.storeA]);
      const p = await buildListing(w2, w2.seed.storeA, owner);
      failing = true;
      expect(await errorOf(w2.listings.activate(owner, w2.seed.storeA, p.id, p.version))).toMatchObject({ message: "outbox down" });
      expect((await w2.listings.get(owner, w2.seed.storeA, p.id)).status).toBe("DRAFT");
      expect((await w2.raw.query("SELECT 1 FROM catalog_public_listings")).rows).toEqual([]);
      expect((await w2.raw.query("SELECT 1 FROM outbox_events WHERE event_type = 'listing.activated'")).rows).toEqual([]);
    } finally {
      await w2.close();
    }
  });
});

describe("variants", () => {
  it("validates options against the product size run, currency, uniqueness and sku code", async () => {
    const p = await buildListing(w, w.seed.storeA, A(), { skip: ["variant"] });
    const mk = (over: Record<string, unknown>) => w.variants.create(A(), w.seed.storeA, p.id, { seller_sku: `V-${randomUUID().slice(0, 8)}`, option_values: { size: "S" }, price: { amount_minor: "5000", currency: "EGP" }, ...over });
    expect((await mk({})).size_label).toBe("S");
    expect(await errorOf(mk({ option_values: { size: "S" } }))).toMatchObject({ code: "conflict" });
    expect(await errorOf(mk({ option_values: { size: "XXL" } }))).toMatchObject({ code: "validation" });
    expect(await errorOf(mk({ price: { amount_minor: "5000", currency: "USD" } }))).toMatchObject({ code: "validation" });
    expect(await errorOf(mk({ price: { amount_minor: "0", currency: "EGP" } }))).toMatchObject({ code: "validation" });
    expect(await errorOf(mk({ price: { amount_minor: "12.5", currency: "EGP" } }))).toBeDefined();
    const dup = `DUP-${randomUUID().slice(0, 6)}`;
    await mk({ seller_sku: dup, option_values: { size: "M" } });
    expect(await errorOf(mk({ seller_sku: dup, option_values: { size: "L" } }))).toMatchObject({ code: "conflict", message: "seller_sku already used in this store" });
    expect(await errorOf(w.variants.create(A(), w.seed.storeA, randomUUID(), { seller_sku: "X", option_values: {}, price: { amount_minor: "1", currency: "EGP" } }))).toMatchObject({ code: "not_found" });
  });

  it("update is version-checked and archived sku leaves the public row", async () => {
    const p = await buildListing(w, w.seed.storeA, A());
    const live = await w.listings.activate(A(), w.seed.storeA, p.id, p.version);
    const [sku] = await w.variants.list(A(), w.seed.storeA, p.id);
    if (sku === undefined) throw new Error("no sku");
    expect(await errorOf(w.variants.update(A(), w.seed.storeA, p.id, sku.id, sku.version + 5, { status: "paused" }))).toMatchObject({ code: "conflict" });
    expect(await errorOf(w.variants.update(A(), w.seed.storeA, p.id, randomUUID(), 1, { status: "paused" }))).toMatchObject({ code: "not_found" });
    expect(await errorOf(w.variants.update(A(), w.seed.storeA, p.id, sku.id, sku.version, { option_values: { size: "XXL" } }))).toMatchObject({ code: "validation" });
    await w.variants.update(A(), w.seed.storeA, p.id, sku.id, sku.version, { status: "archived" });
    expect(await errorOf(w.pub.getListing(p.id))).toMatchObject({ code: "not_found" });
    expect(live.status).toBe("PUBLISHED");
  });
});

describe("tenant isolation on listings", () => {
  it("seller A cannot read or change seller B's listing: not_found, never forbidden, never a leak", async () => {
    const bListing = await buildListing(w, w.seed.storeB, B());
    // A reads B's id through A's own store scope: RLS hides the row
    expect(await errorOf(w.listings.get(A(), w.seed.storeA, bListing.id))).toMatchObject({ code: "not_found" });
    expect(await errorOf(w.listings.readiness(A(), w.seed.storeA, bListing.id))).toMatchObject({ code: "not_found" });
    expect(await errorOf(w.listings.updateDetails(A(), w.seed.storeA, bListing.id, bListing.version, { title_ar: "فستان", description_ar: "وصف", primary_category_id: CAT.womenDresses, attributes: WOMEN_ATTRS }))).toMatchObject({ code: "not_found" });
    expect(await errorOf(w.listings.activate(A(), w.seed.storeA, bListing.id, bListing.version))).toMatchObject({ code: "not_found" });
    expect(await errorOf(w.listings.archive(A(), w.seed.storeA, bListing.id, bListing.version))).toMatchObject({ code: "not_found" });
    expect(await errorOf(w.variants.list(A(), w.seed.storeA, bListing.id))).toMatchObject({ code: "not_found" });
    expect(await errorOf(w.variants.create(A(), w.seed.storeA, bListing.id, { seller_sku: "EVIL", option_values: { size: "M" }, price: { amount_minor: "1", currency: "EGP" } }))).toMatchObject({ code: "not_found" });
    expect(await errorOf(w.defects.putDefectCard(A(), w.seed.storeA, bListing.id, bListing.version, { affects_function: false, items: [] }))).toMatchObject({ code: "not_found" });
    // A names B's store: the policy layer answers not_found before any query
    expect(await errorOf(w.listings.get(A(), w.seed.storeB, bListing.id))).toMatchObject({ code: "not_found" });
    expect(await errorOf(w.listings.listOwn(A(), w.seed.storeB))).toMatchObject({ code: "not_found" });
    // B still has it, untouched
    expect((await w.listings.get(B(), w.seed.storeB, bListing.id)).title_ar).toBe("فستان صيفي");
  });

  it("wrong role is forbidden for writes and allowed for reads where the policy says so", async () => {
    const wh = staff([w.seed.storeA], ["warehouse"]);
    const sup = staff([w.seed.storeA], ["support"]);
    expect(await errorOf(w.listings.createDraft(wh, w.seed.storeA, { condition_grade_code: "new_with_tags", primary_category_id: CAT.womenDresses }))).toMatchObject({ code: "forbidden" });
    expect(await errorOf(w.listings.listOwn(sup, w.seed.storeA))).toMatchObject({ code: "forbidden" });
    expect((await w.listings.listOwn(wh, w.seed.storeA)).items.length).toBeGreaterThan(0);
    const shopper = { kind: "shopper" as const, userId: randomUUID(), marketId: "EG", roles: [], scopes: [] };
    expect(await errorOf(w.listings.createDraft(shopper, w.seed.storeA, { condition_grade_code: "new_with_tags", primary_category_id: CAT.womenDresses }))).toMatchObject({ code: "forbidden" });
  });

  it("the database enforces tenancy on its own: outlet_app without a store context sees no catalog rows and cannot insert", async () => {
    const seen = await withDbContext(w.app, { kind: "user", marketId: "EG" }, async (tx) => (await tx.query("SELECT id FROM products")).rows.length);
    expect(seen).toBe(0);
    const a = await withDbContext(w.app, { kind: "store", marketId: "EG", storeId: w.seed.storeA }, async (tx) => (await tx.query("SELECT id FROM products")).rows.length);
    expect(a).toBeGreaterThan(0);
    const cross = await errorOf(withDbContext(w.app, { kind: "store", marketId: "EG", storeId: w.seed.storeA }, (tx) =>
      tx.query("INSERT INTO products (id, store_id, market_id, primary_category_id, condition_grade_code) VALUES ($1,$2,'EG',$3,'new_with_tags')", [randomUUID(), w.seed.storeB, CAT.womenDresses]),
    ));
    expect(cross.message).toMatch(/row-level security/);
    const wrongMarket = await withDbContext(w.app, { kind: "store", marketId: "SA", storeId: w.seed.storeA }, async (tx) => (await tx.query("SELECT id FROM products")).rows.length);
    expect(wrongMarket).toBe(0);
  });
});

describe("defect cards and passports", () => {
  const item = (over: Record<string, unknown> = {}): never => ({ defect_type_code: "stain", location_ar: "الصدر", severity: "minor", affects_function: false, photo_media_id: randomUUID(), ...over }) as never;

  it("versions immutably, rejects critical defects, empty cards, wrong grades and missing summaries", async () => {
    const p = await buildListing(w, w.seed.storeA, A(), { grade: "new_with_imperfections", skip: ["card"] });
    expect(await errorOf(w.defects.putDefectCard(A(), w.seed.storeA, p.id, p.version, { summary_ar: "ملخص", affects_function: false, items: [] }))).toMatchObject({ details: ["DEFECT_CARD_EMPTY"] });
    expect(await errorOf(w.defects.putDefectCard(A(), w.seed.storeA, p.id, p.version, { affects_function: false, items: [item()] }))).toMatchObject({ details: ["SUMMARY_AR_REQUIRED"] });
    expect(await errorOf(w.defects.putDefectCard(A(), w.seed.storeA, p.id, p.version, { summary_ar: "ملخص", affects_function: false, items: [item({ defect_type_code: "drawstring_child" })] }))).toMatchObject({ code: "validation", details: ["drawstring_child"] });
    expect(await errorOf(w.defects.putDefectCard(A(), w.seed.storeA, p.id, p.version, { summary_ar: "ملخص", affects_function: false, items: [item({ defect_type_code: "made_up" })] }))).toMatchObject({ code: "validation", details: ["made_up"] });
    expect(await errorOf(w.defects.putDefectCard(A(), w.seed.storeA, p.id, p.version + 9, { summary_ar: "ملخص", affects_function: false, items: [item()] }))).toMatchObject({ code: "conflict" });
    const v1 = await w.defects.putDefectCard(A(), w.seed.storeA, p.id, p.version, { summary_ar: "ملخص أول", affects_function: false, items: [item(), item({ defect_type_code: "pilling", hotspot_x_bp: 100, hotspot_y_bp: 200, size_mm: 5 })] });
    expect(v1).toMatchObject({ version: 1, defect_count: 2 });
    expect(v1.items.map((i) => i.position)).toEqual([0, 1]);
    const cur = await w.listings.get(A(), w.seed.storeA, p.id);
    const v2 = await w.defects.putDefectCard(A(), w.seed.storeA, p.id, cur.version, { summary_ar: "ملخص ثان", affects_function: true, items: [item()] });
    expect(v2).toMatchObject({ version: 2, defect_count: 1, affects_function: true });
    expect((await w.listings.get(A(), w.seed.storeA, p.id)).defect_card?.id).toBe(v2.id);
    // old versions stay in the database, unchanged
    const rows = await w.raw.query<{ version: number; summary_ar: string }>("SELECT version, summary_ar FROM defect_cards WHERE product_id = $1 ORDER BY version", [p.id]);
    expect(rows.rows.map((r) => r.summary_ar)).toEqual(["ملخص أول", "ملخص ثان"]);
    // immutability is enforced by the database even for the owner role
    expect((await errorOf(w.raw.query("UPDATE defect_cards SET summary_ar = 'x' WHERE id = $1", [v1.id]))).message).toContain("immutable");
    expect((await errorOf(w.raw.query("DELETE FROM defect_items WHERE defect_card_id = $1", [v1.id]))).message).toContain("immutable");
    expect((await errorOf(w.raw.query("INSERT INTO defect_items (id, defect_card_id, store_id, defect_type_code, location_ar, severity, affects_function, photo_media_id, position) SELECT gen_random_uuid(), $1, $2, 'loose_small_part', 'x', 'major', true, gen_random_uuid(), 9", [v2.id, w.seed.storeA]))).message).toContain("critical");
    // a grade that takes no card
    const plain = await buildListing(w, w.seed.storeA, A());
    expect(await errorOf(w.defects.putDefectCard(A(), w.seed.storeA, plain.id, plain.version, { summary_ar: "ملخص", affects_function: false, items: [item()] }))).toMatchObject({ code: "validation" });
    expect(await errorOf(w.defects.putDefectCard(A(), w.seed.storeA, p.id, cur.version, { summary_ar: "ملخص", affects_function: false, items: [item()] }))).toMatchObject({ code: "conflict" });
  });

  it("a card written on a live listing is published at once and refreshes the public page", async () => {
    const p = await buildListing(w, w.seed.storeA, A(), { grade: "new_with_imperfections" });
    const live = await w.listings.activate(A(), w.seed.storeA, p.id, p.version);
    const v2 = await w.defects.putDefectCard(A(), w.seed.storeA, p.id, live.version, { summary_ar: "ملخص محدث", affects_function: false, items: [item(), item({ defect_type_code: "open_seam" })] });
    expect(v2.published_at).not.toBeNull();
    const pub = await w.pub.getListing(p.id);
    expect(pub.defect_card?.defect_count).toBe(2);
    expect((await w.pub.listStoreListings(w.seed.storeA, { limit: 50 })).items.find((c) => c.product_id === p.id)?.defect_count).toBe(2);
  });

  it("issues a passport: token shown once, only its hash stored, public lookup has no personal data", async () => {
    const p = await buildListing(w, w.seed.storeA, A(), { grade: "new_with_imperfections" });
    const live = await w.listings.activate(A(), w.seed.storeA, p.id, p.version);
    const skuId = live.skus[0]?.id ?? "";
    const issued = await w.defects.issuePassport(A(), w.seed.storeA, { productId: p.id, skuId });
    expect(issued.passportCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(issued.contentHash).toMatch(/^[0-9a-f]{64}$/);

    const stored = await w.raw.query<{ passport_token_hash: Uint8Array; content_hash: Uint8Array }>("SELECT passport_token_hash, content_hash FROM item_units WHERE id = $1", [issued.unitId]);
    expect(Buffer.from(stored.rows[0]?.passport_token_hash ?? []).toString("utf8")).not.toContain(issued.passportCode);
    expect(Buffer.from(stored.rows[0]?.content_hash ?? []).toString("hex")).toBe(issued.contentHash);
    const dump = JSON.stringify((await w.raw.query("SELECT * FROM item_units")).rows) + JSON.stringify((await w.raw.query("SELECT * FROM catalog_public_passports")).rows);
    expect(dump).not.toContain(issued.passportCode);

    const looked = DefectPassport.parse(await w.defects.lookupPassport(`${issued.passportCode.slice(0, 8).toLowerCase()}-${issued.passportCode.slice(8).toLowerCase()}`));
    expect(looked).toMatchObject({ passport_code: issued.passportCode, unit_status: "IN_STOCK", product_id: p.id, store_slug: "store-a", content_hash: issued.contentHash });
    expect(looked.store_display_name_ar.length).toBeGreaterThan(0);
    expect(looked.inspection_history).toHaveLength(1);
    expect(looked.defect_card.items[0]?.photo.url).toMatch(/^\/media\//);

    const keys = new Set<string>();
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (typeof v === "object" && v !== null) for (const [k, x] of Object.entries(v)) { keys.add(k); walk(x); }
    };
    walk(looked);
    for (const forbidden of ["store_id", "seller_id", "user_id", "buyer", "phone", "email", "address", "national_id", "order_id", "unit_id", "sku_id", "passport_token_hash"]) expect(keys).not.toContain(forbidden);

    // editing the card afterwards creates v2; the already issued passport still shows the version it was graded with
    const cur = await w.listings.get(A(), w.seed.storeA, p.id);
    await w.defects.putDefectCard(A(), w.seed.storeA, p.id, cur.version, { summary_ar: "نسخة جديدة", affects_function: false, items: [item()] });
    const again = await w.defects.lookupPassport(issued.passportCode);
    expect(again.defect_card.version).toBe(1);
    expect(again.content_hash).toBe(issued.contentHash);
    const second = await w.defects.issuePassport(A(), w.seed.storeA, { productId: p.id, skuId });
    expect(second.passportCode).not.toBe(issued.passportCode);
    expect((await w.defects.lookupPassport(second.passportCode)).inspection_history.map((h) => h.version)).toEqual([1, 2]);
  });

  it("passport errors: unknown or malformed token, no card, foreign sku or listing, and wrong role", async () => {
    expect(await errorOf(w.defects.lookupPassport("nonsense"))).toMatchObject({ code: "not_found" });
    expect(await errorOf(w.defects.lookupPassport("0".repeat(26)))).toMatchObject({ code: "not_found" });
    const plain = await buildListing(w, w.seed.storeA, A());
    const skuId = plain.skus[0]?.id ?? "";
    expect(await errorOf(w.defects.issuePassport(A(), w.seed.storeA, { productId: plain.id, skuId }))).toMatchObject({ code: "validation" });
    const graded = await buildListing(w, w.seed.storeA, A(), { grade: "new_with_imperfections" });
    expect(await errorOf(w.defects.issuePassport(A(), w.seed.storeA, { productId: graded.id, skuId }))).toMatchObject({ code: "not_found" });
    expect(await errorOf(w.defects.issuePassport(B(), w.seed.storeB, { productId: graded.id, skuId: graded.skus[0]?.id ?? "" }))).toMatchObject({ code: "not_found" });
    expect(await errorOf(w.defects.issuePassport(staff([w.seed.storeA], ["support"]), w.seed.storeA, { productId: graded.id, skuId: graded.skus[0]?.id ?? "" }))).toMatchObject({ code: "forbidden" });
    expect(new DefectService(w.deps)).toBeInstanceOf(DefectService);
  });
});

describe("keyset pagination and query counts", () => {
  let storePublished: string[] = [];
  beforeAll(async () => {
    const owner = A();
    for (let i = 0; i < 7; i += 1) {
      const p = await buildListing(w, w.seed.storeA, owner, { price: String(10000 + i * 100) });
      await w.listings.activate(owner, w.seed.storeA, p.id, p.version);
      storePublished.push(p.id);
    }
    storePublished = (await w.pub.listStoreListings(w.seed.storeA, { limit: 50 })).items.map((c) => c.product_id);
  });

  it("walks every page exactly once, newest first, stable while new rows arrive between requests", async () => {
    const seen: string[] = [];
    const firstWave = new Set(storePublished);
    let cursor: string | undefined;
    let inserted = 0;
    for (let guard = 0; guard < 50; guard += 1) {
      const page = await w.pub.listStoreListings(w.seed.storeA, { limit: 3, ...(cursor === undefined ? {} : { cursor }) });
      ProductCardPage.parse(page);
      seen.push(...page.items.map((c) => c.product_id));
      if (inserted < 2) {
        const p = await buildListing(w, w.seed.storeA, A());
        await w.listings.activate(A(), w.seed.storeA, p.id, p.version);
        inserted += 1;
      }
      if (page.next_cursor === null) break;
      cursor = page.next_cursor;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.filter((id) => firstWave.has(id))).toEqual(storePublished);
  });

  it("seller list pages by updated_at desc with a status filter and a clamped limit", async () => {
    const owner = A();
    const all: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 100; i += 1) {
      const page = await w.listings.listOwn(owner, w.seed.storeA, { limit: 4, ...(cursor === undefined ? {} : { cursor }) });
      all.push(...page.items.map((x) => x.id));
      if (page.next_cursor === null) break;
      cursor = page.next_cursor;
    }
    expect(new Set(all).size).toBe(all.length);
    const total = (await w.raw.query<{ n: number }>("SELECT count(*)::int AS n FROM products WHERE store_id = $1", [w.seed.storeA])).rows[0]?.n;
    expect(all).toHaveLength(total ?? -1);
    const drafts = await w.listings.listOwn(owner, w.seed.storeA, { status: "DRAFT", limit: 50 });
    expect(drafts.items.every((x) => x.status === "DRAFT")).toBe(true);
    const sorted = [...drafts.items].map((x) => x.updated_at);
    expect(sorted).toEqual([...sorted].sort().reverse());
    expect(await errorOf(w.listings.listOwn(owner, w.seed.storeA, { limit: 51 }))).toMatchObject({ code: "validation" });
    const more = await w.listings.listOwn(owner, w.seed.storeA, { status: "PUBLISHED", limit: 2 });
    expect(more.next_cursor).not.toBeNull();
    const rest = await w.listings.listOwn(owner, w.seed.storeA, { status: "PUBLISHED", limit: 50, ...(more.next_cursor === null ? {} : { cursor: more.next_cursor }) });
    expect(rest.items.some((x) => more.items.some((m) => m.id === x.id))).toBe(false);
  });

  it("category listing pages the same way", async () => {
    const page = await w.pub.listCategoryListings(CAT.womenDresses, { limit: 2 });
    expect(page.items).toHaveLength(2);
    const next = await w.pub.listCategoryListings(CAT.womenDresses, { limit: 50, ...(page.next_cursor === null ? {} : { cursor: page.next_cursor }) });
    expect(next.items.some((c) => page.items.some((x) => x.product_id === c.product_id))).toBe(false);
    expect((await w.pub.listCategoryListings(CAT.kidsGirls)).items.every((c) => c.condition_grade_code.length > 0)).toBe(true);
  });

  it("store page = 2 statements, product page = 1, a 20-card page = 1, regardless of row count", async () => {
    const page = await expectQueryCount(w.app, 2, (c) => new (w.pub.constructor as typeof import("../src/index.js").PublicCatalogService)({ ...w.deps, client: c }).getStorePage("store-a", { limit: 20 }));
    expect(page.store.slug).toBe("store-a");
    expect(page.listings.items.length).toBeGreaterThan(5);
    const pubWith = (c: typeof w.app) => new (w.pub.constructor as typeof import("../src/index.js").PublicCatalogService)({ ...w.deps, client: c });
    const first = storePublished[0] ?? "";
    await expectQueryCount(w.app, 1, (c) => pubWith(c).getListing(first));
    const small = await countQueries(w.app, (c) => pubWith(c).listStoreListings(w.seed.storeA, { limit: 2 }));
    const big = await countQueries(w.app, (c) => pubWith(c).listStoreListings(w.seed.storeA, { limit: 50 }));
    expect(small.count).toBe(1);
    expect(big.count).toBe(1);
    expect(big.result.items.length).toBeGreaterThan(small.result.items.length);
    const seller = await countQueries(w.app, (c) => new ListingService({ ...w.deps, client: c }).listOwn(A(), w.seed.storeA, { limit: 50 }));
    expect(seller.count).toBe(1);
    expect(seller.statements[0]).not.toMatch(/SELECT \*/);
    const cat = await countQueries(w.app, (c) => pubWith(c).listCategoryListings(CAT.womenDresses, { limit: 50 }));
    expect(cat.count).toBe(1);
    expect((await errorOf(expectQueryCount(w.app, 5, (c) => pubWith(c).getListing(first)))).message).toContain("expected exactly 5 statements, got 1");
  });

  it("public cards and details select named columns only (no SELECT *)", async () => {
    const r = await countQueries(w.app, async (c) => {
      const pub = new (w.pub.constructor as typeof import("../src/index.js").PublicCatalogService)({ ...w.deps, client: c });
      await pub.getStorePage("store-a");
      await pub.getListing(storePublished[0] ?? "");
    });
    for (const s of r.statements) expect(s).not.toMatch(/SELECT\s+\*|\.\*/);
    expect(SellerProduct).toBeDefined();
    expect(SIZE_RUN).toHaveLength(3);
  });
});

describe("shapes against the OpenAPI schemas", () => {
  it("every public output parses with the strict Zod schemas", async () => {
    const page = await w.pub.getStorePage("store-a");
    StoreDetail.parse(page.store);
    ProductCardPage.parse(page.listings);
    expect(page.listings.items.every((c) => c.price.claim_type === "plain" && c.price.reference_price === undefined)).toBe(true);
    expect(CatalogError).toBeDefined();
  });
});
