import { Controller, Get, Inject, Param, Req, Res } from "@nestjs/common";
import { UuidSchema } from "@outlet/validation";
import { z } from "zod";
import { Public, RateLimit } from "../../../platform/decorators";
import type { ApiRequest, ApiResponse } from "../../../platform/http-types";
import { Problems } from "../../../platform/problem";
import { assertPublicReadEnabled, gone, PUBLIC_CACHE, respondPublic, type PublicReadGate } from "../../../platform/public-read";
import { PUBLIC_READ_GATE } from "../../../platform/tokens";
import { ZodPipe } from "../../../platform/zod.pipe";
import type { ListSellerCategories } from "../application/products";
import { PRODUCT_SITEMAP_MAX_PAGE, type GetAnonymousProduct, type ListProductSitemap } from "../application/public";
import { GET_ANONYMOUS_PRODUCT, LIST_PRODUCT_SITEMAP, LIST_SELLER_CATEGORIES } from "./tokens";
import { publicCategoriesWire, publicProductWire } from "./public-wire";

const ProductIdPipe = new ZodPipe(UuidSchema, "/params");
const SitemapParams = z
  .object({
    page: z
      .string()
      .regex(/^[0-9]{1,4}$/)
      .transform(Number)
      .pipe(z.number().int().min(1).max(PRODUCT_SITEMAP_MAX_PAGE)),
  })
  .strict();

/**
 * Anonymous catalog reads for the shopper web (spec P3-06). `@Public()` is declared per route; nothing
 * here reads the principal, a cookie or a header other than If-None-Match. Rate limits are sized for a
 * server-to-server caller; bot control belongs to the edge.
 */
@Controller("public")
export class PublicCatalogController {
  constructor(
    @Inject(PUBLIC_READ_GATE) private readonly gate: PublicReadGate,
    @Inject(GET_ANONYMOUS_PRODUCT) private readonly getProduct: GetAnonymousProduct,
    @Inject(LIST_PRODUCT_SITEMAP) private readonly sitemap: ListProductSitemap,
    @Inject(LIST_SELLER_CATEGORIES) private readonly categories: ListSellerCategories,
  ) {}

  /** Active taxonomy only; the same read the seller route uses, projected through a narrower allow-list. */
  @Get("categories")
  @Public()
  @RateLimit([{ dimension: "ip", limit: 300, windowSeconds: 60 }])
  async categoryTree(@Req() req: ApiRequest, @Res({ passthrough: true }) res: ApiResponse) {
    await assertPublicReadEnabled(this.gate);
    const all = await this.categories.execute();
    return respondPublic(req, res, publicCategoriesWire(all), PUBLIC_CACHE.category);
  }

  @Get("products/:productId")
  @Public()
  @RateLimit([{ dimension: "ip", limit: 600, windowSeconds: 60 }])
  async product(
    @Param("productId", ProductIdPipe) productId: string,
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: ApiResponse,
  ) {
    await assertPublicReadEnabled(this.gate);
    const r = await this.getProduct.execute(productId.toLowerCase());
    if (r.kind === "not_found") throw Problems.notFound();
    if (r.kind === "gone") throw gone();
    return respondPublic(req, res, publicProductWire(r.product), PUBLIC_CACHE.product);
  }

  @Get("sitemap/products/:page")
  @Public()
  @RateLimit([{ dimension: "ip", limit: 60, windowSeconds: 60 }])
  async sitemapPage(
    @Param(new ZodPipe(SitemapParams, "/params")) params: z.infer<typeof SitemapParams>,
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: ApiResponse,
  ) {
    await assertPublicReadEnabled(this.gate);
    const page = params.page;
    const out = await this.sitemap.execute(page);
    return respondPublic(
      req,
      res,
      {
        items: out.items.map((i) => ({ id: i.id, lastmod: new Date(i.updatedAtMs).toISOString() })),
        page: { number: page, next_page: out.hasMore ? page + 1 : null },
      },
      PUBLIC_CACHE.sitemap,
    );
  }
}
