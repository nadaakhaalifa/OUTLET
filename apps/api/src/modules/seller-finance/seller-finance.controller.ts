import { Controller, Get, Inject } from "@nestjs/common";
import type { Principal } from "@outlet/policy";
import { Authorize, Contract, Paginated, RateLimit } from "../../platform/decorators.js";
import { API_DEPS } from "../../platform/deps.js";
import type { ApiDeps, SellerFinanceServices } from "../../platform/deps.js";
import type { RequestState } from "../../platform/http.js";
import { Problems } from "../../platform/problem.js";
import { RATE_BUDGETS } from "../../platform/rate-limit/budgets.js";
import { activeStore } from "../../platform/resolvers.js";
import { Ctx, Params, Query } from "../../platform/validation.js";
import { PayoutDetail, PayoutIdParams, PayoutPage, PayoutsQuery, SellerBalance, SellerStatement, StatementQuery } from "./dto.js";

interface Tenant { readonly principal: Principal; readonly storeId: string; readonly svc: SellerFinanceServices["finance"] }

/**
 * Seller Center finance (read only, store tenant: X-Store-Id, passkey session). Balance and payouts need `payout.read`, statements `statement.read`
 * (owner and finance roles in SELLER_POLICY). No money moves here.
 */
@Controller("v1/:market/seller/finance")
export class SellerFinanceController {
  constructor(@Inject(API_DEPS) private readonly deps: ApiDeps) {}

  private tenant(s: RequestState): Tenant {
    if (s.principal === undefined || s.storeId === undefined || s.marketId === undefined) throw Problems.internal("tenant-context-missing");
    return { principal: s.principal, storeId: s.storeId, svc: this.deps.sellerFinance(s.marketId).finance };
  }

  @Get("balance")
  @Authorize("payout.read", activeStore, { tenant: "store" })
  @RateLimit({ budget: RATE_BUDGETS.sellerRead })
  @Contract({ operationId: "getSellerBalance", summary: "My store balance (pending, available) and payout totals by state", tags: ["Seller Finance"], response: SellerBalance, maxQueries: 3 })
  balance(@Ctx() s: RequestState): Promise<SellerBalance> {
    const t = this.tenant(s);
    return t.svc.balance(t.principal, t.storeId);
  }

  @Get("payouts")
  @Paginated()
  @Authorize("payout.read", activeStore, { tenant: "store" })
  @RateLimit({ budget: RATE_BUDGETS.sellerRead })
  @Contract({ operationId: "listSellerPayouts", summary: "My store payouts, newest first (status filter)", tags: ["Seller Finance"], query: PayoutsQuery, response: PayoutPage, maxQueries: 2 })
  list(@Ctx() s: RequestState, @Query() q: PayoutsQuery): Promise<PayoutPage> {
    const t = this.tenant(s);
    return t.svc.listPayouts(t.principal, t.storeId, q);
  }

  @Get("payouts/:payout_id")
  @Authorize("payout.read", activeStore, { tenant: "store" })
  @RateLimit({ budget: RATE_BUDGETS.sellerRead })
  @Contract({ operationId: "getSellerPayout", summary: "One payout with its lines (another store's payout is 404)", tags: ["Seller Finance"], params: PayoutIdParams, response: PayoutDetail, maxQueries: 3 })
  get(@Ctx() s: RequestState, @Params() p: PayoutIdParams): Promise<PayoutDetail> {
    const t = this.tenant(s);
    return t.svc.getPayout(t.principal, t.storeId, p.payout_id);
  }

  @Get("statements")
  @Authorize("statement.read", activeStore, { tenant: "store" })
  @RateLimit({ budget: RATE_BUDGETS.sellerRead })
  @Contract({ operationId: "getSellerStatement", summary: "Monthly statement (read model over the ledger, Cairo calendar month)", tags: ["Seller Finance"], query: StatementQuery, response: SellerStatement, maxQueries: 4 })
  statement(@Ctx() s: RequestState, @Query() q: StatementQuery): Promise<SellerStatement> {
    const t = this.tenant(s);
    return t.svc.statement(t.principal, t.storeId, q);
  }
}
