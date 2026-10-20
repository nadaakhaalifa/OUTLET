import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query, Req } from "@nestjs/common";
import { z } from "zod";
import { Authorize, AuthenticatedSelf, Idempotent, Public, RateLimit } from "../../../platform/decorators";
import type { ApiRequest } from "../../../platform/http-types";
import { ProblemError, Problems } from "../../../platform/problem";
import { ZodPipe } from "../../../platform/zod.pipe";
import { DROP_TYPES, type DropItem, type FieldError } from "../domain/bridge";
import type { Clock } from "../domain/ports";
import {
  type AdminControlDrop,
  type CreateDrop,
  type EditDrop,
  type GetDrop,
  type GetPublicDropView,
  type JoinWaitlist,
  type ListPublicDrops,
  type ListSellerDrops,
  type RemoveDrop,
  type ScheduleDrop,
} from "../application/drops";
import {
  ADMIN_CONTROL_DROP,
  ADMIN_DROPS_OPS,
  CREATE_DROP,
  DROP_ADMIN_RESOLVER,
  DROP_RESOLVER,
  DROP_STORE_LIST_RESOLVER,
  EDIT_DROP,
  GET_PUBLIC_DROP,
  GET_SELLER_DROP,
  JOIN_WAITLIST,
  LIST_PUBLIC_DROPS,
  LIST_SELLER_DROPS,
  REMOVE_DROP,
  SCHEDULE_DROP,
} from "./tokens";
import { storeIdsOf } from "./resolvers";
import { publicDropDetailWire, publicDropWire, sellerDropWire } from "./wire";
import type { AdminDropsOps } from "../application/ops";
import { CLOCK } from "../../../platform/tokens";

const Id = z.uuid();
const Cursor = z.string().min(1).max(120);
const Limit = z.coerce.number().int().min(1).max(50).default(20);
const ListQuery = z.object({ cursor: Cursor.optional(), limit: Limit }).strict();
const IdParams = z.object({ id: Id }).strict();

const Money = z.union([z.string().regex(/^\d{1,15}$/), z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)]).transform((v) => BigInt(v));
const Iso = z.iso.datetime({ offset: true }).transform((s) => Date.parse(s));

const ItemBody = z.object({ sku_id: Id, stock_cap: z.number().int().min(1).max(100_000), price: Money }).strict();
const LimitsBody = z.object({ per_user: z.number().int().min(1).max(10), per_device: z.number().int().min(1).max(10) }).strict();
const LadderBody = z.object({ at: Iso, price: Money }).strict();
const MysteryBody = z.object({ min_value: Money, max_value: Money, guaranteed_min: Money }).strict();

const CreateBody = z
  .object({
    store_id: Id.optional(),
    type: z.enum(DROP_TYPES),
    title: z.string().min(2).max(120),
    starts_at: Iso,
    early_access_at: Iso.nullish(),
    ends_at: Iso,
    items: z.array(ItemBody).min(1).max(50),
    limits: LimitsBody.default({ per_user: 1, per_device: 1 }),
    ladder: z.array(LadderBody).max(12).default([]),
    mystery: MysteryBody.nullish(),
    admit_per_sec: z.number().int().min(1).max(5000).optional(),
  })
  .strict();

const EditBody = z
  .object({
    title: z.string().min(2).max(120).optional(),
    starts_at: Iso.optional(),
    early_access_at: Iso.nullish(),
    ends_at: Iso.optional(),
    items: z.array(ItemBody).min(1).max(50).optional(),
    limits: LimitsBody.optional(),
    admit_per_sec: z.number().int().min(1).max(5000).optional(),
    version: z.number().int().min(1).optional(),
  })
  .strict();

const AdminBody = z.object({ action: z.enum(["pause", "resume", "end"]) }).strict();
const ADMIN_ROLES = ["trust_safety", "ops", "super_admin"] as const;

const principalOf = (req: ApiRequest) => {
  const p = req.principal;
  if (p === null || p === undefined) throw Problems.unauthenticated();
  return p;
};
const fieldProblem = (errors: readonly FieldError[]): ProblemError =>
  Problems.validation(errors.map((e) => ({ pointer: `/body/${e.field}`, code: e.code })));
const invalidCursor = (): ProblemError =>
  new ProblemError(400, "validation-failed", "Request validation failed", {
    code: "invalid_cursor",
    errors: [{ pointer: "/query/cursor", code: "invalid_cursor" }],
  });
const conflict = (code: string, title: string): ProblemError => new ProblemError(409, code.replaceAll("_", "-"), title, { code });

@Controller()
export class DropsController {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CREATE_DROP) private readonly create: CreateDrop,
    @Inject(EDIT_DROP) private readonly edit: EditDrop,
    @Inject(SCHEDULE_DROP) private readonly schedule: ScheduleDrop,
    @Inject(REMOVE_DROP) private readonly remove: RemoveDrop,
    @Inject(GET_SELLER_DROP) private readonly getDrop: GetDrop,
    @Inject(LIST_SELLER_DROPS) private readonly sellerList: ListSellerDrops,
    @Inject(LIST_PUBLIC_DROPS) private readonly publicList: ListPublicDrops,
    @Inject(GET_PUBLIC_DROP) private readonly publicGet: GetPublicDropView,
    @Inject(ADMIN_CONTROL_DROP) private readonly control: AdminControlDrop,
    @Inject(JOIN_WAITLIST) private readonly waitlist: JoinWaitlist,
    @Inject(ADMIN_DROPS_OPS) private readonly opsUc: AdminDropsOps,
  ) {}

  // ---- public ----

  @Get("drops")
  @Public()
  @RateLimit([{ dimension: "ip", limit: 60, windowSeconds: 60 }])
  async list(@Query(new ZodPipe(ListQuery, "/query")) q: z.infer<typeof ListQuery>) {
    const r = await this.publicList.execute(q.cursor ?? null, q.limit);
    if (r.kind === "invalid_cursor") throw invalidCursor();
    const now = this.clock.nowMs();
    return {
      items: r.items.map((d) => publicDropWire(d, now)),
      page: { next_cursor: r.nextCursor, has_more: r.nextCursor !== null },
    };
  }

  @Get("drops/:id")
  @Public()
  @RateLimit([{ dimension: "ip", limit: 60, windowSeconds: 60 }])
  async detail(@Param(new ZodPipe(IdParams, "/params")) p: { id: string }) {
    const v = await this.publicGet.execute(p.id.toLowerCase());
    if (v === null) throw Problems.notFound();
    return publicDropDetailWire(v.drop, v.social, v.waitlistSize, this.clock.nowMs());
  }

  @Post("drops/:id/waitlist")
  @HttpCode(200)
  @AuthenticatedSelf()
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 5, windowSeconds: 60 }])
  async joinWaitlist(@Req() req: ApiRequest, @Param(new ZodPipe(IdParams, "/params")) p: { id: string }) {
    const r = await this.waitlist.execute({ dropId: p.id.toLowerCase(), userId: principalOf(req).actor.id });
    switch (r.kind) {
      case "joined":
      case "already":
        return { waitlisted: true };
      case "not_found":
        throw Problems.notFound();
      case "not_sold_out":
        throw conflict("not_sold_out", "The waitlist opens when the drop is sold out");
      case "closed":
        throw conflict("drop_closed", "This drop has ended");
    }
  }

  // ---- seller ----

  @Get("seller/drops")
  @Authorize({ audience: "seller_api", action: "read", resourceType: "store_product", resolver: DROP_STORE_LIST_RESOLVER, idParam: "none" })
  @RateLimit([{ dimension: "user", limit: 30, windowSeconds: 60 }])
  async sellerListDrops(@Req() req: ApiRequest, @Query(new ZodPipe(ListQuery, "/query")) q: z.infer<typeof ListQuery>) {
    const r = await this.sellerList.execute(storeIdsOf(principalOf(req).actor), q.cursor ?? null, q.limit);
    if (r.kind === "invalid_cursor") throw invalidCursor();
    const now = this.clock.nowMs();
    return { items: r.items.map((d) => sellerDropWire(d, now)), page: { next_cursor: r.nextCursor, has_more: r.nextCursor !== null } };
  }

  @Post("seller/drops")
  @HttpCode(201)
  @Authorize({ audience: "seller_api", action: "create", resourceType: "store_product", resolver: DROP_STORE_LIST_RESOLVER, idParam: "none" })
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 30, windowSeconds: 60 }])
  async sellerCreate(@Req() req: ApiRequest, @Body(new ZodPipe(CreateBody)) b: z.infer<typeof CreateBody>) {
    const stores = storeIdsOf(principalOf(req).actor);
    const storeId = (b.store_id ?? stores[0] ?? "").toLowerCase();
    // A store the actor does not belong to is indistinguishable from one that does not exist.
    if (!stores.includes(storeId)) throw Problems.notFound();
    const items: DropItem[] = b.items.map((i) => ({ skuId: i.sku_id.toLowerCase(), stockCap: i.stock_cap, pricePiastres: i.price }));
    const r = await this.create.execute({
      storeId,
      draft: {
        type: b.type,
        title: b.title.trim(),
        startsAtMs: b.starts_at,
        earlyAccessAtMs: b.early_access_at ?? null,
        endsAtMs: b.ends_at,
        items,
        limits: { perUser: b.limits.per_user, perDevice: b.limits.per_device },
        ladder: b.ladder.map((s) => ({ atMs: s.at, pricePiastres: s.price })),
        mystery:
          b.mystery === null || b.mystery === undefined
            ? null
            : { minValuePiastres: b.mystery.min_value, maxValuePiastres: b.mystery.max_value, guaranteedMinPiastres: b.mystery.guaranteed_min },
        admitPerSec: b.admit_per_sec ?? null,
      },
    });
    switch (r.kind) {
      case "created":
        return sellerDropWire(r.drop, this.clock.nowMs());
      case "invalid":
        throw fieldProblem(r.errors);
      case "type_disabled":
        throw Problems.unavailable("drop_type_disabled");
    }
  }

  @Get("seller/drops/:id")
  @Authorize({ audience: "seller_api", action: "read", resourceType: "store_product", resolver: DROP_RESOLVER, idParam: "id" })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async sellerGet(@Param(new ZodPipe(IdParams, "/params")) p: { id: string }) {
    const d = await this.getDrop.execute(p.id.toLowerCase(), { publicOnly: false });
    if (d === null) throw Problems.notFound();
    return sellerDropWire(d, this.clock.nowMs());
  }

  @Patch("seller/drops/:id")
  @Authorize({ audience: "seller_api", action: "update", resourceType: "store_product", resolver: DROP_RESOLVER, idParam: "id" })
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 30, windowSeconds: 60 }])
  async sellerEdit(
    @Param(new ZodPipe(IdParams, "/params")) p: { id: string },
    @Body(new ZodPipe(EditBody)) b: z.infer<typeof EditBody>,
  ) {
    const r = await this.edit.execute({
      dropId: p.id.toLowerCase(),
      ...(b.title !== undefined ? { title: b.title.trim() } : {}),
      ...(b.starts_at !== undefined ? { startsAtMs: b.starts_at } : {}),
      ...(b.ends_at !== undefined ? { endsAtMs: b.ends_at } : {}),
      ...(b.early_access_at !== undefined ? { earlyAccessAtMs: b.early_access_at } : {}),
      ...(b.items !== undefined
        ? { items: b.items.map((i) => ({ skuId: i.sku_id.toLowerCase(), stockCap: i.stock_cap, pricePiastres: i.price })) }
        : {}),
      ...(b.limits !== undefined ? { limits: { perUser: b.limits.per_user, perDevice: b.limits.per_device } } : {}),
      ...(b.admit_per_sec !== undefined ? { admitPerSec: b.admit_per_sec } : {}),
    });
    switch (r.kind) {
      case "ok":
        return sellerDropWire(r.drop, this.clock.nowMs());
      case "not_found":
        throw Problems.notFound();
      case "invalid":
        throw fieldProblem(r.errors);
      case "locked":
        // Spec: after SCHEDULED the seller cannot change price or lower stock (only increase it).
        throw new ProblemError(409, "drop-locked", "This drop can no longer be changed that way", { code: `drop_locked_${r.code}` });
      case "conflict":
        throw conflict("conflict", "The drop changed, reload and retry");
    }
  }

  @Post("seller/drops/:id/schedule")
  @HttpCode(200)
  @Authorize({ audience: "seller_api", action: "update", resourceType: "store_product", resolver: DROP_RESOLVER, idParam: "id" })
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 30, windowSeconds: 60 }])
  async sellerSchedule(@Param(new ZodPipe(IdParams, "/params")) p: { id: string }) {
    const r = await this.schedule.execute(p.id.toLowerCase());
    switch (r.kind) {
      case "ok":
        return sellerDropWire(r.drop, this.clock.nowMs());
      case "not_found":
        throw Problems.notFound();
      case "invalid_transition":
        throw conflict("invalid_transition", "This drop cannot be scheduled from its current state");
      case "too_late":
        throw conflict("start_in_past", "The drop would already be open; pick a later start");
      case "conflict":
        throw conflict("conflict", "The drop changed, reload and retry");
    }
  }

  @Delete("seller/drops/:id")
  @HttpCode(204)
  @Authorize({ audience: "seller_api", action: "delete", resourceType: "store_product", resolver: DROP_RESOLVER, idParam: "id" })
  @Idempotent({ required: false })
  @RateLimit([{ dimension: "user", limit: 30, windowSeconds: 60 }])
  async sellerRemove(@Param(new ZodPipe(IdParams, "/params")) p: { id: string }): Promise<void> {
    const r = await this.remove.execute(p.id.toLowerCase());
    switch (r.kind) {
      case "ok":
        return;
      case "not_found":
        throw Problems.notFound();
      case "invalid_transition":
        throw conflict("invalid_transition", "A running drop can only be stopped by trust and safety");
      case "too_late":
      case "conflict":
        throw conflict("conflict", "The drop changed, reload and retry");
    }
  }

  // ---- admin ----

  @Get("admin/drops/ops")
  @Authorize({ audience: "admin_api", action: "read", resourceType: "admin_console", resolver: DROP_ADMIN_RESOLVER, idParam: "none" })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async adminOps(@Req() req: ApiRequest, @Query(new ZodPipe(ListQuery, "/query")) q: z.infer<typeof ListQuery>) {
    const actor = principalOf(req).actor;
    if (!actor.grants.some((g) => g.kind === "admin" && (ADMIN_ROLES as readonly string[]).includes(g.role))) throw Problems.forbidden();
    const r = await this.opsUc.execute(q.cursor ?? null, q.limit);
    if (r.kind === "invalid_cursor") throw invalidCursor();
    return {
      items: r.items.map((o) => ({
        drop_id: o.dropId,
        store_id: o.storeId,
        state: o.state,
        paused: o.paused,
        configured_admit_per_sec: o.configuredAdmitPerSec,
        queue_depth: o.queueDepth,
        admitted_last_minute: o.admittedLastMinute,
        admitted_per_sec: o.admittedPerSec,
        bot_block_rate_bps: o.botBlockRateBps,
        waitlist_size: o.waitlistSize,
        admission_health: o.admissionHealth,
      })),
      page: { next_cursor: r.nextCursor, has_more: r.nextCursor !== null },
    };
  }

  @Post("admin/drops/:id/pause")
  @HttpCode(200)
  @Authorize({ audience: "admin_api", action: "read", resourceType: "admin_console", resolver: DROP_ADMIN_RESOLVER, idParam: "none" })
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 30, windowSeconds: 60 }])
  async adminControl(
    @Req() req: ApiRequest,
    @Param(new ZodPipe(IdParams, "/params")) p: { id: string },
    @Body(new ZodPipe(AdminBody)) b: z.infer<typeof AdminBody>,
  ) {
    const actor = principalOf(req).actor;
    const ok = actor.grants.some((g) => g.kind === "admin" && (ADMIN_ROLES as readonly string[]).includes(g.role));
    if (!ok) throw Problems.forbidden();
    const r = await this.control.execute(p.id.toLowerCase(), b.action);
    switch (r.kind) {
      case "ok":
        return { id: r.drop.id, state: r.drop.state, paused: r.drop.paused };
      case "not_found":
        throw Problems.notFound();
      case "invalid_transition":
        throw conflict("invalid_transition", "This drop cannot be changed in its current state");
      case "conflict":
        throw conflict("conflict", "The drop changed, reload and retry");
    }
  }
}
