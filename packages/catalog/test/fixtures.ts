import { randomUUID } from "node:crypto";
import type { RoleSqlClient, SqlClient } from "@outlet/db";
import { createTestClient, roleClient } from "@outlet/db/testing";
import type { Principal } from "@outlet/policy";
import { BrandService, CategoryService, DefectService, ListingService, PublicCatalogService, StoreService, VariantService } from "../src/index.js";
import type { CatalogDeps, SellerProduct } from "../src/index.js";

export const CAT = {
  womenDresses: "00000000-0000-4000-8000-0000000c0011",
  modestAbayas: "00000000-0000-4000-8000-0000000c0021",
  kidsGirls: "00000000-0000-4000-8000-0000000c0031",
  women: "00000000-0000-4000-8000-0000000c0010",
  fashion: "00000000-0000-4000-8000-0000000c0001",
} as const;

export const SIZE_RUN = [
  { label: "S", cm: 88 },
  { label: "M", cm: 94 },
  { label: "L", cm: 100 },
];

export const WOMEN_ATTRS = { colour: "black", material: "cotton", size_run: SIZE_RUN };

export interface Seed {
  readonly sellerA: string;
  readonly sellerB: string;
  readonly sellerDraft: string;
  readonly storeA: string;
  readonly storeB: string;
  /** Store whose seller has no legal identity (draft seller). */
  readonly storeDraft: string;
}

export const staff = (storeIds: readonly string[], roles: readonly string[] = ["owner"], marketId = "EG"): Principal => ({
  kind: "seller_staff",
  userId: randomUUID(),
  marketId,
  storeIds: [...storeIds],
  roles: [...roles],
  scopes: [],
});

export const anonymous = (): Principal => ({ kind: "anonymous", marketId: "EG", roles: [], scopes: [] });

export interface World {
  readonly raw: SqlClient;
  readonly app: RoleSqlClient<"outlet_app">;
  readonly deps: CatalogDeps;
  readonly seed: Seed;
  readonly categories: CategoryService;
  readonly brands: BrandService;
  readonly stores: StoreService;
  readonly listings: ListingService;
  readonly variants: VariantService;
  readonly defects: DefectService;
  readonly pub: PublicCatalogService;
  readonly close: () => Promise<void>;
}

const seller = (raw: SqlClient, id: string, status: "active" | "draft", n: string): Promise<unknown> =>
  raw.query(
    `INSERT INTO sellers (id, home_market_id, market_id, legal_type, legal_name_ar, legal_name_en, commercial_register_no, tax_card_no, governorate_code, governorate_name_ar, status)
     VALUES ($1,'EG','EG','company',$2,$3,$4,$5,$6,$7,$8)`,
    status === "active"
      ? [id, `شركة ${n}`, `Company ${n}`, `CR-${n}`, `TX-${n}`, "CAI", "القاهرة", status]
      : [id, null, null, null, null, null, null, status],
  );

const store = (raw: SqlClient, id: string, sellerId: string, slug: string, status = "ACTIVE"): Promise<unknown> =>
  raw.query(
    `INSERT INTO stores (id, seller_id, market_id, slug, display_name_ar, display_name_en, kind, ships_from_country, status)
     VALUES ($1,$2,'EG',$3,$4,$5,'local','EG',$6)`,
    [id, sellerId, slug, `متجر ${slug}`, `Store ${slug}`, status],
  );

export const buildWorld = async (overrides: Partial<CatalogDeps> = {}): Promise<World> => {
  const { client: raw, close } = await createTestClient();
  const app = roleClient(raw, "outlet_app");
  const seed: Seed = { sellerA: randomUUID(), sellerB: randomUUID(), sellerDraft: randomUUID(), storeA: randomUUID(), storeB: randomUUID(), storeDraft: randomUUID() };
  await seller(raw, seed.sellerA, "active", "A");
  await seller(raw, seed.sellerB, "active", "B");
  await seller(raw, seed.sellerDraft, "draft", "D");
  await store(raw, seed.storeA, seed.sellerA, "store-a");
  await store(raw, seed.storeB, seed.sellerB, "store-b");
  await store(raw, seed.storeDraft, seed.sellerDraft, "store-d");
  let tick = Date.parse("2030-01-01T00:00:00.000Z");
  const deps: CatalogDeps = {
    client: app,
    marketId: "EG",
    // Strictly increasing clock: keyset ordering by updated_at/published_at is deterministic in tests.
    now: () => new Date((tick += 1000)),
    ...overrides,
  };
  return {
    raw, app, deps, seed, close,
    categories: new CategoryService(deps),
    brands: new BrandService(deps),
    stores: new StoreService(deps),
    listings: new ListingService(deps),
    variants: new VariantService(deps),
    defects: new DefectService(deps),
    pub: new PublicCatalogService(deps),
  };
};

/** Makes a store's projection visible: stores seeded through SQL need one patch (or create) to be projected; this calls update with a no-op change. */
export const projectStoreViaPatch = async (w: World, storeId: string): Promise<void> => {
  const p = staff([storeId]);
  const s = await w.stores.getOwn(p, storeId);
  await w.stores.update(p, storeId, s.version, { tagline_ar: s.tagline_ar ?? "أفضل العروض" });
};

export interface ListingOpts {
  readonly categoryId?: string;
  readonly grade?: string;
  readonly titleAr?: string;
  readonly attrs?: Record<string, unknown>;
  readonly skip?: readonly ("details" | "media" | "variant" | "card" | "conditionPhoto")[];
  readonly price?: string;
}

const DEFECT_ITEM = { defect_type_code: "stain", location_ar: "الكم الأيسر", severity: "minor", affects_function: false, photo_media_id: "", size_mm: 12 } as const;

/** Drives the real services to build a complete listing (not published). Returns the fresh seller view. */
export const buildListing = async (w: World, storeId: string, actor: Principal, o: ListingOpts = {}): Promise<SellerProduct> => {
  const skip = new Set(o.skip ?? []);
  const grade = o.grade ?? "new_with_tags";
  let p = await w.listings.createDraft(actor, storeId, { condition_grade_code: grade, primary_category_id: o.categoryId ?? CAT.womenDresses });
  if (!skip.has("details")) {
    p = await w.listings.updateDetails(actor, storeId, p.id, p.version, {
      title_ar: o.titleAr ?? "فستان صيفي",
      title_en: "Summer dress",
      description_ar: "فستان قطن مريح",
      primary_category_id: o.categoryId ?? CAT.womenDresses,
      attributes: o.attrs ?? WOMEN_ATTRS,
    });
  }
  if (!skip.has("media")) {
    const media: { media_id: string; role: "main" | "condition"; position: number }[] = [{ media_id: randomUUID(), role: "main", position: 0 }];
    if (!skip.has("conditionPhoto")) media.push({ media_id: randomUUID(), role: "condition", position: 1 });
    p = await w.listings.setConditionAndMedia(actor, storeId, p.id, p.version, { media, condition_grade_code: grade });
  }
  if (grade === "new_with_imperfections" && !skip.has("card")) {
    await w.defects.putDefectCard(actor, storeId, p.id, p.version, {
      summary_ar: "بقعة صغيرة على الكم",
      affects_function: false,
      items: [{ ...DEFECT_ITEM, photo_media_id: randomUUID() }],
    });
  }
  if (!skip.has("variant")) {
    await w.variants.create(actor, storeId, p.id, { seller_sku: `SKU-${p.id.slice(-8)}`, option_values: { size: "M", colour: "black" }, price: { amount_minor: o.price ?? "129900", currency: "EGP" } });
  }
  return w.listings.get(actor, storeId, p.id);
};

export const errorOf = async (p: Promise<unknown>): Promise<{ code?: string; message: string; details?: readonly string[] }> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof Error) {
      const code = "code" in e && typeof e.code === "string" ? e.code : undefined;
      const details = "details" in e && Array.isArray(e.details) ? (e.details as string[]) : undefined;
      return { ...(code === undefined ? {} : { code }), message: e.message, ...(details === undefined ? {} : { details }) };
    }
    throw e;
  }
  return { message: "NO_ERROR" };
};
