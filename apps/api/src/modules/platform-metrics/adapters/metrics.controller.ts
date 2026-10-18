import { Controller, Get, Inject, Param, Query, Req, Res } from "@nestjs/common";
import { z } from "zod";
import { AuthenticatedSelf, RateLimit } from "../../../platform/decorators";
import { headerValue, type ApiRequest, type ApiResponse } from "../../../platform/http-types";
import type { AuditSink, Clock } from "../../../platform/ports";
import { ProblemError, Problems } from "../../../platform/problem";
import { AUDIT_SINK, CLOCK } from "../../../platform/tokens";
import { ZodPipe } from "../../../platform/zod.pipe";
import { adminGateDenial, computeAccess, ROUTE_ROLES } from "../../admin";
import { planSeries, readSeries, seriesEtag } from "../application/read-series";
import { InvalidWindowError, GRAINS } from "../domain/buckets";
import { MetricsDependencyUnavailableError, MetricSourceUnconfiguredError, type PlatformRollupReader } from "../domain/ports";
import { adminMetric } from "../domain/registry";
import { PLATFORM_METRICS_OPTIONS, PLATFORM_ROLLUP_READER } from "./tokens";

type Elevations = Parameters<typeof computeAccess>[1];

/** Live admin elevations of a user (the admin store implements this; composition passes it in). */
export interface ElevationReader {
  liveElevations(userId: string, nowMs: number): Promise<Elevations>;
}

export interface PlatformMetricsOptions {
  /** `release.admin.metrics`: default false, the route answers 404 before anything is read or audited. */
  readonly enabled: () => Promise<boolean> | boolean;
  readonly elevations: ElevationReader;
  /** Counts allowed reads (`outlet.admin.metrics.reads{metric}`). */
  readonly countRead: (metricId: string) => void;
}

const MetricParam = z.object({ metricId: z.string().max(80) }).strict();
const Ms = z.iso.datetime({ offset: true }).transform((s) => Date.parse(s));
const Query_ = z
  .object({
    from: Ms,
    to: Ms,
    grain: z.enum(GRAINS),
    compare: z.enum(["previous_period", "none"]).default("previous_period"),
  })
  .strict();

/** Admin platform time series. Passkey required; counts need ops or finance, money needs finance (ADR-0049 item 3, Proposed). */
@Controller("admin/metrics")
export class PlatformMetricsController {
  constructor(
    @Inject(PLATFORM_ROLLUP_READER) private readonly reader: PlatformRollupReader,
    @Inject(PLATFORM_METRICS_OPTIONS) private readonly opts: PlatformMetricsOptions,
    @Inject(AUDIT_SINK) private readonly audit: AuditSink,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Get(":metricId")
  @AuthenticatedSelf("admin_api")
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async series(
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: ApiResponse,
    @Param(new ZodPipe(MetricParam, "/params")) p: z.infer<typeof MetricParam>,
    @Query(new ZodPipe(Query_, "/query")) q: z.infer<typeof Query_>,
  ) {
    if (!(await this.opts.enabled())) throw Problems.notFound();
    const actor = req.principal?.actor;
    if (actor === undefined) throw Problems.unauthenticated();
    const nowMs = this.clock.nowMs();
    const entry = adminMetric(p.metricId);
    // Unknown ids are gated like money ids so an ops caller cannot tell the two apart.
    const roles = entry?.access === "counts" ? ROUTE_ROLES.metricsCounts : ROUTE_ROLES.metricsMoney;
    // A caller with no standing admin grant is denied from the token alone: the elevation store is not consulted.
    let live: Elevations = [];
    if (computeAccess(actor, [], nowMs).standing.length > 0) {
      try {
        live = await this.opts.elevations.liveElevations(actor.id, nowMs);
      } catch {
        throw Problems.unavailable("elevations_unavailable");
      }
    }
    const reason = adminGateDenial(computeAccess(actor, live, nowMs), roles);
    try {
      if (reason !== null) {
        await this.audit.record({
          effect: "deny",
          actorId: actor.id,
          action: "read",
          resourceType: "admin_console",
          resourceId: null,
          ruleId: "admin.metrics.read",
          reason,
          httpStatus: 403,
          approverIds: [],
          atMs: nowMs,
        });
      }
    } catch {
      // the deny stands whether or not the audit write succeeded
    }
    if (reason !== null) throw Problems.forbidden(reason);
    if (entry === undefined) throw new ProblemError(404, "unknown-metric", "Unknown metric", { code: "unknown_metric" });
    if (entry.needsFacts) throw Problems.unavailable("metric_source_unconfigured");
    const request = { def: entry.def, grain: q.grain, fromMs: q.from, toMs: q.to, compare: q.compare, nowMs };
    let plan;
    try {
      plan = planSeries(request);
    } catch (e) {
      if (e instanceof InvalidWindowError) throw Problems.validation([{ pointer: "/query/from", code: e.code }]);
      throw e;
    }
    try {
      const fresh = await this.reader.freshness();
      const etag = seriesEtag({
        metricId: entry.def.id,
        buckets: plan.buckets,
        grain: q.grain,
        compare: q.compare,
        scope: "platform",
        asOfMs: fresh.asOfMs,
        epoch: fresh.epoch,
      });
      res.setHeader("Cache-Control", "private, no-cache");
      res.setHeader("ETag", etag);
      const inm = headerValue(req, "if-none-match");
      if (inm !== undefined && inm === etag) {
        res.status(304);
        return undefined;
      }
      const body = await readSeries(this.reader, request, plan, fresh.asOfMs);
      this.opts.countRead(entry.def.id);
      return body;
    } catch (e) {
      if (e instanceof MetricSourceUnconfiguredError) throw Problems.unavailable("metric_source_unconfigured");
      if (e instanceof MetricsDependencyUnavailableError) throw Problems.unavailable("platform_metrics_unavailable");
      throw e;
    }
  }
}
