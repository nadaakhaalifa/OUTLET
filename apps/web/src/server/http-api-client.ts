import { z } from "zod";
import type { ApiClient, DealBand, ProductDetail, ProductsPage, StoreDirectory, StoreProfile } from "./api-client";
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

const productSchema = z.object({
  product_id: z.string(),
  store_slug: z.string(),
  title_ar: z.string().min(1),
  title_en: nullableString,
  image: z
    .object({ media_id: z.string(), url: z.string(), width: z.number().int().nullable().optional(), height: z.number().int().nullable().optional(), alt_ar: nullableString, alt_en: nullableString })
    .nullable(),
  condition_grade_code: z.string(),
  defect_count: z.number().int(),
  price: z.object({
    current_price: wireMoney,
    claim_type: z.enum(["verified_discount", "lowest_30d", "launch_price", "plain"]),
    reference_price: wireMoney.optional(),
    price_proof_path: z.string(),
  }),
  availability: z.enum(["in_stock", "low_stock", "out_of_stock"]).default("in_stock"),
  canonical_path: z.string(),
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

  /** There is no stores-directory route in apps/api yet: honest empty result with reason NO_ROUTE. */
  listStores(): Promise<StoreDirectory> {
    return Promise.resolve({ stores: [], reason: "NO_ROUTE" });
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
    return {
      nextCursor: page.next_cursor,
      items: page.items.map((p) => ({
        id: p.product_id,
        storeSlug: p.store_slug,
        titleAr: p.title_ar,
        titleEn: p.title_en,
        image: p.image ? { url: p.image.url, width: p.image.width ?? null, height: p.image.height ?? null, altAr: p.image.alt_ar, altEn: p.image.alt_en } : null,
        conditionGradeCode: p.condition_grade_code,
        defectCount: p.defect_count,
        price: {
          amountMinor: BigInt(p.price.current_price.amount_minor),
          currency: p.price.current_price.currency,
          claimType: p.price.claim_type,
          ...(p.price.reference_price ? { referenceAmountMinor: BigInt(p.price.reference_price.amount_minor), referenceCurrency: p.price.reference_price.currency } : {}),
          priceProofPath: p.price.price_proof_path,
        },
        availability: p.availability,
        canonicalPath: p.canonical_path,
      })),
    };
  }

  /** No product-detail route yet; the quick view resolves the product from the store's product list. */
  getProduct(): Promise<ProductDetail | null> {
    return Promise.resolve(null);
  }

  /** No deals-by-band route yet. */
  listDealBands(): Promise<readonly DealBand[]> {
    return Promise.resolve([]);
  }
}
