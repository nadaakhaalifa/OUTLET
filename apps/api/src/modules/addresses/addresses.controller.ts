import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query, Req, Res } from "@nestjs/common";
import { z } from "zod";
import { AuthenticatedSelf, Idempotent, RateLimit } from "../../platform/decorators";
import type { ApiRequest, ApiResponse } from "../../platform/http-types";
import { ProblemError, Problems } from "../../platform/problem";
import { ZodPipe } from "../../platform/zod.pipe";
import type { AddressView } from "./ports";
import type { AddressService, FieldError, WriteOutcome } from "./service";
import { ADDRESS_SERVICE } from "./tokens";

const ListQuery = z
  .object({ cursor: z.string().max(512).optional(), limit: z.coerce.number().int().min(1).max(50).default(20) })
  .strict();
const CitiesQuery = z.object({ governorate: z.string().regex(/^EG-[A-Z]{1,3}$/) }).strict();
const CursorBody = z.object({ c: z.number().int().nonnegative().max(8.64e15), i: z.string().min(1).max(64) }).strict();

const Text = (min: number, max: number) => z.string().trim().min(min).max(max);
const MapPin = z.object({ lat: z.number().finite(), lng: z.number().finite() }).strict();
const CreateBody = z
  .object({
    label: Text(1, 40).optional(),
    recipient_name: Text(2, 80),
    phone_e164: z.string().trim().min(8).max(24),
    governorate_code: z.string().regex(/^EG-[A-Z]{1,3}$/),
    city_district_code: z.string().regex(/^[a-z0-9-]{2,60}$/),
    street: Text(3, 200),
    building: Text(1, 40),
    floor: Text(1, 20).optional(),
    apartment: Text(1, 20).optional(),
    landmark: Text(3, 200).optional(),
    map_pin: MapPin.optional(),
  })
  .strict();
const PatchBody = z
  .object({
    label: Text(1, 40).nullable().optional(),
    recipient_name: Text(2, 80).optional(),
    phone_e164: z.string().trim().min(8).max(24).optional(),
    governorate_code: z.string().regex(/^EG-[A-Z]{1,3}$/).optional(),
    city_district_code: z.string().regex(/^[a-z0-9-]{2,60}$/).optional(),
    street: Text(3, 200).optional(),
    building: Text(1, 40).optional(),
    floor: Text(1, 20).nullable().optional(),
    apartment: Text(1, 20).nullable().optional(),
    landmark: Text(3, 200).nullable().optional(),
    map_pin: MapPin.nullable().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: "empty_patch" });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function decodeCursor(raw: string | undefined): { createdAtMs: number; id: string } | null {
  if (raw === undefined) return null;
  try {
    const p = CursorBody.parse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
    return { createdAtMs: p.c, id: p.i };
  } catch {
    throw Problems.validation([{ pointer: "/query/cursor", code: "invalid_cursor" }]);
  }
}
const encodeCursor = (c: { createdAtMs: number; id: string }): string =>
  Buffer.from(JSON.stringify({ c: c.createdAtMs, i: c.id })).toString("base64url");

const wire = (a: AddressView) => ({
  id: a.id,
  ...(a.label === undefined ? {} : { label: a.label }),
  recipient_name: a.recipientName,
  phone_e164: a.phoneE164,
  governorate_code: a.governorateCode,
  city_district_code: a.cityDistrictCode,
  street: a.street,
  building: a.building,
  ...(a.floor === undefined ? {} : { floor: a.floor }),
  ...(a.apartment === undefined ? {} : { apartment: a.apartment }),
  ...(a.landmark === undefined ? {} : { landmark: a.landmark }),
  ...(a.mapPin === undefined ? {} : { map_pin: { lat: a.mapPin.lat, lng: a.mapPin.lng } }),
  courier_coverage: a.courierCoverage,
  cod_eligible: a.codEligible,
  quality_score: a.qualityScore,
  is_default: a.isDefault,
  created_at: new Date(a.createdAtMs).toISOString(),
  updated_at: new Date(a.updatedAtMs).toISOString(),
});

const subject = (req: ApiRequest): string => {
  const id = req.principal?.actor.id;
  if (id === undefined) throw Problems.unauthenticated();
  return id;
};
const idOf = (raw: string): string => {
  if (!UUID.test(raw)) throw Problems.notFound();
  return raw.toLowerCase();
};
const noStore = (res: ApiResponse): void => {
  res.setHeader("Cache-Control", "no-store");
};
const violations = (errors: readonly FieldError[]) => errors.map((e) => ({ pointer: `/body/${e.field}`, code: e.code }));

function unwrap(r: WriteOutcome): AddressView {
  switch (r.kind) {
    case "ok":
      return r.address;
    case "invalid":
      throw Problems.validation(violations(r.errors));
    case "limit_reached":
      throw new ProblemError(409, "address-limit-reached", "Address limit reached", { code: "address_limit_reached", detail: "At most 10 addresses can be saved." });
    case "duplicate":
      throw new ProblemError(409, "address-duplicate", "Address already saved", { code: "address_duplicate" });
    case "not_found":
      throw Problems.notFound();
  }
}

/**
 * Owner-only by construction: the subject is the token's user and every lookup is keyed by it, so
 * another user's id answers 404, never 403. Responses are `no-store` (P3 data).
 */
@Controller()
export class AddressesController {
  constructor(@Inject(ADDRESS_SERVICE) private readonly svc: AddressService) {}

  @Get("me/addresses")
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async list(@Req() req: ApiRequest, @Res({ passthrough: true }) res: ApiResponse, @Query(new ZodPipe(ListQuery, "/query")) q: z.infer<typeof ListQuery>) {
    noStore(res);
    const rows = await this.svc.list(subject(req), decodeCursor(q.cursor), q.limit + 1);
    const items = rows.slice(0, q.limit);
    const last = items[items.length - 1];
    const hasMore = rows.length > q.limit;
    return {
      items: items.map(wire),
      page: { next_cursor: hasMore && last !== undefined ? encodeCursor({ createdAtMs: last.createdAtMs, id: last.id }) : null, has_more: hasMore },
    };
  }

  @Post("me/addresses")
  @HttpCode(201)
  @AuthenticatedSelf()
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 30, windowSeconds: 3600 }])
  async create(@Req() req: ApiRequest, @Res({ passthrough: true }) res: ApiResponse, @Body(new ZodPipe(CreateBody)) b: z.infer<typeof CreateBody>) {
    noStore(res);
    const r = await this.svc.create(subject(req), {
      label: b.label,
      recipientName: b.recipient_name,
      phone: b.phone_e164,
      governorateCode: b.governorate_code,
      cityDistrictCode: b.city_district_code,
      street: b.street,
      building: b.building,
      floor: b.floor,
      apartment: b.apartment,
      landmark: b.landmark,
      mapPin: b.map_pin,
    });
    return wire(unwrap(r));
  }

  @Get("me/addresses/:addressId")
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async get(@Req() req: ApiRequest, @Res({ passthrough: true }) res: ApiResponse, @Param("addressId") id: string) {
    noStore(res);
    const a = await this.svc.get(subject(req), idOf(id));
    if (a === null) throw Problems.notFound();
    return wire(a);
  }

  @Patch("me/addresses/:addressId")
  @AuthenticatedSelf()
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 3600 }])
  async patch(
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: ApiResponse,
    @Param("addressId") id: string,
    @Body(new ZodPipe(PatchBody)) b: z.infer<typeof PatchBody>,
  ) {
    noStore(res);
    const r = await this.svc.update(subject(req), idOf(id), {
      label: b.label,
      recipientName: b.recipient_name,
      phone: b.phone_e164,
      governorateCode: b.governorate_code,
      cityDistrictCode: b.city_district_code,
      street: b.street,
      building: b.building,
      floor: b.floor,
      apartment: b.apartment,
      landmark: b.landmark,
      mapPin: b.map_pin,
    });
    return wire(unwrap(r));
  }

  @Delete("me/addresses/:addressId")
  @HttpCode(204)
  @AuthenticatedSelf()
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 3600 }])
  async remove(@Req() req: ApiRequest, @Param("addressId") id: string): Promise<void> {
    if (!(await this.svc.remove(subject(req), idOf(id)))) throw Problems.notFound();
  }

  @Post("me/addresses/:addressId/default")
  @HttpCode(200)
  @AuthenticatedSelf()
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 3600 }])
  async makeDefault(@Req() req: ApiRequest, @Res({ passthrough: true }) res: ApiResponse, @Param("addressId") id: string) {
    noStore(res);
    const a = await this.svc.setDefault(subject(req), idOf(id));
    if (a === null) throw Problems.notFound();
    return wire(a);
  }

  /** Reference data only: works even when the KMS is not configured. */
  @Get("coverage/governorates")
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async governorates() {
    const rows = await this.svc.coverage.governorates();
    return { items: rows.map((g) => ({ code: g.code, name_ar: g.nameAr, name_en: g.nameEn, courier_coverage: g.covered ? "covered" : "not_covered" })) };
  }

  @Get("coverage/cities")
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async cities(@Query(new ZodPipe(CitiesQuery, "/query")) q: z.infer<typeof CitiesQuery>) {
    const rows = await this.svc.coverage.cities(q.governorate);
    if (rows === null) throw Problems.notFound();
    return {
      governorate_code: q.governorate,
      items: rows.map((c) => ({ code: c.code, name_ar: c.nameAr, name_en: c.nameEn, courier_coverage: c.covered ? "covered" : "not_covered" })),
    };
  }
}
