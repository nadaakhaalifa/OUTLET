import { Controller, HttpCode, Inject, Post } from "@nestjs/common";
import { ProductDraftInput, SellerProduct } from "@outlet/catalog";
import { Authorize, Contract, RateLimit } from "../../platform/decorators.js";
import { API_DEPS } from "../../platform/deps.js";
import type { ApiDeps } from "../../platform/deps.js";
import type { RequestState } from "../../platform/http.js";
import { Problems } from "../../platform/problem.js";
import { RATE_BUDGETS } from "../../platform/rate-limit/budgets.js";
import { activeStore } from "../../platform/resolvers.js";
import { Body, Ctx } from "../../platform/validation.js";

/** Seller Center listings (store tenant: X-Store-Id, passkey session, role from @outlet/policy SELLER_POLICY). */
@Controller("v1/:market/seller")
export class SellerListingsController {
  constructor(@Inject(API_DEPS) private readonly deps: ApiDeps) {}

  @Post("products")
  @HttpCode(201)
  @Authorize("listing.write", activeStore, { tenant: "store" })
  @RateLimit({ budget: RATE_BUDGETS.sellerWrite })
  @Contract({
    operationId: "createProductDraft",
    summary: "Start a new listing (DRAFT)",
    tags: ["Seller Listings"],
    body: ProductDraftInput,
    response: SellerProduct,
    status: 201,
    // 2 idempotency (begin, complete) + 9 catalog (grade, category, attribute set, 2 inserts, 4 reads of the view):
    // a constant, independent of how many listings or SKUs exist.
    maxQueries: 11,
  })
  createDraft(@Ctx() s: RequestState, @Body() body: ProductDraftInput): Promise<SellerProduct> {
    // PolicyGuard set these; the service re-checks the same principal against the same store (defence in depth).
    if (s.principal === undefined || s.storeId === undefined || s.marketId === undefined) throw Problems.internal("tenant-context-missing");
    return this.deps.catalog(s.marketId).listings.createDraft(s.principal, s.storeId, body);
  }
}
