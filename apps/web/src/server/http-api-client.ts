import { z } from "zod";
import type { ApiClient, CategoryNode, DealBandCode, PriceView, ProductDetail, ProductImage, ProductSummary, ProductsPage, StoreDirectory, StoreProfile, StoreQuery } from "./api-client";
import { tags } from "./cache-tags";

export class ApiError extends Error {
  constructor(readonly status: number, path: string) {
    super(`API ${String(status)} for ${path}`);
    this.name = "ApiError";
  }
}

const nullableString = z.string().nullable().optional().transform((v) => v ?? null);
const wireMoney = z.object({ amount_minor: z.string().regex(/^-?\d+$/), currency: z.string().min(3).max(3) });

const storeSchema = z.object({
  id: z.string(),
  slug: z.string(),
  display_name_ar: z.string().min(1),
  display_name_en: nullableString,
  tagline_ar: nullableString,
  tagline_en: nullableString,
  kind: z.enum(["local", "global"]),
  status: z.enum(["ACTIVE", "VACATION"]),
  verified_badge: z.boolean(),
  followers_count: z.number().int(),
  discount_display_mode: z.enum(["public", "member_only", "hidden"]),
  canonical_path: z.string(),
});

const mediaSchema = z.object({
  media_id: z.string(),
  url: z.string(),
  width: z.number().int().nullable().optional(),
  height: z.number().int().nullable().optional(),
  blurhash: z.string().nullable().optional(),
  alt_ar: nullableString,
  alt_en: nullableString,
});
const priceSchema = z.object({
  current_price: wireMoney,
  claim_type: z.enum(["verified_discount", "lowest_30d", "launch_price", "plain"]),
  reference_price: wireMoney.optional(),
  display_discount_bp: z.number().int().optional(),
  member_discount_bp: z.number().int().optional(),
  evidence_checked_at: z.string().optional(),
  price_proof_path: z.string(),
});
const availabilitySchema = z.enum(["in_stock", "low_stock", "out_of_stock"]);

const storeCardSchema = z.object({
  id: z.string(),
  slug: z.string(),
  display_name_ar: z.string().min(1),
  display_name_en: nullableString,
  tagline_ar: nullableString,
  tagline_en: nullableString,
  kind: z.enum(["local", "global"]),
  verified_badge: z.boolean(),
  storefront: z.object({ template_code: z.string(), palette: z.record(z.string(), z.unknown()), published_version: z.number().int() }),
  live_drop: z.boolean(),
  followers_count: z.number().int(),
  discount_display_mode: z.enum(["public", "member_only", "hidden"]),
  art: mediaSchema.nullable(),
  canonical_path: z.string(),
});
const storeCardPageSchema = z.object({ items: z.array(storeCardSchema), next_cursor: z.string().nullable() });

const categorySchema = z.object({
  id: z.string(),
  parent_id: z.string().nullable(),
  code: z.string(),
  path: z.string(),
  depth: z.number().int().min(0),
  vertical: z.string(),
  name: z.string(),
  slug: z.string(),
  name_ar: z.string(),
  name_en: z.string().nullable(),
});
const categoryPageSchema = z.object({ items: z.array(categorySchema), next_cursor: z.string().nullable() });

const defectItemSchema = z.object({
  id: z.string(),
  defect_type_code: z.string(),
  label_ar: z.string(),
  label_en: nullableString,
  location_ar: z.string(),
  location_en: nullableString,
  size_mm: z.number().int().nullable().optional(),
  severity: z.enum(["minor", "major"]),
  affects_function: z.boolean(),
  photo: mediaSchema,
  position: z.number().int(),
});
const defectCardSchema = z.object({
  id: z.string(),
  version: z.number().int(),
  grade_code: z.string(),
  stock_reason: nullableString,
  summary_ar: nullableString,
  summary_en: nullableString,
  affects_function: z.boolean(),
  defect_count: z.number().int(),
  inspected_by: z.enum(["seller", "hub"]),
  items: z.array(defectItemSchema),
});
const storeDetailSchema = storeSchema.extend({
  legal_identity: z.object({
    legal_name_ar: z.string().min(1),
    legal_name_en: nullableString,
    commercial_register_no: z.string().min(1),
    tax_card_no: z.string().min(1),
    governorate_name_ar: z.string().min(1),
  }),
});
const productDetailSchema = z.object({
  id: z.string(),
  store: storeDetailSchema,
  brand_name: nullableString,
  status: z.enum(["PUBLISHED", "SOLD_OUT", "PAUSED"]),
  title_ar: z.string().min(1),
  title_en: nullableString,
  description_ar: z.string().min(1),
  description_en: nullableString,
  condition_grade: z.object({ code: z.string(), label_ar: z.string().min(1), label_en: nullableString, schema_org_condition: z.string() }),
  defect_card: defectCardSchema.nullable().optional(),
  skus: z.array(z.object({ sku_id: z.string(), size_label: nullableString, price: priceSchema, availability: availabilitySchema.optional(), low_stock_qty: z.number().int().optional() })),
  canonical_path: z.string(),
});

const productSchema = z.object({
  product_id: z.string(),
  store_slug: z.string(),
  title_ar: z.string().min(1),
  title_en: nullableString,
  sku_id: z.string().optional(),
  store_id: z.string().optional(),
  image: mediaSchema.nullable(),
  condition_grade_code: z.string(),
  defect_count: z.number().int(),
  price: priceSchema,
  availability: availabilitySchema.default("in_stock"),
  canonical_path: z.string(),
  condition_label_ar: nullableString,
  condition_label_en: nullableString,
  colour_code: nullableString,
});
const productsSchema = z.object({ items: z.array(productSchema), next_cursor: z.string().nullable() });

export type Fetcher = (url: string, init: RequestInit & { next?: { tags?: string[]; revalidate?: number } }) => Promise<Response>;

/** Server-side client for apps/api. Catalogue descriptors are tagged; price/stock reads are `no-store`. */
export class HttpApiClient implements ApiClient {
  constructor(private readonly baseUrl: string, private readonly fetcher: Fetcher = (url, init) => fetch(url, init)) {}

  private async get(path: string, init: RequestInit & { next?: { tags?: string[]; revalidate?: number } }): Promise<unknown> {
    const res = await this.fetcher(`${this.baseUrl.replace(/\/+$/, "")}${path}`, { ...init, headers: { accept: "application/json" } });
    if (res.status === 404) return null;
    if (!res.ok) throw new ApiError(res.status, path);
    return (await res.json()) as unknown;
  }

  async listStores(marketId: string, opts: StoreQuery = {}): Promise<StoreDirectory> {
    const q = new URLSearchParams();
    if (opts.world !== undefined) q.set("world", opts.world);
    if (opts.categoryId !== undefined) q.set("category_id", opts.categoryId);
    if (opts.cursor !== undefined) q.set("cursor", opts.cursor);
    if (opts.limit !== undefined) q.set("limit", String(opts.limit));
    const qs = q.size > 0 ? `?${q.toString()}` : "";
    const body = await this.get(`/v1/${encodeURIComponent(marketId)}/stores${qs}`, { next: { tags: [tags.market(marketId)], revalidate: 60 } });
    if (body === null) return { stores: [], nextCursor: null, reason: "NO_ROUTE" };
    const page = storeCardPageSchema.parse(body);
    return {
      reason: "OK",
      nextCursor: page.next_cursor,
      stores: page.items.map((s) => ({
        id: s.id, slug: s.slug, nameAr: s.display_name_ar, nameEn: s.display_name_en, kind: s.kind,
        ...(s.art ? { art: { src: s.art.url, ...(s.art.width != null ? { width: s.art.width } : {}), ...(s.art.height != null ? { height: s.art.height } : {}) } } : {}),
      })),
    };
  }

  /** The full tree in path order, following the keyset cursor (bounded) so roots are never cut off by the page size. */
  async listCategories(marketId: string): Promise<readonly CategoryNode[]> {
    const out: CategoryNode[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_CATEGORY_PAGES; page += 1) {
      const qs: string = cursor === null ? "?limit=50" : `?limit=50&cursor=${encodeURIComponent(cursor)}`;
      const body = await this.get(`/v1/${encodeURIComponent(marketId)}/categories${qs}`, { next: { tags: [tags.market(marketId)], revalidate: 60 } });
      if (body === null) break;
      const parsed = categoryPageSchema.parse(body);
      for (const c of parsed.items) out.push({ id: c.id, parentId: c.parent_id, depth: c.depth, nameAr: c.name_ar, nameEn: c.name_en, slug: c.slug });
      cursor = parsed.next_cursor;
      if (cursor === null) break;
    }
    return out;
  }

  async getStore(marketId: string, slug: string): Promise<StoreProfile | null> {
    const body = await this.get(`/v1/${encodeURIComponent(marketId)}/stores/${encodeURIComponent(slug)}`, { next: { tags: [tags.store(slug), tags.market(marketId)], revalidate: 60 } });
    if (body === null) return null;
    const s = storeSchema.parse(body);
    return {
      id: s.id, slug: s.slug, nameAr: s.display_name_ar, nameEn: s.display_name_en, taglineAr: s.tagline_ar, taglineEn: s.tagline_en,
      kind: s.kind, status: s.status, verifiedBadge: s.verified_badge, followersCount: s.followers_count,
      discountDisplayMode: s.discount_display_mode, canonicalPath: s.canonical_path,
    };
  }

  async listStoreProducts(marketId: string, slug: string, opts: { readonly cursor?: string; readonly limit?: number } = {}): Promise<ProductsPage> {
    const q = new URLSearchParams();
    if (opts.cursor !== undefined) q.set("cursor", opts.cursor);
    if (opts.limit !== undefined) q.set("limit", String(opts.limit));
    const qs = q.size > 0 ? `?${q.toString()}` : "";
    // Items carry price and stock: never cached. The tag is kept so descriptive revalidation stays addressable.
    const body = await this.get(`/v1/${encodeURIComponent(marketId)}/stores/${encodeURIComponent(slug)}/products${qs}`, { cache: "no-store", next: { tags: [tags.store(slug)] } });
    if (body === null) return { items: [], nextCursor: null };
    const page = productsSchema.parse(body);
    return { nextCursor: page.next_cursor, items: page.items.map(toSummary) };
  }

  async getProduct(marketId: string, id: string): Promise<ProductDetail | null> {
    // Price and stock: never cached.
    const body = await this.get(`/v1/${encodeURIComponent(marketId)}/products/${encodeURIComponent(id)}`, { cache: "no-store", next: { tags: [tags.product(id)] } });
    if (body === null) return null;
    const p = productDetailSchema.parse(body);
    const st = p.store;
    const dc = p.defect_card ?? null;
    return {
      id: p.id, titleAr: p.title_ar, titleEn: p.title_en, descriptionAr: p.description_ar, descriptionEn: p.description_en, brandName: p.brand_name,
      conditionCode: p.condition_grade.code, conditionLabelAr: p.condition_grade.label_ar, conditionLabelEn: p.condition_grade.label_en, schemaOrgCondition: p.condition_grade.schema_org_condition,
      defectCard: dc === null ? null : {
        gradeCode: dc.grade_code, summaryAr: dc.summary_ar, summaryEn: dc.summary_en, affectsFunction: dc.affects_function, defectCount: dc.defect_count,
        items: dc.items.map((i) => ({ labelAr: i.label_ar, labelEn: i.label_en, locationAr: i.location_ar, locationEn: i.location_en, affectsFunction: i.affects_function, photo: toImage(i.photo) })),
      },
      skus: p.skus.map((k) => ({ id: k.sku_id, sizeLabel: k.size_label, price: toPrice(k.price), availability: k.availability ?? "in_stock" })),
      store: {
        id: st.id, slug: st.slug, nameAr: st.display_name_ar, nameEn: st.display_name_en, taglineAr: st.tagline_ar, taglineEn: st.tagline_en, kind: st.kind, status: st.status,
        verifiedBadge: st.verified_badge, followersCount: st.followers_count, discountDisplayMode: st.discount_display_mode, canonicalPath: st.canonical_path,
      },
      legal: {
        legalNameAr: st.legal_identity.legal_name_ar, legalNameEn: st.legal_identity.legal_name_en, commercialRegisterNo: st.legal_identity.commercial_register_no,
        taxCardNo: st.legal_identity.tax_card_no, governorateNameAr: st.legal_identity.governorate_name_ar,
      },
      canonicalPath: p.canonical_path,
    };
  }

  async listDeals(marketId: string, band: DealBandCode): Promise<readonly ProductSummary[]> {
    const body = await this.get(`/v1/${encodeURIComponent(marketId)}/deals?band=${band}`, { cache: "no-store" });
    if (body === null) return [];
    return productsSchema.parse(body).items.map(toSummary);
  }
}

const MAX_CATEGORY_PAGES = 4;
type WirePrice = z.infer<typeof priceSchema>;
type WireMedia = z.infer<typeof mediaSchema>;

function toImage(m: WireMedia): ProductImage {
  return { url: m.url, width: m.width ?? null, height: m.height ?? null, altAr: m.alt_ar, altEn: m.alt_en };
}
function toPrice(p: WirePrice): PriceView {
  return {
    amountMinor: BigInt(p.current_price.amount_minor),
    currency: p.current_price.currency,
    claimType: p.claim_type,
    ...(p.reference_price ? { referenceAmountMinor: BigInt(p.reference_price.amount_minor), referenceCurrency: p.reference_price.currency } : {}),
    priceProofPath: p.price_proof_path,
  };
}
function toSummary(p: z.infer<typeof productSchema>): ProductSummary {
  return {
    id: p.product_id, storeSlug: p.store_slug, titleAr: p.title_ar, titleEn: p.title_en, image: p.image ? toImage(p.image) : null,
    conditionGradeCode: p.condition_grade_code, defectCount: p.defect_count, price: toPrice(p.price), availability: p.availability, canonicalPath: p.canonical_path,
    conditionLabelAr: p.condition_label_ar, conditionLabelEn: p.condition_label_en, colourCode: p.colour_code,
  };
}
