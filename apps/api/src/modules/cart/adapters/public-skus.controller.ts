import { Controller, Get, Inject, Query, Req, Res } from "@nestjs/common";
import { z } from "zod";
import { Public, RateLimit } from "../../../platform/decorators";
import type { ApiRequest, ApiResponse } from "../../../platform/http-types";
import { Problems } from "../../../platform/problem";
import {
  assertGuestBrowsingEnabled,
  assertPublicReadEnabled,
  PUBLIC_CACHE,
  respondPublic,
  type PublicReadGate,
} from "../../../platform/public-read";
import { GUEST_BROWSING_GATE, PUBLIC_READ_GATE } from "../../../platform/tokens";
import { ZodPipe } from "../../../platform/zod.pipe";
import { CatalogUnavailableError, type CatalogPort } from "../domain/ports";
import { CART_CATALOG } from "./tokens";
import { moneyWire } from "./wire";

/** Nil UUID: owns no favourites, so no per-user value can be read through the shared catalog port. */
const PUBLIC_VIEWER = "00000000-0000-4000-8000-000000000000";
export const PUBLIC_SKU_BATCH_MAX = 50;

const Ids = z
  .string()
  .max(PUBLIC_SKU_BATCH_MAX * 37)
  .transform((s) => s.split(",").map((x) => x.trim().toLowerCase()))
  .pipe(z.array(z.uuid()).min(1).max(PUBLIC_SKU_BATCH_MAX));
const Query_ = z.object({ ids: Ids }).strict();

/**
 * Guest bag refresh (ADR-0055 G-2, spec guest-browsing 9). Anonymous, cacheable, the same for every caller:
 * the live price, availability and store state of up to 50 SKUs, read from the same catalog port the bag prices
 * from. Allow-listed fields only. No verified-claim fields are served here (the product read carries them), so a
 * guest bag line can never show a "% off" that this route did not verify.
 */
@Controller("public")
export class PublicSkusController {
  constructor(
    @Inject(GUEST_BROWSING_GATE) private readonly guest: PublicReadGate,
    @Inject(PUBLIC_READ_GATE) private readonly gate: PublicReadGate,
    @Inject(CART_CATALOG) private readonly catalog: CatalogPort,
  ) {}

  @Get("skus")
  @Public()
  // Device bucket first (attested installs); the IP bucket is the shared backstop and is sized for carrier NAT (G-7).
  @RateLimit([
    { dimension: "device", limit: 60, windowSeconds: 60 },
    { dimension: "ip", limit: 240, windowSeconds: 60 },
  ])
  async batch(
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: ApiResponse,
    @Query(new ZodPipe(Query_, "/query")) q: z.infer<typeof Query_>,
  ) {
    await assertGuestBrowsingEnabled(this.guest);
    await assertPublicReadEnabled(this.gate);
    const ids = [...new Set(q.ids)];
    let skus;
    let stores;
    try {
      skus = await this.catalog.skus(ids);
      stores = await this.catalog.stores([...new Set([...skus.values()].map((s) => s.storeId))], PUBLIC_VIEWER);
    } catch (e) {
      if (e instanceof CatalogUnavailableError) throw Problems.unavailable("catalog_unavailable");
      throw e;
    }
    const items = ids.flatMap((id) => {
      const s = skus.get(id);
      const store = s === undefined ? undefined : stores.get(s.storeId);
      if (s === undefined || store === undefined) return [];
      const left = s.unitsLeft;
      return [
        {
          id: s.skuId,
          product_id: s.productId,
          store: { id: s.storeId, open: store.open },
          price: moneyWire(s.unitPrice),
          available: s.available && store.open,
          units_left: left !== undefined && left !== null && left >= 1 && left <= 5 ? left : null,
        },
      ];
    });
    const found = new Set(items.map((i) => i.id));
    // Unknown and hidden ids are indistinguishable by design.
    return respondPublic(req, res, { items, not_found_ids: ids.filter((id) => !found.has(id)) }, PUBLIC_CACHE.product);
  }
}
