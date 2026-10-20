import { createHash } from "node:crypto";
import { Controller, Get, Inject, Param, Query, Req, Res } from "@nestjs/common";
import { z } from "zod";
import { Authorize, RateLimit } from "../../../platform/decorators";
import { headerValue, type ApiRequest, type ApiResponse } from "../../../platform/http-types";
import { Problems } from "../../../platform/problem";
import { ZodPipe } from "../../../platform/zod.pipe";
import { PERIODS, type SellerDashboardSummary } from "../application/dashboard";
import { AnalyticsDependencyUnavailableError } from "../domain/ports";
import { SELLER_ANALYTICS_STORE_RESOLVER, SELLER_DASHBOARD_OPTIONS, SELLER_DASHBOARD_SUMMARY } from "./tokens";
import { dashboardSummaryWire } from "./wire";

export interface SellerDashboardOptions {
  /** `release.seller_analytics.dashboard_summary`. Default blocked: 404 before any data is read (ADR-0029). */
  readonly enabled: () => Promise<boolean> | boolean;
}

const Params = z.object({ storeId: z.uuid() }).strict();
const Query_ = z.object({ period: z.enum(PERIODS).default("7d") }).strict();

/** Store dashboard summary for the mobile brand mode and Seller Center (build plan W1-A). */
@Controller("seller/stores/:storeId/dashboard")
export class SellerDashboardController {
  constructor(
    @Inject(SELLER_DASHBOARD_SUMMARY) private readonly summary: SellerDashboardSummary,
    @Inject(SELLER_DASHBOARD_OPTIONS) private readonly opts: SellerDashboardOptions,
  ) {}

  @Get("summary")
  @Authorize({ audience: "seller_api", action: "read", resourceType: "store_order", resolver: SELLER_ANALYTICS_STORE_RESOLVER, idParam: "storeId" })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async get(
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: ApiResponse,
    @Param(new ZodPipe(Params, "/params")) p: z.infer<typeof Params>,
    @Query(new ZodPipe(Query_, "/query")) q: z.infer<typeof Query_>,
  ) {
    if (!(await this.opts.enabled())) throw Problems.notFound();
    let body;
    try {
      body = dashboardSummaryWire(await this.summary.summary(p.storeId.toLowerCase(), q.period));
    } catch (e) {
      if (e instanceof AnalyticsDependencyUnavailableError) throw Problems.unavailable("seller_analytics_unavailable");
      throw e;
    }
    // Strong ETag over the stable content only (window end, lag and server time move on every call).
    const stable = { from: body.current.from, prevFrom: body.previous.from, c: { ...body.current, to: null }, p: { ...body.previous, to: null }, g: body.growth, d: body.daily_sales, a: body.data_as_of, s: body.store_id, per: body.period };
    const etag = `"${createHash("sha256").update(JSON.stringify(stable)).digest("hex").slice(0, 32)}"`;
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("ETag", etag);
    if (headerValue(req, "if-none-match") === etag) {
      res.status(304);
      return undefined;
    }
    return body;
  }
}
