import { Controller, Get, HttpCode, Inject, Post, Req } from "@nestjs/common";
import type { Principal } from "@outlet/policy";
import { Authorize, Contract, Paginated, RateLimit } from "../../platform/decorators.js";
import { API_DEPS } from "../../platform/deps.js";
import type { ApiDeps, SellerInventoryServices } from "../../platform/deps.js";
import { headerValue } from "../../platform/http.js";
import type { ApiRequest, RequestState } from "../../platform/http.js";
import { Problems } from "../../platform/problem.js";
import { RATE_BUDGETS } from "../../platform/rate-limit/budgets.js";
import { activeStore } from "../../platform/resolvers.js";
import { Body, Ctx, Query } from "../../platform/validation.js";
import { InventoryAdjustmentInput, InventoryLevel, InventoryLevelPage, InventoryQuery } from "./dto.js";

interface Tenant { readonly principal: Principal; readonly storeId: string; readonly svc: SellerInventoryServices["inventory"] }

/** Seller Center stock (store tenant). Reads need `listing.read`, adjustments `listing.write` (the same action @outlet/inventory enforces). */
@Controller("v1/:market/seller")
export class SellerInventoryController {
  constructor(@Inject(API_DEPS) private readonly deps: ApiDeps) {}

  private tenant(s: RequestState): Tenant {
    if (s.principal === undefined || s.storeId === undefined || s.marketId === undefined) throw Problems.internal("tenant-context-missing");
    return { principal: s.principal, storeId: s.storeId, svc: this.deps.sellerInventory(s.marketId).inventory };
  }

  @Get("inventory")
  @Paginated()
  @Authorize("listing.read", activeStore, { tenant: "store" })
  @RateLimit({ budget: RATE_BUDGETS.sellerRead })
  @Contract({ operationId: "listInventoryLevels", summary: "Stock levels per SKU (real counts, low-stock flag)", tags: ["Seller Inventory"], query: InventoryQuery, response: InventoryLevelPage, maxQueries: 2 })
  list(@Ctx() s: RequestState, @Query() q: InventoryQuery): Promise<InventoryLevelPage> {
    const t = this.tenant(s);
    return t.svc.list(t.principal, t.storeId, q);
  }

  @Post("inventory/adjustments")
  @HttpCode(201)
  @Authorize("listing.write", activeStore, { tenant: "store" })
  @RateLimit({ budget: RATE_BUDGETS.sellerWrite })
  @Contract({
    operationId: "adjustInventory",
    summary: "Adjust on-hand stock (delta + reason, idempotent, optional expected_version)",
    tags: ["Seller Inventory"],
    body: InventoryAdjustmentInput,
    response: InventoryLevel,
    status: 201,
    maxQueries: 24,
  })
  adjust(@Ctx() s: RequestState, @Req() req: ApiRequest, @Body() body: InventoryAdjustmentInput): Promise<InventoryLevel> {
    const t = this.tenant(s);
    // The same client key drives the inventory ledger's own unique (store, key) record, next to the HTTP idempotency record.
    return t.svc.adjust(t.principal, t.storeId, headerValue(req, "idempotency-key") ?? "", body);
  }
}
