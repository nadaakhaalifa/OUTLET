import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from "@nestjs/common";
import { z } from "zod";
import { GRADE_LABELS } from "../domain/bridge";
import { Authorize, AuthenticatedSelf, Idempotent, RateLimit } from "../../../platform/decorators";
import type { ApiRequest } from "../../../platform/http-types";
import { ProblemError, Problems } from "../../../platform/problem";
import { ZodPipe } from "../../../platform/zod.pipe";
import type { BrowseResale, ListReturnedUnit, ListingView, WithdrawListing } from "../application/resale";
import type { ListingRecord, ResaleStore } from "../domain/ports";
import { hubIdsOf } from "./resolvers";
import { BROWSE_RESALE, LIST_RETURNED_UNIT, RESALE_ADMIN_RESOLVER, RESALE_OPERATOR_RESOLVER, RESALE_STORE, RESALE_STORE_RESOLVER, WITHDRAW_LISTING } from "./tokens";

const Id = z.uuid();
const ListBody = z
  .object({
    return_id: Id,
    grade: z.enum(["A", "B", "C"]),
    photo_ids: z.array(z.string().min(1).max(80)).min(1).max(10),
    defect_note: z.string().max(500).nullable().default(null),
    price_piastres: z.string().regex(/^[1-9]\d{0,11}$/),
  })
  .strict();
const ADMIN_ROLES = ["ops", "finance", "trust_safety", "super_admin"] as const;
const AdminListQuery = z
  .object({ limit: z.coerce.number().int().min(1).max(50).default(50), cursor: z.string().max(200).optional(), status: z.enum(["LISTED", "SOLD", "WITHDRAWN"]).optional() })
  .strict();
const adminWire = (l: ListingRecord) => ({
  id: l.id,
  store_id: l.storeId,
  sku_id: l.resaleSkuId,
  grade: l.grade,
  price: { amount_minor: l.price.toString(), currency: "EGP" },
  ownership: l.ownership,
  status: l.status,
  listed_at: new Date(l.listedAtMs).toISOString(),
  sold_at: l.soldAtMs === null ? null : new Date(l.soldAtMs).toISOString(),
});
const IdParam = z.object({ id: Id }).strict();
const StoreParam = z.object({ storeId: Id }).strict();
const StoreListingParam = StoreParam.extend({ id: Id }).strict();
const BrowseQuery = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20), cursor: z.string().max(200).optional() }).strict();
const Cursor = z.object({ t: z.number().int(), id: Id }).strict();

/** Shopper wire: no reference price and no percentage, ever (CPL 181/2018, spec 9.3). */
const viewWire = (v: ListingView) => ({
  id: v.id,
  sku_id: v.resaleSkuId,
  condition: "open_box_returned",
  grade: v.grade,
  grade_label: GRADE_LABELS[v.grade],
  price_piastres: v.price.toString(),
  currency: "EGP",
  price_label: v.priceLabel,
  photo_count: v.photoCount,
  defect_note: v.defectNote,
  listed_at: new Date(v.listedAtMs).toISOString(),
});
const sellerWire = (l: ListingRecord) => ({
  id: l.id,
  sku_id: l.resaleSkuId,
  grade: l.grade,
  price_piastres: l.price.toString(),
  ownership: l.ownership,
  status: l.status,
  listed_at: new Date(l.listedAtMs).toISOString(),
  sold_at: l.soldAtMs === null ? null : new Date(l.soldAtMs).toISOString(),
});

const principalOf = (req: ApiRequest) => {
  const p = req.principal;
  if (p === null || p === undefined) throw Problems.unauthenticated();
  return p;
};

@Controller()
export class ResaleController {
  constructor(
    @Inject(LIST_RETURNED_UNIT) private readonly list: ListReturnedUnit,
    @Inject(WITHDRAW_LISTING) private readonly withdraw: WithdrawListing,
    @Inject(BROWSE_RESALE) private readonly browse: BrowseResale,
    @Inject(RESALE_STORE) private readonly store: ResaleStore,
  ) {}

  @Post("hub/resale/listings")
  @Authorize({ audience: "admin_api", action: "update", resourceType: "courier_task", resolver: RESALE_OPERATOR_RESOLVER, idParam: "none" })
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async create(@Req() req: ApiRequest, @Body(new ZodPipe(ListBody)) b: z.infer<typeof ListBody>) {
    const actor = principalOf(req).actor;
    const r = await this.list.execute({
      returnId: b.return_id.toLowerCase(),
      operatorId: actor.id,
      operatorHubIds: hubIdsOf(actor),
      grade: b.grade,
      photoIds: b.photo_ids,
      defectNote: b.defect_note,
      price: BigInt(b.price_piastres),
    });
    switch (r.kind) {
      case "listed":
        return sellerWire(r.listing);
      case "not_found":
        throw Problems.notFound();
      case "disabled":
        throw Problems.unavailable("resale_disabled");
      case "already_listed":
        throw new ProblemError(409, "already-listed", "This unit already went through resale", { code: "already_listed" });
      case "refused":
        throw new ProblemError(422, "resale-refused", "This unit cannot be relisted", { code: r.reason });
      case "invalid":
        throw Problems.validation(r.issues.map((code) => ({ pointer: "/body", code })));
    }
  }

  @Get("resale/listings")
  @AuthenticatedSelf("buyer_api")
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async live(@Query(new ZodPipe(BrowseQuery, "/query")) q: z.infer<typeof BrowseQuery>) {
    let after: { listedAtMs: number; id: string } | null = null;
    if (q.cursor !== undefined) {
      try {
        const c = Cursor.parse(JSON.parse(Buffer.from(q.cursor, "base64url").toString("utf8")));
        after = { listedAtMs: c.t, id: c.id.toLowerCase() };
      } catch {
        throw Problems.validation([{ pointer: "/query/cursor", code: "invalid_cursor" }]);
      }
    }
    const items = await this.browse.live(q.limit, after);
    const last = items[items.length - 1];
    const next = items.length === q.limit && last !== undefined ? Buffer.from(JSON.stringify({ t: last.listedAtMs, id: last.id })).toString("base64url") : null;
    return { items: items.map(viewWire), next_cursor: next };
  }

  @Get("resale/listings/:id")
  @AuthenticatedSelf("buyer_api")
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async one(@Param(new ZodPipe(IdParam, "/params")) p: z.infer<typeof IdParam>) {
    const v = await this.browse.one(p.id.toLowerCase());
    if (v === null) throw Problems.notFound();
    return viewWire(v);
  }

  @Get("seller/stores/:storeId/resale/listings")
  @Authorize({ audience: "seller_api", action: "read", resourceType: "store_product", resolver: RESALE_STORE_RESOLVER, idParam: "storeId" })
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async forStore(@Param(new ZodPipe(StoreParam, "/params")) p: z.infer<typeof StoreParam>) {
    return { items: (await this.store.listForStore(p.storeId.toLowerCase(), 100)).map(sellerWire) };
  }

  @Post("seller/stores/:storeId/resale/listings/:id/withdraw")
  @HttpCode(200)
  @Authorize({ audience: "seller_api", action: "update", resourceType: "store_product", resolver: RESALE_STORE_RESOLVER, idParam: "storeId" })
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async withdrawListing(@Param(new ZodPipe(StoreListingParam, "/params")) p: z.infer<typeof StoreListingParam>) {
    const r = await this.withdraw.execute(p.storeId.toLowerCase(), p.id.toLowerCase());
    if (r.kind === "not_found") throw Problems.notFound();
    if (r.kind === "not_listed") throw new ProblemError(409, "invalid-transition", "The listing is no longer for sale", { code: "invalid_transition" });
    return { id: p.id.toLowerCase(), status: "WITHDRAWN" };
  }

  @Get("admin/resale/listings")
  @Authorize({ audience: "admin_api", action: "read", resourceType: "admin_console", resolver: RESALE_ADMIN_RESOLVER, idParam: "none" })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async adminListings(@Req() req: ApiRequest, @Query(new ZodPipe(AdminListQuery, "/query")) q: z.infer<typeof AdminListQuery>) {
    const ok = principalOf(req).actor.grants.some((g) => g.kind === "admin" && (ADMIN_ROLES as readonly string[]).includes(g.role));
    if (!ok) throw Problems.forbidden();
    let after: { listedAtMs: number; id: string } | null = null;
    if (q.cursor !== undefined) {
      try {
        const c = Cursor.parse(JSON.parse(Buffer.from(q.cursor, "base64url").toString("utf8")));
        after = { listedAtMs: c.t, id: c.id.toLowerCase() };
      } catch {
        throw Problems.validation([{ pointer: "/query/cursor", code: "invalid_cursor" }]);
      }
    }
    const rows = await this.store.listAll(q.limit + 1, after, q.status ?? null);
    const items = rows.slice(0, q.limit);
    const last = items[items.length - 1];
    const next = rows.length > q.limit && last !== undefined ? Buffer.from(JSON.stringify({ t: last.listedAtMs, id: last.id })).toString("base64url") : null;
    return { items: items.map(adminWire), page: { next_cursor: next, has_more: next !== null } };
  }
}
