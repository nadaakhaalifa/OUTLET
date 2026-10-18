import { Controller, Get, Inject, Query, Req, Res } from "@nestjs/common";
import { z } from "zod";
import { Public, RateLimit } from "../../../platform/decorators";
import type { ApiRequest, ApiResponse } from "../../../platform/http-types";
import { Problems, ProblemError } from "../../../platform/problem";
import {
  assertGuestBrowsingEnabled,
  assertPublicReadEnabled,
  PUBLIC_CACHE,
  respondPublic,
  type PublicReadGate,
} from "../../../platform/public-read";
import { GUEST_BROWSING_GATE, PUBLIC_READ_GATE } from "../../../platform/tokens";
import { ZodPipe } from "../../../platform/zod.pipe";
import {
  CatalogUnavailableError,
  InvalidCursorError,
  SearchEnginesUnavailableError,
  TooManyFacetsError,
  type SearchOutcome,
  type SearchProducts,
  type SuggestQueries,
} from "../application/search";
import { MAX_PAGE_SIZE, MAX_QUERY_LENGTH } from "../domain/bridge";
import type { ProductFacts } from "../domain/ports";
import { FacetCountsWireSchema, SearchFilterSchema, SearchSortSchema, type SearchFilterWire } from "../domain/schema";
import { SEARCH_PRODUCTS, SUGGEST_QUERIES } from "./tokens";

/** Nil UUID: valid for any adapter, owns no favourites, no size profile, no budget. */
export const PUBLIC_SEARCH_VIEWER = "00000000-0000-4000-8000-000000000000";
export const PUBLIC_DEFAULT_PAGE_SIZE = 24;
export const PUBLIC_MAX_FILTERS_JSON = 2000;

/**
 * Facets an anonymous caller may use. Everything personal (budget_max, fits_remaining_budget,
 * my_size_only, monthly_max), address- or account-dependent (cod_available, payable_with_store_credit,
 * installments_available, free_delivery_eligible) and the `my_stores` world is refused with 400.
 */
export const PUBLIC_FILTER_KEYS = [
  "world",
  "store_ids",
  "category_ids",
  "brand_ids",
  "min_verified_discount_pct",
  "price_min",
  "price_max",
  "colors",
  "materials",
  "conditions",
  "departments",
  "verified_discount_only",
  "lowest_30d_only",
  "new_arrivals",
  "min_rating",
] as const;

const ALLOWED = new Set<string>(PUBLIC_FILTER_KEYS);
const PUBLIC_WORLDS = new Set(["local", "global", "everything"]);

const FiltersParam = z
  .string()
  .max(PUBLIC_MAX_FILTERS_JSON)
  .transform((s, ctx): SearchFilterWire => {
    let v: unknown;
    try {
      v = JSON.parse(s);
    } catch {
      ctx.addIssue({ code: "custom", message: "filters must be URL-decoded JSON" });
      return z.NEVER;
    }
    if (typeof v !== "object" || v === null || Array.isArray(v)) {
      ctx.addIssue({ code: "custom", message: "filters must be an object" });
      return z.NEVER;
    }
    const o = v as Record<string, unknown>;
    for (const k of Object.keys(o)) {
      if (!ALLOWED.has(k)) ctx.addIssue({ code: "custom", message: `facet ${k} is not available on the public surface` });
    }
    if (o["world"] !== undefined && !(typeof o["world"] === "string" && PUBLIC_WORLDS.has(o["world"]))) {
      ctx.addIssue({ code: "custom", message: "world must be local, global or everything" });
    }
    return o as SearchFilterWire;
  })
  // The shared schema owns value validation, canonicalisation and the 30-facet cap (API4).
  .pipe(SearchFilterSchema);

export const PublicSearchQuery = z
  .object({
    q: z.string().max(MAX_QUERY_LENGTH).optional(),
    filters: FiltersParam.optional(),
    sort: SearchSortSchema.optional(),
    cursor: z.string().min(1).max(1024).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(PUBLIC_DEFAULT_PAGE_SIZE),
  })
  .strict();

const text = (t: { readonly ar: string; readonly en?: string | undefined }) => ({ ar: t.ar, ...(t.en !== undefined ? { en: t.en } : {}) });
const money = (m: { readonly amount: bigint; readonly currency: "EGP" }) => ({ amount: m.amount.toString(), currency: m.currency });

/** Allow-listed anonymous listing card (OpenAPI PublicProductSummary). */
export function publicItemWire(f: ProductFacts) {
  const verified = f.badge === "verified_discount" && f.referencePrice !== null && f.discountPct !== null;
  return {
    id: f.productId,
    title: text(f.title),
    store: {
      id: f.store.id,
      slug: f.store.slug,
      name: text(f.store.name),
      kind: f.store.kind,
      ...(f.store.logoUrl !== undefined ? { logo_url: f.store.logoUrl } : {}),
      ...(f.store.coverUrl !== undefined ? { cover_url: f.store.coverUrl } : {}),
      verified_badge: f.store.verifiedBadge,
      max_verified_discount_pct: f.store.maxVerifiedDiscountPct,
      rating: f.store.rating,
      rating_count: f.store.ratingCount,
      follower_count: f.store.followerCount,
      live_drop: f.store.liveDrop,
    },
    ...(f.imageUrl !== undefined ? { image_url: f.imageUrl } : {}),
    ...(f.blurhash !== undefined ? { blurhash: f.blurhash } : {}),
    price: {
      price: money(f.unitPrice),
      badge: verified ? f.badge : f.badge === "verified_discount" ? ("none" as const) : f.badge,
      reference_price: verified && f.referencePrice !== null ? money(f.referencePrice) : null,
      discount_pct: verified ? f.discountPct : null,
    },
    condition: f.condition,
    ...(f.department !== undefined ? { department: f.department } : {}),
    ...(f.brand !== undefined ? { brand: { id: f.brand.id, name: text(f.brand.name) } } : {}),
    sponsored: false as const,
  };
}

/** Sponsored placements are not served on the cacheable anonymous surface (no impression accounting). */
export function publicSearchWire(o: SearchOutcome) {
  return {
    items: o.items.filter((i) => !i.sponsored).map((i) => publicItemWire(i.facts)),
    page: { next_cursor: o.nextCursor, has_more: o.nextCursor !== null },
    total_estimate: o.totalEstimate,
    relaxed_filter: o.relaxedFilters.length > 0 ? o.relaxedFilters.join(",") : null,
    did_you_mean: o.didYouMean,
    ...(o.facetCounts !== undefined && !o.degraded
      ? { facet_counts: FacetCountsWireSchema.parse({ category_ids: o.facetCounts.categories, store_ids: o.facetCounts.stores }) }
      : {}),
  };
}

/** Same bounds as the shopper route; the prefix is the only input. */
const PublicSuggestQuery = z.object({ q: z.string().min(1).max(100) }).strict();

@Controller("public")
export class PublicSearchController {
  constructor(
    @Inject(PUBLIC_READ_GATE) private readonly gate: PublicReadGate,
    @Inject(SEARCH_PRODUCTS) private readonly search: SearchProducts,
    @Inject(GUEST_BROWSING_GATE) private readonly guest: PublicReadGate,
    @Inject(SUGGEST_QUERIES) private readonly suggestions: SuggestQueries,
  ) {}

  /**
   * Guest type-ahead (ADR-0055 G-5): queries from the index, stores and categories by prefix. No recents and no
   * per-user value (`is_favorite` is not served); the viewer is the nil user. Dark behind `flag.guest_browsing`.
   */
  @Get("search/suggestions")
  @Public()
  @RateLimit([
    { dimension: "device", limit: 30, windowSeconds: 10 },
    { dimension: "ip", limit: 120, windowSeconds: 10 },
  ])
  async suggest(
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: ApiResponse,
    @Query(new ZodPipe(PublicSuggestQuery, "/query")) q: z.infer<typeof PublicSuggestQuery>,
  ) {
    await assertGuestBrowsingEnabled(this.guest);
    await assertPublicReadEnabled(this.gate);
    let r;
    try {
      r = await this.suggestions.execute({ userId: PUBLIC_SEARCH_VIEWER, q: q.q });
    } catch (e) {
      if (e instanceof CatalogUnavailableError) throw Problems.unavailable("catalog_unavailable");
      if (e instanceof SearchEnginesUnavailableError) throw Problems.unavailable("search_unavailable");
      throw e;
    }
    return respondPublic(
      req,
      res,
      {
        queries: r.queries,
        stores: r.stores.map((s) => ({
          id: s.id,
          slug: s.slug,
          name: text(s.name),
          kind: s.kind,
          ...(s.logoUrl !== undefined ? { logo_url: s.logoUrl } : {}),
          ...(s.coverUrl !== undefined ? { cover_url: s.coverUrl } : {}),
          verified_badge: s.verifiedBadge,
          max_verified_discount_pct: s.maxVerifiedDiscountPct,
          rating: s.rating,
          rating_count: s.ratingCount,
          follower_count: s.followerCount,
          live_drop: s.liveDrop,
        })),
        categories: r.categories.map((c) => ({ id: c.id, name: text(c.name) })),
      },
      PUBLIC_CACHE.suggest,
    );
  }

  @Get("search")
  @Public()
  @RateLimit([{ dimension: "ip", limit: 300, windowSeconds: 60 }])
  async run(
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: ApiResponse,
    @Query(new ZodPipe(PublicSearchQuery, "/query")) q: z.infer<typeof PublicSearchQuery>,
  ) {
    await assertPublicReadEnabled(this.gate);
    let outcome: SearchOutcome;
    try {
      outcome = await this.search.execute({
        userId: PUBLIC_SEARCH_VIEWER,
        q: q.q ?? "",
        filter: q.filters ?? {},
        limit: q.limit,
        ...(q.sort !== undefined ? { sort: q.sort } : {}),
        ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
      });
    } catch (e) {
      if (e instanceof CatalogUnavailableError) throw Problems.unavailable("catalog_unavailable");
      if (e instanceof SearchEnginesUnavailableError) throw Problems.unavailable("search_unavailable");
      if (e instanceof InvalidCursorError) throw new ProblemError(400, "invalid-cursor", "The cursor is invalid", { code: "invalid_cursor" });
      if (e instanceof TooManyFacetsError) throw Problems.validation([{ pointer: "/query/filters", code: "too_many_facets" }]);
      throw e;
    }
    return respondPublic(req, res, publicSearchWire(outcome), PUBLIC_CACHE.search);
  }
}
