import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from "@nestjs/common";
import { z } from "zod";
import { Authorize, RateLimit } from "../../../platform/decorators";
import type { ApiRequest } from "../../../platform/http-types";
import { Problems } from "../../../platform/problem";
import type { Clock } from "../../../platform/ports";
import { CLOCK } from "../../../platform/tokens";
import { ZodPipe } from "../../../platform/zod.pipe";
import { InvalidRangeError, REPORTS, type SellerAnalyticsQueries } from "../application/queries";
import { AnalyticsDependencyUnavailableError } from "../domain/ports";
import {
  SELLER_ANALYTICS_QUERIES,
  SELLER_ANALYTICS_STORE_RESOLVER,
  SELLER_ANALYTICS_SETTINGS_RESOLVER,
} from "./tokens";
import {
  agingWire,
  funnelReportWire,
  geographyWire,
  returnsWire,
  salesWire,
  searchTermsWire,
  sellThroughWire,
  sizeCurveWire,
  trafficWire,
} from "./wire";

const DAY = 86_400_000;
const StoreParam = z.object({ storeId: z.uuid() }).strict();
const RangeQuery = z
  .object({ from: z.iso.datetime().optional(), to: z.iso.datetime().optional() })
  .strict();
const FunnelQuery = RangeQuery.extend({ product_id: z.uuid().optional() }).strict();
const SizeQuery = RangeQuery.extend({ size_order: z.string().max(120).optional() }).strict();
const ExportBody = z
  .object({ report: z.enum(REPORTS), from: z.iso.datetime().optional(), to: z.iso.datetime().optional() })
  .strict();

function principalOf(req: ApiRequest) {
  const p = req.principal;
  if (p === null || p === undefined) throw Problems.unauthenticated();
  return p;
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof InvalidRangeError) throw Problems.validation([{ pointer: "/query/from", code: "invalid_range" }]);
    if (e instanceof AnalyticsDependencyUnavailableError) throw Problems.unavailable("seller_analytics_unavailable");
    throw e;
  }
}

const READ = (resolver: symbol) =>
  Authorize({ audience: "seller_api", action: "read", resourceType: "store_order", resolver, idParam: "storeId" });

@Controller("seller/stores/:storeId/analytics")
export class SellerAnalyticsController {
  constructor(
    @Inject(SELLER_ANALYTICS_QUERIES) private readonly q: SellerAnalyticsQueries,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private range(from: string | undefined, to: string | undefined) {
    const toMs = to === undefined ? this.clock.nowMs() : Date.parse(to);
    const fromMs = from === undefined ? toMs - 30 * DAY : Date.parse(from);
    return { fromMs, toMs };
  }

  @Get("traffic")
  @READ(SELLER_ANALYTICS_STORE_RESOLVER)
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async traffic(
    @Param(new ZodPipe(StoreParam, "/params")) p: z.infer<typeof StoreParam>,
    @Query(new ZodPipe(RangeQuery, "/query")) qs: z.infer<typeof RangeQuery>,
  ) {
    return trafficWire(await guarded(() => this.q.traffic(p.storeId.toLowerCase(), this.range(qs.from, qs.to))));
  }

  @Get("funnel")
  @READ(SELLER_ANALYTICS_STORE_RESOLVER)
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async funnel(
    @Param(new ZodPipe(StoreParam, "/params")) p: z.infer<typeof StoreParam>,
    @Query(new ZodPipe(FunnelQuery, "/query")) qs: z.infer<typeof FunnelQuery>,
  ) {
    return funnelReportWire(
      await guarded(() => this.q.funnel(p.storeId.toLowerCase(), this.range(qs.from, qs.to), qs.product_id?.toLowerCase() ?? null)),
    );
  }

  @Get("sales")
  @READ(SELLER_ANALYTICS_STORE_RESOLVER)
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async sales(
    @Param(new ZodPipe(StoreParam, "/params")) p: z.infer<typeof StoreParam>,
    @Query(new ZodPipe(RangeQuery, "/query")) qs: z.infer<typeof RangeQuery>,
  ) {
    return salesWire(await guarded(() => this.q.sales(p.storeId.toLowerCase(), this.range(qs.from, qs.to))));
  }

  @Get("sell-through")
  @READ(SELLER_ANALYTICS_STORE_RESOLVER)
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async sellThrough(
    @Param(new ZodPipe(StoreParam, "/params")) p: z.infer<typeof StoreParam>,
    @Query(new ZodPipe(RangeQuery, "/query")) qs: z.infer<typeof RangeQuery>,
  ) {
    return sellThroughWire(await guarded(() => this.q.sellThrough(p.storeId.toLowerCase(), this.range(qs.from, qs.to))));
  }

  @Get("size-curve")
  @READ(SELLER_ANALYTICS_STORE_RESOLVER)
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async sizeCurve(
    @Param(new ZodPipe(StoreParam, "/params")) p: z.infer<typeof StoreParam>,
    @Query(new ZodPipe(SizeQuery, "/query")) qs: z.infer<typeof SizeQuery>,
  ) {
    const order = qs.size_order === undefined ? [] : qs.size_order.split(",").map((s) => s.trim()).filter((s) => s !== "");
    return sizeCurveWire(await guarded(() => this.q.sizeCurve(p.storeId.toLowerCase(), this.range(qs.from, qs.to), order)));
  }

  @Get("aging")
  @READ(SELLER_ANALYTICS_STORE_RESOLVER)
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async aging(
    @Param(new ZodPipe(StoreParam, "/params")) p: z.infer<typeof StoreParam>,
    @Query(new ZodPipe(RangeQuery, "/query")) qs: z.infer<typeof RangeQuery>,
  ) {
    return agingWire(await guarded(() => this.q.aging(p.storeId.toLowerCase(), this.range(qs.from, qs.to))));
  }

  @Get("returns")
  @READ(SELLER_ANALYTICS_STORE_RESOLVER)
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async returns(
    @Param(new ZodPipe(StoreParam, "/params")) p: z.infer<typeof StoreParam>,
    @Query(new ZodPipe(RangeQuery, "/query")) qs: z.infer<typeof RangeQuery>,
  ) {
    return returnsWire(await guarded(() => this.q.returns(p.storeId.toLowerCase(), this.range(qs.from, qs.to))));
  }

  @Get("search-terms")
  @READ(SELLER_ANALYTICS_STORE_RESOLVER)
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async searchTerms(
    @Param(new ZodPipe(StoreParam, "/params")) p: z.infer<typeof StoreParam>,
    @Query(new ZodPipe(RangeQuery, "/query")) qs: z.infer<typeof RangeQuery>,
  ) {
    return searchTermsWire(await guarded(() => this.q.searchTerms(p.storeId.toLowerCase(), this.range(qs.from, qs.to))));
  }

  @Get("geography")
  @READ(SELLER_ANALYTICS_STORE_RESOLVER)
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async geography(
    @Param(new ZodPipe(StoreParam, "/params")) p: z.infer<typeof StoreParam>,
    @Query(new ZodPipe(RangeQuery, "/query")) qs: z.infer<typeof RangeQuery>,
  ) {
    return geographyWire(await guarded(() => this.q.geography(p.storeId.toLowerCase(), this.range(qs.from, qs.to))));
  }

  /** Watermarked CSV, audit-logged. Owner and manager only (store_settings read rule). */
  @Post("exports")
  @HttpCode(200)
  @Authorize({
    audience: "seller_api",
    action: "read",
    resourceType: "store_settings",
    resolver: SELLER_ANALYTICS_SETTINGS_RESOLVER,
    idParam: "storeId",
  })
  @RateLimit([{ dimension: "user", limit: 10, windowSeconds: 60 }])
  async exportCsv(
    @Req() req: ApiRequest,
    @Param(new ZodPipe(StoreParam, "/params")) p: z.infer<typeof StoreParam>,
    @Body(new ZodPipe(ExportBody)) body: z.infer<typeof ExportBody>,
  ) {
    const actor = principalOf(req).actor;
    const r = await guarded(() =>
      this.q.exportCsv(actor.id, p.storeId.toLowerCase(), body.report, this.range(body.from, body.to)),
    );
    return { filename: r.filename, content_type: "text/csv; charset=utf-8", watermark: r.watermark, row_count: r.rowCount, csv: r.csv };
  }
}
