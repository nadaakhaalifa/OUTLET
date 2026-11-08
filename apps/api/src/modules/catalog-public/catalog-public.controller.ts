import { Controller, Get, Inject } from "@nestjs/common";
import { DefectPassport, ProductCardPage, StoreDetail } from "@outlet/catalog";
import { z } from "zod";
import { Contract, Paginated, Public, RateLimit } from "../../platform/decorators.js";
import { API_DEPS } from "../../platform/deps.js";
import type { ApiDeps } from "../../platform/deps.js";
import type { RequestState } from "../../platform/http.js";
import { CursorQuery } from "../../platform/pagination.js";
import { Problems } from "../../platform/problem.js";
import { RATE_BUDGETS } from "../../platform/rate-limit/budgets.js";
import { Ctx, Params, Query } from "../../platform/validation.js";

const StoreSlug = z.strictObject({ store_slug: z.string().regex(/^[a-z0-9-]{3,40}$/) });
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

  @Get("stores/:store_slug/products")
  @Public()
  @Paginated()
  @RateLimit({ budget: RATE_BUDGETS.publicRead })
  @Contract({
    operationId: "listStoreProducts",
    summary: "Products of a store, newest first (keyset)",
    tags: ["Village"],
    params: StoreSlug,
    query: CursorQuery,
    response: ProductCardPage,
    cacheControl: "public, max-age=30, stale-while-revalidate=60",
    maxQueries: 2,
  })
  async listStoreProducts(@Ctx() s: RequestState, @Params() p: z.infer<typeof StoreSlug>, @Query() q: CursorQuery): Promise<ProductCardPage> {
    const page = await this.deps.catalog(marketOf(s)).publicCatalog.getStorePage(p.store_slug, { limit: q.limit, ...(q.cursor === undefined ? {} : { cursor: q.cursor }) });
    return page.listings;
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
