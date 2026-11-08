import { Controller, Get, Inject, Req } from "@nestjs/common";
import { DefectPassport, ProductDetail, StoreDetail } from "@outlet/catalog";
import { z } from "zod";
import { Contract, Paginated, Public, RateLimit } from "../../platform/decorators.js";
import { API_DEPS } from "../../platform/deps.js";
import type { ApiDeps } from "../../platform/deps.js";
import { headerValue } from "../../platform/http.js";
import type { ApiRequest, RequestState } from "../../platform/http.js";
import { CursorQuery } from "../../platform/pagination.js";
import { Problems } from "../../platform/problem.js";
import { RATE_BUDGETS } from "../../platform/rate-limit/budgets.js";
import { Ctx, Params, Query } from "../../platform/validation.js";
import { CategoriesQuery, CategoryEntryPage, DealCardPage, DealsQuery, QuickProductCardPage, StoreCardPage, StoresQuery } from "./dto.js";

const StoreSlug = z.strictObject({ store_slug: z.string().regex(/^[a-z0-9-]{3,40}$/) });
const ProductId = z.strictObject({ product_id: z.uuid() });
const PassportCode = z.strictObject({ passport_code: z.string().regex(/^[A-Za-z0-9_-]{22,32}$/) });

const marketOf = (s: RequestState): string => {
  if (s.marketId === undefined) throw Problems.notFound("unknown-market");
  return s.marketId;
};

/** Shopper-facing catalog reads from the published read model (no tenant data, no personal data). */
@Controller("v1/:market")
export class CatalogPublicController {
  constructor(@Inject(API_DEPS) private readonly deps: ApiDeps) {}

  @Get("stores/:store_slug")
  @Public()
  @RateLimit({ budget: RATE_BUDGETS.publicRead })
  @Contract({
    operationId: "getStore",
    summary: "Store page header with seller legal identity",
    tags: ["Village"],
    params: StoreSlug,
    response: StoreDetail,
    cacheControl: "public, max-age=60, stale-while-revalidate=120",
    maxQueries: 1,
  })
  getStore(@Ctx() s: RequestState, @Params() p: z.infer<typeof StoreSlug>): Promise<StoreDetail> {
    return this.deps.catalog(marketOf(s)).publicCatalog.getStoreBySlug(p.store_slug);
  }

  @Get("stores")
  @Public()
  @Paginated()
  @RateLimit({ budget: RATE_BUDGETS.publicRead })
  @Contract({
    operationId: "listStores",
    summary: "Store carousel / directory (slug order, keyset)",
    tags: ["Village"],
    query: StoresQuery,
    response: StoreCardPage,
    cacheControl: "public, max-age=60, stale-while-revalidate=300",
    maxQueries: 1,
  })
  listStores(@Ctx() s: RequestState, @Query() q: StoresQuery): Promise<StoreCardPage> {
    return this.deps.catalog(marketOf(s)).discovery.listStores(q);
  }

  @Get("categories")
  @Public()
  @Paginated()
  @RateLimit({ budget: RATE_BUDGETS.publicRead })
  @Contract({
    operationId: "listCategories",
    summary: "Category tree for the market (path order; parent_id walks one level)",
    tags: ["Village"],
    query: CategoriesQuery,
    response: CategoryEntryPage,
    cacheControl: "public, max-age=60, stale-while-revalidate=300",
    maxQueries: 1,
  })
  listCategories(@Ctx() s: RequestState, @Req() req: ApiRequest, @Query() q: CategoriesQuery): Promise<CategoryEntryPage> {
    const locale = /^\s*en\b/i.test(headerValue(req, "accept-language") ?? "") ? "en" : "ar";
    return this.deps.catalog(marketOf(s)).discovery.listCategories(q, locale);
  }

  @Get("deals")
  @Public()
  @Paginated()
  @RateLimit({ budget: RATE_BUDGETS.publicRead })
  @Contract({
    operationId: "listDeals",
    summary: "Discover deals: products in one verified-discount band",
    tags: ["Village"],
    query: DealsQuery,
    response: DealCardPage,
    // Prices must never come from a stale cache (BUILD-PROMPT section 3).
    cacheControl: "no-store",
    maxQueries: 3,
  })
  listDeals(@Ctx() s: RequestState, @Query() q: DealsQuery): Promise<DealCardPage> {
    return this.deps.catalog(marketOf(s)).deals.list(q);
  }

  @Get("products/:product_id")
  @Public()
  @RateLimit({ budget: RATE_BUDGETS.publicRead })
  @Contract({
    operationId: "getProduct",
    summary: "Product page model",
    tags: ["Catalog"],
    params: ProductId,
    response: ProductDetail,
    cacheControl: "no-store",
    maxQueries: 2,
  })
  async getProduct(@Ctx() s: RequestState, @Params() p: z.infer<typeof ProductId>): Promise<ProductDetail> {
    const detail = await this.deps.catalog(marketOf(s)).publicCatalog.getListing(p.product_id);
    // Sold-out and paused listings are not served as a product page (404), never as a buyable one.
    if (detail.status !== "PUBLISHED") throw Problems.notFound();
    return detail;
  }

  @Get("stores/:store_slug/products")
  @Public()
  @Paginated()
  @RateLimit({ budget: RATE_BUDGETS.publicRead })
  @Contract({
    operationId: "listStoreProducts",
    summary: "Products of a store, newest first (keyset), with quick-view fields",
    tags: ["Village"],
    params: StoreSlug,
    query: CursorQuery,
    response: QuickProductCardPage,
    cacheControl: "no-store",
    maxQueries: 2,
  })
  listStoreProducts(@Ctx() s: RequestState, @Params() p: z.infer<typeof StoreSlug>, @Query() q: CursorQuery): Promise<QuickProductCardPage> {
    return this.deps.catalog(marketOf(s)).discovery.listStoreProducts(p.store_slug, { limit: q.limit, ...(q.cursor === undefined ? {} : { cursor: q.cursor }) });
  }

  @Get("passports/:passport_code")
  @Public()
  @RateLimit({ budget: RATE_BUDGETS.passportRead })
  @Contract({
    operationId: "getDefectPassport",
    summary: "Public QR defect passport",
    tags: ["Catalog"],
    params: PassportCode,
    response: DefectPassport,
    cacheControl: "public, max-age=300",
    maxQueries: 1,
  })
  getPassport(@Ctx() s: RequestState, @Params() p: z.infer<typeof PassportCode>): Promise<DefectPassport> {
    return this.deps.catalog(marketOf(s)).defects.lookupPassport(p.passport_code);
  }
}
