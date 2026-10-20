import { Controller, Get, Inject, Param, Query, Req, Res } from "@nestjs/common";
import { z } from "zod";
import { Public, RateLimit } from "../../../platform/decorators";
import type { ApiRequest, ApiResponse } from "../../../platform/http-types";
import { ProblemError, Problems } from "../../../platform/problem";
import { assertPublicReadEnabled, PUBLIC_CACHE, respondPublic, type PublicReadGate } from "../../../platform/public-read";
import { PUBLIC_READ_GATE } from "../../../platform/tokens";
import { ZodPipe } from "../../../platform/zod.pipe";
import {
  SITEMAP_MAX_PAGE,
  type GetPublicStore,
  type ListPublicStoreSitemap,
  type ListPublicStores,
} from "../application/public";
import { SORTS } from "../domain/store";
import { GET_PUBLIC_STORE, LIST_PUBLIC_STORE_SITEMAP, LIST_PUBLIC_STORES } from "./tokens";
import { toPublicStore, toPublicSummary } from "./public-wire";
import { decodeCursor, encodeCursor, StoreIdParamSchema } from "./wire";

const PUBLIC_WORLDS = ["local", "global", "everything"] as const;

const PublicListQuery = z
  .object({
    world: z.enum(PUBLIC_WORLDS).optional(),
    sort: z.enum(SORTS).optional(),
    cursor: z.string().max(512).optional(),
    limit: z
      .string()
      .regex(/^[0-9]{1,3}$/)
      .transform(Number)
      .pipe(z.number().int().min(1).max(50))
      .optional(),
  })
  .strict();

const SitemapParams = z
  .object({
    page: z
      .string()
      .regex(/^[0-9]{1,4}$/)
      .transform(Number)
      .pipe(z.number().int().min(1).max(SITEMAP_MAX_PAGE)),
  })
  .strict();

/** Rate limits are sized for a server-to-server caller (the Next server is one IP); bots are the WAF's job. */
@Controller("public")
export class PublicStoresController {
  constructor(
    @Inject(PUBLIC_READ_GATE) private readonly gate: PublicReadGate,
    @Inject(LIST_PUBLIC_STORES) private readonly list: ListPublicStores,
    @Inject(GET_PUBLIC_STORE) private readonly getStore: GetPublicStore,
    @Inject(LIST_PUBLIC_STORE_SITEMAP) private readonly sitemap: ListPublicStoreSitemap,
  ) {}

  @Get("stores")
  @Public()
  @RateLimit([{ dimension: "ip", limit: 300, windowSeconds: 60 }])
  async index(
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: ApiResponse,
    @Query(new ZodPipe(PublicListQuery, "/query")) q: z.infer<typeof PublicListQuery>,
  ) {
    await assertPublicReadEnabled(this.gate);
    const world = q.world ?? "everything";
    const sort = q.sort ?? "trending";
    let after = null;
    if (q.cursor !== undefined) {
      after = decodeCursor(q.cursor, world, sort);
      if (after === null) throw new ProblemError(400, "invalid-cursor", "The cursor is not valid for this query", { code: "invalid_cursor" });
    }
    const out = await this.list.execute({ world, sort, after, limit: q.limit ?? 24 });
    return respondPublic(
      req,
      res,
      {
        items: out.items.map(toPublicSummary),
        page: {
          next_cursor: out.hasMore && out.last !== null ? encodeCursor(world, sort, out.last) : null,
          has_more: out.hasMore,
        },
      },
      PUBLIC_CACHE.store,
    );
  }

  @Get("stores/:storeId")
  @Public()
  @RateLimit([{ dimension: "ip", limit: 300, windowSeconds: 60 }])
  async detail(
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: ApiResponse,
    @Param(new ZodPipe(StoreIdParamSchema, "/params")) p: z.infer<typeof StoreIdParamSchema>,
  ) {
    await assertPublicReadEnabled(this.gate);
    const view = await this.getStore.execute(p.storeId.toLowerCase());
    if (view === null) throw Problems.notFound();
    return respondPublic(req, res, toPublicStore(view), PUBLIC_CACHE.store);
  }

  @Get("sitemap/stores/:page")
  @Public()
  @RateLimit([{ dimension: "ip", limit: 60, windowSeconds: 60 }])
  async sitemapPage(
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: ApiResponse,
    @Param(new ZodPipe(SitemapParams, "/params")) p: z.infer<typeof SitemapParams>,
  ) {
    await assertPublicReadEnabled(this.gate);
    const out = await this.sitemap.execute(p.page);
    return respondPublic(
      req,
      res,
      {
        items: out.items.map((i) => ({ id: i.id, slug: i.slug })),
        page: { number: p.page, next_page: out.hasMore ? p.page + 1 : null },
      },
      PUBLIC_CACHE.sitemap,
    );
  }
}
