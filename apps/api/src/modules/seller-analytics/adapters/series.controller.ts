import { Controller, Get, Inject, Param, Query, Req, Res } from "@nestjs/common";
import { z } from "zod";
import { Authorize, RateLimit } from "../../../platform/decorators";
import { headerValue, type ApiRequest, type ApiResponse } from "../../../platform/http-types";
import type { Clock } from "../../../platform/ports";
import { ProblemError, Problems } from "../../../platform/problem";
import { CLOCK } from "../../../platform/tokens";
import { ZodPipe } from "../../../platform/zod.pipe";
import {
  GRAINS,
  InvalidWindowError,
  MetricSourceUnconfiguredError,
  planSeries,
  readSeries,
  seriesEtag,
  type Compare,
  type Grain,
  type SeriesRequest,
} from "../../platform-metrics";
import { AnalyticsDependencyUnavailableError } from "../domain/ports";
import type { SellerRollupReader } from "../domain/series-ports";
import { SELLER_BREAKDOWNS, SUMMARY_TILES, sellerMetric } from "../domain/series-registry";
import { SELLER_ANALYTICS_STORE_RESOLVER, SELLER_SERIES_OPTIONS, SELLER_SERIES_READER } from "./tokens";

export interface SellerSeriesOptions {
  /** `release.seller_analytics.series`: ungated series and the summary route. Default blocked (404). */
  readonly seriesEnabled: () => Promise<boolean> | boolean;
  /** `release.seller_analytics.shopper_series` (DPO-controlled): every shopper-gated series and breakdown. Default blocked (404). */
  readonly shopperSeriesEnabled: () => Promise<boolean> | boolean;
  readonly countRead: (metricId: string) => void;
}

const StoreMetric = z.object({ storeId: z.uuid(), metricId: z.string().max(80) }).strict();
const StoreOnly = z.object({ storeId: z.uuid() }).strict();
const Instant = z.iso.datetime({ offset: true }).transform((s) => Date.parse(s));
const SeriesQuery = z
  .object({
    from: Instant.optional(),
    to: Instant.optional(),
    preset: z.string().max(40).optional(),
    grain: z.enum(GRAINS),
    compare: z.enum(["previous_period", "none"]).default("previous_period"),
  })
  .strict();
const SummaryQuery = z.object({ from: Instant, to: Instant }).strict();
const BreakdownQuery = z
  .object({ preset: z.string().max(40), grain: z.enum(GRAINS), dimension: z.enum(["source", "governorate"]) })
  .strict();

/** Fixed calendar grid for shopper-gated metrics (spec B2): month:YYYY-MM, last_full_months:{1,3,6,12}, current_month. */
export const PRESET = /^(month:[0-9]{4}-(0[1-9]|1[0-2])|last_full_months:(1|3|6|12)|current_month)$/;
export const GATED_GRAINS: readonly Grain[] = ["day", "month"];

const unknownMetric = () => new ProblemError(404, "unknown-metric", "Unknown metric", { code: "unknown_metric" });
const READ = Authorize({ audience: "seller_api", action: "read", resourceType: "store_order", resolver: SELLER_ANALYTICS_STORE_RESOLVER, idParam: "storeId" });
const RL = RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }]);

/** Seller time series (dashboard foundations track 4). Same gate as the nine legacy routes: store_order read, foreign store 404. */
@Controller("seller/stores/:storeId/analytics")
export class SellerSeriesController {
  constructor(
    @Inject(SELLER_SERIES_READER) private readonly reader: SellerRollupReader,
    @Inject(SELLER_SERIES_OPTIONS) private readonly opts: SellerSeriesOptions,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private async guarded<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof InvalidWindowError) throw Problems.validation([{ pointer: "/query/from", code: e.code }]);
      if (e instanceof MetricSourceUnconfiguredError) throw Problems.unavailable("metric_source_unconfigured");
      if (e instanceof AnalyticsDependencyUnavailableError) throw Problems.unavailable("seller_analytics_unavailable");
      throw e;
    }
  }

  /** Preset and grain rules of shopper-gated metrics; always ends in 503 until a facts reader and the suppression memo are wired. */
  private gatedGrid(q: { from?: number | undefined; to?: number | undefined; preset?: string | undefined; grain: Grain }): never {
    if (q.from !== undefined || q.to !== undefined || q.preset === undefined || !PRESET.test(q.preset)) {
      throw Problems.validation([{ pointer: "/query/preset", code: "window_not_on_grid" }]);
    }
    if (!GATED_GRAINS.includes(q.grain)) throw Problems.validation([{ pointer: "/query/grain", code: "grain_not_allowed" }]);
    throw Problems.unavailable("metric_source_unconfigured");
  }

  @Get("series/:metricId")
  @READ
  @RL
  async series(
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: ApiResponse,
    @Param(new ZodPipe(StoreMetric, "/params")) p: z.infer<typeof StoreMetric>,
    @Query(new ZodPipe(SeriesQuery, "/query")) q: z.infer<typeof SeriesQuery>,
  ) {
    // Flag first: with the series flag blocked, real and unknown ids answer with the same body.
    if (!(await this.opts.seriesEnabled())) throw Problems.notFound();
    const entry = sellerMetric(p.metricId);
    if (entry === undefined) throw unknownMetric();
    if (entry.gated) {
      // Blocked: indistinguishable from an unknown id.
      if (!(await this.opts.shopperSeriesEnabled())) throw unknownMetric();
      return this.gatedGrid(q);
    }
    if (q.preset !== undefined || q.from === undefined || q.to === undefined) {
      throw Problems.validation([{ pointer: "/query/from", code: q.preset !== undefined ? "unexpected_preset" : "invalid_window" }]);
    }
    if (entry.needsFacts) throw Problems.unavailable("metric_source_unconfigured");
    const storeId = p.storeId.toLowerCase();
    const request: SeriesRequest = { def: entry.def, grain: q.grain, fromMs: q.from, toMs: q.to, compare: q.compare, nowMs: this.clock.nowMs() };
    return this.guarded(async () => {
      const plan = planSeries(request);
      const fresh = await this.reader.freshness(storeId);
      const etag = seriesEtag({ metricId: entry.def.id, buckets: plan.buckets, grain: q.grain, compare: q.compare, scope: `store:${storeId}`, asOfMs: fresh.asOfMs, epoch: fresh.epoch });
      res.setHeader("Cache-Control", "private, max-age=60");
      res.setHeader("ETag", etag);
      if (headerValue(req, "if-none-match") === etag) {
        res.status(304);
        return undefined;
      }
      const body = await readSeries({ freshness: () => this.reader.freshness(storeId), read: (m, f, t) => this.reader.read(storeId, m, f, t) }, request, plan, fresh.asOfMs);
      this.opts.countRead(entry.def.id);
      return body;
    });
  }

  @Get("series/:metricId/breakdown")
  @READ
  @RL
  async breakdown(
    @Param(new ZodPipe(StoreMetric, "/params")) p: z.infer<typeof StoreMetric>,
    @Query(new ZodPipe(BreakdownQuery, "/query")) q: z.infer<typeof BreakdownQuery>,
  ) {
    // Every breakdown is shopper-gated: blocked is a plain 404, as for an unknown id.
    if (!(await this.opts.shopperSeriesEnabled())) throw unknownMetric();
    const dims = SELLER_BREAKDOWNS[p.metricId];
    if (dims === undefined || !dims.includes(q.dimension)) throw unknownMetric();
    return this.gatedGrid(q);
  }

  @Get("summary")
  @READ
  @RL
  async summary(
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: ApiResponse,
    @Param(new ZodPipe(StoreOnly, "/params")) p: z.infer<typeof StoreOnly>,
    @Query(new ZodPipe(SummaryQuery, "/query")) q: z.infer<typeof SummaryQuery>,
  ) {
    if (!(await this.opts.seriesEnabled())) throw Problems.notFound();
    const storeId = p.storeId.toLowerCase();
    const compare: Compare = "previous_period";
    const nowMs = this.clock.nowMs();
    return this.guarded(async () => {
      const tiles = SUMMARY_TILES.map((id) => {
        const e = sellerMetric(id);
        if (e === undefined) throw new Error(`summary tile ${id} missing from the registry`);
        const request: SeriesRequest = { def: e.def, grain: "day", fromMs: q.from, toMs: q.to, compare, nowMs };
        return { id, request, plan: planSeries(request) };
      });
      const fresh = await this.reader.freshness(storeId);
      const first = tiles[0];
      if (first === undefined) throw new Error("no tiles");
      const etag = seriesEtag({ metricId: "seller.summary", buckets: first.plan.buckets, grain: "day", compare, scope: `store:${storeId}`, asOfMs: fresh.asOfMs, epoch: fresh.epoch });
      res.setHeader("Cache-Control", "private, max-age=60");
      res.setHeader("ETag", etag);
      if (headerValue(req, "if-none-match") === etag) {
        res.status(304);
        return undefined;
      }
      const src = { freshness: () => this.reader.freshness(storeId), read: (m: string, f: number, t: number) => this.reader.read(storeId, m, f, t) };
      const out = [];
      for (const t of tiles) out.push(await readSeries(src, t.request, t.plan, fresh.asOfMs));
      this.opts.countRead("seller.summary");
      return { tiles: out };
    });
  }
}
