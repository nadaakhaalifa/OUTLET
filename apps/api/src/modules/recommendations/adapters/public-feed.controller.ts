import { Controller, Get, Inject, Query, Req, Res } from "@nestjs/common";
import { z } from "zod";
import { Public, RateLimit } from "../../../platform/decorators";
import type { ApiRequest, ApiResponse } from "../../../platform/http-types";
import { assertGuestBrowsingEnabled, assertPublicReadEnabled, PUBLIC_CACHE, respondPublic, type PublicReadGate } from "../../../platform/public-read";
import { GUEST_BROWSING_GATE, PUBLIC_READ_GATE } from "../../../platform/tokens";
import { ZodPipe } from "../../../platform/zod.pipe";
import type { BuildFeed } from "../application/recommendations";
import { itemWire } from "./recommendations.controller";
import { BUILD_FEED } from "./tokens";

/** Nil UUID: no history, no settings, no consent row exists for it. */
const PUBLIC_VIEWER = "00000000-0000-4000-8000-000000000000";

/** `personalized`, `affordable` and any other key are rejected (400): the public feed has no per-user input at all. */
const FeedQuery = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) }).strict();

/**
 * Guest Home feed (ADR-0055 G-3): popularity and freshness only, identical for every caller, so a CDN can cache it.
 * `personalized=false` is hard-coded here, before any user data could be read (the use case short-circuits on it),
 * and the request writes nothing (no impression counters). Pagination by cursor is not offered by the feed use
 * case (it ranks one bounded pool), so `limit` is the only paging input.
 */
@Controller("public")
export class PublicFeedController {
  constructor(
    @Inject(GUEST_BROWSING_GATE) private readonly guest: PublicReadGate,
    @Inject(PUBLIC_READ_GATE) private readonly gate: PublicReadGate,
    @Inject(BUILD_FEED) private readonly feed: BuildFeed,
  ) {}

  @Get("feed")
  @Public()
  @RateLimit([
    { dimension: "device", limit: 60, windowSeconds: 60 },
    { dimension: "ip", limit: 240, windowSeconds: 60 },
  ])
  async index(
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: ApiResponse,
    @Query(new ZodPipe(FeedQuery, "/query")) q: z.infer<typeof FeedQuery>,
  ) {
    await assertGuestBrowsingEnabled(this.guest);
    await assertPublicReadEnabled(this.gate);
    const r = await this.feed.execute({
      userId: PUBLIC_VIEWER,
      personalizedParam: false,
      affordable: false,
      limit: q.limit,
      anonymous: true,
    });
    return respondPublic(
      req,
      res,
      {
        items: r.items.map(itemWire),
        personalized: false as const,
        model_version: r.modelVersion,
        degraded: r.degraded,
        page: { next_cursor: null, has_more: false },
      },
      PUBLIC_CACHE.feed,
    );
  }
}
