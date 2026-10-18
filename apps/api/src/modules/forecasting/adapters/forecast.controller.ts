import { Controller, Get, Inject, Param, Query } from "@nestjs/common";
import { z } from "zod";
import { Authorize, RateLimit } from "../../../platform/decorators";
import { Problems } from "../../../platform/problem";
import { ZodPipe } from "../../../platform/zod.pipe";
import type { SellerForecastQueries } from "../application/forecasting";
import { SCOPES, ForecastingDisabledError } from "../domain/ports";
import type { HorizonDays } from "../domain/bridge";
import { FORECAST_QUERIES, FORECAST_STORE_RESOLVER } from "./tokens";
import { forecastsWire } from "./wire";

const StoreParam = z.object({ storeId: z.uuid() }).strict();
const ListQuery = z
  .object({
    scope: z.enum(SCOPES).optional(),
    scope_key: z.string().min(1).max(100).optional(),
    horizon_days: z.enum(["7", "14", "28"]).optional(),
    limit: z
      .string()
      .regex(/^\d{1,3}$/)
      .transform(Number)
      .pipe(z.number().int().min(1).max(200))
      .optional(),
  })
  .strict();

@Controller("seller/stores/:storeId/forecasts")
export class SellerForecastController {
  constructor(@Inject(FORECAST_QUERIES) private readonly q: SellerForecastQueries) {}

  /** Read-only. Expected units with a p10-p50-p90 interval per scope, never a bare point estimate. */
  @Get()
  @Authorize({
    audience: "seller_api",
    action: "read",
    resourceType: "store_inventory",
    resolver: FORECAST_STORE_RESOLVER,
    idParam: "storeId",
  })
  @RateLimit([{ dimension: "user", limit: 30, windowSeconds: 60 }])
  async list(
    @Param(new ZodPipe(StoreParam, "/params")) p: z.infer<typeof StoreParam>,
    @Query(new ZodPipe(ListQuery, "/query")) qs: z.infer<typeof ListQuery>,
  ) {
    try {
      const view = await this.q.list(p.storeId.toLowerCase(), {
        ...(qs.scope === undefined ? {} : { scope: qs.scope }),
        ...(qs.scope_key === undefined ? {} : { scopeKey: qs.scope_key }),
        ...(qs.horizon_days === undefined ? {} : { horizonDays: Number(qs.horizon_days) as HorizonDays }),
        ...(qs.limit === undefined ? {} : { limit: qs.limit }),
      });
      return forecastsWire(view);
    } catch (e) {
      if (e instanceof ForecastingDisabledError) throw Problems.unavailable("demand_forecasting_disabled");
      throw e;
    }
  }
}
