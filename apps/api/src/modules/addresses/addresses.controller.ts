import { Controller, Delete, Get, HttpCode, Inject, Patch, Post } from "@nestjs/common";
import { z } from "zod";
import { Authorize, Contract, Paginated, Public, RateLimit } from "../../platform/decorators.js";
import { API_DEPS } from "../../platform/deps.js";
import type { ApiDeps } from "../../platform/deps.js";
import type { RequestState } from "../../platform/http.js";
import { Problems } from "../../platform/problem.js";
import { RATE_BUDGETS } from "../../platform/rate-limit/budgets.js";
import { self } from "../../platform/resolvers.js";
import { Body, Ctx, Params, Query } from "../../platform/validation.js";
import { Address, AddressIdParams, AddressInput, AddressPage, AddressesQuery, GeoAreaPage, GeoAreasQuery } from "./dto.js";
import type { AddressesServices } from "./services.js";
import { toPackageInput, toWire } from "./wire.js";

const one = (a: readonly Address[]): Address => {
  const first = a[0];
  if (first === undefined) throw Problems.internal("address-missing");
  return first;
};

interface Own { readonly userId: string; readonly svc: AddressesServices }

/** The shopper's address book (user tenant, policy address.read / address.write). Another user's address is 404 (RLS), never 403. */
@Controller("v1/:market/me")
export class AddressesController {
  constructor(@Inject(API_DEPS) private readonly deps: ApiDeps) {}

  private own(s: RequestState): Own {
    if (s.user === undefined) throw Problems.unauthenticated();
    if (s.marketId === undefined) throw Problems.notFound("unknown-market");
    return { userId: s.user.userId, svc: this.deps.addresses(s.marketId) };
  }

  @Get("addresses")
  @Paginated()
  @Authorize("address.read", self)
  @RateLimit({ budget: RATE_BUDGETS.shopperRead })
  @Contract({ operationId: "listMyAddresses", summary: "List my addresses (default first)", tags: ["Me"], query: AddressesQuery, response: AddressPage, maxQueries: 4 })
  async list(@Ctx() s: RequestState, @Query() q: AddressesQuery): Promise<AddressPage> {
    const o = this.own(s);
    const all = await o.svc.addresses.list(o.userId);
    const from = q.cursor === undefined ? 0 : all.findIndex((a) => a.id === Buffer.from(q.cursor ?? "", "base64url").toString("utf8")) + 1;
    const slice = all.slice(from, from + q.limit);
    const last = slice[slice.length - 1];
    const more = from + q.limit < all.length && last !== undefined;
    return { items: await toWire(o.svc.geo, o.userId, slice), next_cursor: more ? Buffer.from(last.id, "utf8").toString("base64url") : null };
  }

  @Post("addresses")
  @HttpCode(201)
  @Authorize("address.write", self)
  @RateLimit({ budget: RATE_BUDGETS.shopperWrite })
  @Contract({ operationId: "createMyAddress", summary: "Add an address (validated against the geo tree; the first one becomes the default)", tags: ["Me"], body: AddressInput, response: Address, status: 201, maxQueries: 12 })
  async create(@Ctx() s: RequestState, @Body() b: z.infer<typeof AddressInput>): Promise<Address> {
    const o = this.own(s);
    const view = await o.svc.addresses.create(o.userId, await toPackageInput(o.svc.geo, b));
    return one(await toWire(o.svc.geo, o.userId, [view]));
  }

  @Patch("addresses/:address_id")
  @Authorize("address.write", self)
  @RateLimit({ budget: RATE_BUDGETS.shopperWrite })
  @Contract({ operationId: "updateMyAddress", summary: "Replace one of my addresses", tags: ["Me"], params: AddressIdParams, body: AddressInput, response: Address, maxQueries: 12 })
  async update(@Ctx() s: RequestState, @Params() p: AddressIdParams, @Body() b: z.infer<typeof AddressInput>): Promise<Address> {
    const o = this.own(s);
    const view = await o.svc.addresses.update(o.userId, p.address_id, await toPackageInput(o.svc.geo, b));
    return one(await toWire(o.svc.geo, o.userId, [view]));
  }

  @Delete("addresses/:address_id")
  @HttpCode(204)
  @Authorize("address.write", self)
  @RateLimit({ budget: RATE_BUDGETS.shopperWrite })
  @Contract({ operationId: "deleteMyAddress", summary: "Delete one of my addresses (soft delete; frozen order snapshots are untouched)", tags: ["Me"], params: AddressIdParams, response: z.undefined(), status: 204, maxQueries: 3 })
  async remove(@Ctx() s: RequestState, @Params() p: AddressIdParams): Promise<void> {
    const o = this.own(s);
    await o.svc.addresses.remove(o.userId, p.address_id);
  }
}

/** Public geo tree for address forms (configuration, no personal data); cacheable for 60 s. */
@Controller("v1/:market")
export class GeoAreasController {
  constructor(@Inject(API_DEPS) private readonly deps: ApiDeps) {}

  @Get("geo-areas")
  @Paginated()
  @Public()
  @RateLimit({ budget: RATE_BUDGETS.publicRead })
  @Contract({
    operationId: "listGeoAreas",
    summary: "Governorates, cities and districts for address forms",
    tags: ["Markets"],
    query: GeoAreasQuery,
    response: GeoAreaPage,
    cacheControl: "public, max-age=60, stale-while-revalidate=120",
    maxQueries: 1,
  })
  async list(@Ctx() s: RequestState, @Query() q: z.infer<typeof GeoAreasQuery>): Promise<GeoAreaPage> {
    if (s.marketId === undefined) throw Problems.notFound("unknown-market");
    const page = await this.deps.addresses(s.marketId).geo.list({ limit: q.limit, ...(q.parent_id === undefined ? {} : { parentId: q.parent_id }), ...(q.level === undefined ? {} : { level: q.level }), ...(q.cursor === undefined ? {} : { cursor: q.cursor }) });
    return {
      items: page.items.map((a) => ({ id: a.id, parent_id: a.parentId, level: a.level as "city", code: a.code, name_ar: a.nameAr, name_en: a.nameEn, shipping_zone_code: a.shippingZoneCode, active: true })),
      next_cursor: page.nextCursor,
    };
  }
}
