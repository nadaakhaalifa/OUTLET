import { Controller, Get, Inject, Query, Req } from "@nestjs/common";
import { z } from "zod";
import { Authorize, RateLimit } from "../../../platform/decorators";
import type { ApiRequest } from "../../../platform/http-types";
import type { Clock } from "../../../platform/ports";
import { Problems } from "../../../platform/problem";
import { CLOCK } from "../../../platform/tokens";
import { ZodPipe } from "../../../platform/zod.pipe";
import { INCLUSION_K, type GetStoreInclusion } from "../application/inclusion";
import { GET_STORE_INCLUSION, STYLIST_SELLER_RESOLVER } from "./tokens";
import { storeIdsOf } from "./resolvers";

const DAY = 86_400_000;
const Query_ = z
  .object({ from: z.iso.datetime({ offset: true }).optional(), to: z.iso.datetime({ offset: true }).optional() })
  .strict();

/** Aggregate seller view of how often their items appear in AI outfits; suppressed below k distinct shoppers. */
@Controller("seller/stylist")
export class StylistInclusionController {
  constructor(
    @Inject(GET_STORE_INCLUSION) private readonly inclusion: GetStoreInclusion,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Get("inclusion")
  @Authorize({ audience: "seller_api", action: "read", resourceType: "store_order", resolver: STYLIST_SELLER_RESOLVER, idParam: "none" })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async get(@Req() req: ApiRequest, @Query(new ZodPipe(Query_, "/query")) q: z.infer<typeof Query_>) {
    const principal = req.principal;
    if (principal === null || principal === undefined) throw Problems.unauthenticated();
    const toMs = q.to === undefined ? this.clock.nowMs() : Date.parse(q.to);
    const fromMs = q.from === undefined ? toMs - 30 * DAY : Date.parse(q.from);
    if (fromMs >= toMs || toMs - fromMs > 366 * DAY) throw Problems.validation([{ pointer: "/query/from", code: "invalid_range" }]);
    const items = await this.inclusion.execute(storeIdsOf(principal.actor), fromMs, toMs);
    return {
      k_min: INCLUSION_K,
      from: new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
      items: items.map((i) => ({
        store_id: i.storeId,
        suppressed: i.suppressed,
        outfits: i.outfits,
        distinct_shoppers: i.distinctShoppers,
        added_to_bag_outfits: i.addedToBagOutfits,
      })),
    };
  }
}
