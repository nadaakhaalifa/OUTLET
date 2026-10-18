import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query, Req } from "@nestjs/common";
import { z } from "zod";
import { Authorize, AuthenticatedSelf, Idempotent, RateLimit } from "../../../platform/decorators";
import type { ApiRequest } from "../../../platform/http-types";
import { ProblemError, Problems } from "../../../platform/problem";
import { ZodPipe } from "../../../platform/zod.pipe";
import type { AddGapToBag } from "../application/bag";
import type { ClearCalendar, CreateEvent, DeleteEvent, ListEvents, UpdateEvent } from "../application/events";
import type { GenerateEventOutfits } from "../application/outfits";
import type { CalendarStore } from "../domain/ports";
import { EVENT_KINDS, MAX_NOTE_LENGTH, MODESTY } from "../domain/bridge";
import { viewOf } from "../application/shared";
import { isDateKey } from "../domain/bridge";
import {
  ADD_GAP_TO_BAG,
  CALENDAR_EVENT_RESOLVER,
  CALENDAR_STORE,
  CLEAR_CALENDAR,
  CREATE_CALENDAR_EVENT,
  DELETE_CALENDAR_EVENT,
  GENERATE_EVENT_OUTFITS,
  LIST_CALENDAR_EVENTS,
  UPDATE_CALENDAR_EVENT,
} from "./tokens";
import { eventWire, generateWire, deliveryWire, priceChangeWire, unavailableWire } from "./wire";
import { CLOCK } from "../../../platform/tokens";

const Uuid = z.uuid();
const DateKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isDateKey);
const LocalTime = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
  .transform((s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5)));
const Piastres = z.string().regex(/^\d{1,12}$/);
const SLOTS = ["top", "bottom", "dress", "shoes", "bag", "accessory"] as const;
const SEASONS = ["summer", "winter", "spring", "autumn", "all"] as const;
const Note = z.string().trim().min(1).max(MAX_NOTE_LENGTH);

/** An event imported from the device calendar carries a date and a type, nothing else (spec P3-02). */
const DeviceBody = z.object({ source: z.literal("device"), kind: z.enum(EVENT_KINDS), local_date: DateKey }).strict();
const FullBody = z
  .object({
    source: z.enum(["manual", "wishlist"]).default("manual"),
    kind: z.enum(EVENT_KINDS),
    local_date: DateKey,
    local_time: LocalTime.optional(),
    note: Note.optional(),
    modesty: z.enum(MODESTY).default("standard"),
    season_band: z.enum(SEASONS).default("all"),
    budget_piastres: Piastres.optional(),
    owned_slots: z.array(z.enum(SLOTS)).max(6).default([]),
    reminders_enabled: z.boolean().default(false),
  })
  .strict();
const CreateBody = z.union([DeviceBody, FullBody]);

const PatchBody = z
  .object({
    kind: z.enum(EVENT_KINDS).optional(),
    local_date: DateKey.optional(),
    local_time: LocalTime.optional(),
    note: Note.nullable().optional(),
    modesty: z.enum(MODESTY).optional(),
    season_band: z.enum(SEASONS).optional(),
    budget_piastres: Piastres.nullable().optional(),
    owned_slots: z.array(z.enum(SLOTS)).max(6).optional(),
    reminders_enabled: z.boolean().optional(),
  })
  .strict();

const ListQueryZ = z
  .object({
    include_archived: z.enum(["true", "false"]).default("false"),
    limit: z.coerce.number().int().min(1).max(50).default(50),
    cursor: z.string().max(80).optional(),
  })
  .strict();

const GenerateBody = z.object({ use_remaining_budget: z.boolean().default(false) }).strict();
const AddGapBody = z.object({ outfit_id: Uuid }).strict();

const principalOf = (req: ApiRequest) => {
  const p = req.principal;
  if (p === null || p === undefined) throw Problems.unauthenticated();
  return p;
};
const idemKey = (req: ApiRequest): string => {
  const k = req.headers["idempotency-key"];
  return Array.isArray(k) ? (k[0] ?? "") : (k ?? "");
};

@Controller("me/calendar")
export class CalendarController {
  constructor(
    @Inject(CREATE_CALENDAR_EVENT) private readonly create: CreateEvent,
    @Inject(UPDATE_CALENDAR_EVENT) private readonly update: UpdateEvent,
    @Inject(DELETE_CALENDAR_EVENT) private readonly remove: DeleteEvent,
    @Inject(CLEAR_CALENDAR) private readonly clear: ClearCalendar,
    @Inject(LIST_CALENDAR_EVENTS) private readonly list: ListEvents,
    @Inject(GENERATE_EVENT_OUTFITS) private readonly generate: GenerateEventOutfits,
    @Inject(ADD_GAP_TO_BAG) private readonly addGap: AddGapToBag,
    @Inject(CALENDAR_STORE) private readonly store: CalendarStore,
    @Inject(CLOCK) private readonly clock: { nowMs(): number },
  ) {}

  @Get("events")
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async events(@Req() req: ApiRequest, @Query(new ZodPipe(ListQueryZ, "/query")) q: z.infer<typeof ListQueryZ>) {
    const r = await this.list.execute({
      userId: principalOf(req).actor.id,
      includeArchived: q.include_archived === "true",
      limit: q.limit,
      cursor: q.cursor ?? null,
    });
    if (r.kind === "bad_cursor") {
      throw Problems.validation([{ pointer: "/query/cursor", code: "invalid_cursor" }]);
    }
    return { items: r.items.map(eventWire), next_cursor: r.nextCursor };
  }

  @Post("events")
  @HttpCode(201)
  @AuthenticatedSelf()
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async createEvent(@Req() req: ApiRequest, @Body(new ZodPipe(CreateBody)) b: z.infer<typeof CreateBody>) {
    const full = b.source === "device" ? null : b;
    const r = await this.create.execute({
      userId: principalOf(req).actor.id,
      kind: b.kind,
      localDate: b.local_date,
      localMinute: full?.local_time ?? null,
      note: full?.note ?? null,
      modesty: full?.modesty ?? "standard",
      seasonBand: full?.season_band ?? "all",
      budgetPiastres: full?.budget_piastres === undefined ? null : BigInt(full.budget_piastres),
      ownedSlots: full?.owned_slots ?? [],
      source: b.source,
      remindersEnabled: full?.reminders_enabled ?? false,
    });
    switch (r.kind) {
      case "created":
        return eventWire(r.view);
      case "invalid_date":
        throw new ProblemError(422, "invalid-date", "That date does not exist", { code: "invalid_date" });
      case "event_in_past":
        throw new ProblemError(422, "event-in-past", "The event must be in the future", { code: "event_in_past" });
      case "owned_slots_invalid":
        throw new ProblemError(422, "owned-slots-invalid", "A dress cannot be combined with a top or a bottom", { code: "owned_slots_invalid" });
      case "limit_reached":
        throw new ProblemError(409, "calendar-limit-reached", "You have reached the maximum number of upcoming events", {
          code: "calendar_limit_reached",
          extensions: { limit: r.limit },
        });
    }
  }

  @Get("events/:eventId")
  @Authorize({ action: "read", resourceType: "wishlist", resolver: CALENDAR_EVENT_RESOLVER, idParam: "eventId" })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async getEvent(@Req() req: ApiRequest, @Param("eventId") eventId: string) {
    const e = await this.store.getEvent(eventId.toLowerCase());
    if (e === null || e.userId !== principalOf(req).actor.id) throw Problems.notFound();
    const links = (await this.store.linksFor([e.id])).get(e.id) ?? [];
    return eventWire(viewOf(e, links, this.clock.nowMs()));
  }

  @Patch("events/:eventId")
  @Authorize({ action: "update", resourceType: "wishlist", resolver: CALENDAR_EVENT_RESOLVER, idParam: "eventId" })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async patch(@Req() req: ApiRequest, @Param("eventId") eventId: string, @Body(new ZodPipe(PatchBody)) b: z.infer<typeof PatchBody>) {
    const r = await this.update.execute({
      userId: principalOf(req).actor.id,
      eventId: eventId.toLowerCase(),
      ...(b.kind === undefined ? {} : { kind: b.kind }),
      ...(b.local_date === undefined ? {} : { localDate: b.local_date }),
      ...(b.local_time === undefined ? {} : { localMinute: b.local_time }),
      ...(b.note === undefined ? {} : { note: b.note }),
      ...(b.modesty === undefined ? {} : { modesty: b.modesty }),
      ...(b.season_band === undefined ? {} : { seasonBand: b.season_band }),
      ...(b.budget_piastres === undefined ? {} : { budgetPiastres: b.budget_piastres === null ? null : BigInt(b.budget_piastres) }),
      ...(b.owned_slots === undefined ? {} : { ownedSlots: b.owned_slots }),
      ...(b.reminders_enabled === undefined ? {} : { remindersEnabled: b.reminders_enabled }),
    });
    switch (r.kind) {
      case "updated":
        return eventWire(r.view);
      case "not_found":
        throw Problems.notFound();
      case "event_archived":
        throw new ProblemError(409, "event-archived", "Past events cannot be changed", { code: "event_archived" });
      case "invalid_date":
        throw new ProblemError(422, "invalid-date", "That date does not exist", { code: "invalid_date" });
      case "event_in_past":
        throw new ProblemError(422, "event-in-past", "The event must be in the future", { code: "event_in_past" });
      case "owned_slots_invalid":
        throw new ProblemError(422, "owned-slots-invalid", "A dress cannot be combined with a top or a bottom", { code: "owned_slots_invalid" });
    }
  }

  @Delete("events/:eventId")
  @HttpCode(204)
  @Authorize({ action: "delete", resourceType: "wishlist", resolver: CALENDAR_EVENT_RESOLVER, idParam: "eventId" })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async del(@Req() req: ApiRequest, @Param("eventId") eventId: string): Promise<void> {
    const r = await this.remove.execute({ userId: principalOf(req).actor.id, eventId: eventId.toLowerCase() });
    if (r === "not_found") throw Problems.notFound();
  }

  /** Explicit "clear calendar". History clear never removes events (spec P3-02 edge cases). */
  @Delete("events")
  @HttpCode(204)
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 10, windowSeconds: 60 }])
  async clearAll(@Req() req: ApiRequest): Promise<void> {
    await this.clear.execute({ userId: principalOf(req).actor.id });
  }

  @Post("events/:eventId/outfits")
  @HttpCode(200)
  @Authorize({ action: "update", resourceType: "wishlist", resolver: CALENDAR_EVENT_RESOLVER, idParam: "eventId" })
  @RateLimit([{ dimension: "user", limit: 10, windowSeconds: 60 }])
  async outfits(@Req() req: ApiRequest, @Param("eventId") eventId: string, @Body(new ZodPipe(GenerateBody)) b: z.infer<typeof GenerateBody>) {
    const r = await this.generate.execute({
      userId: principalOf(req).actor.id,
      eventId: eventId.toLowerCase(),
      useRemainingBudget: b.use_remaining_budget,
    });
    switch (r.kind) {
      case "ok":
        return generateWire(r.view);
      case "not_found":
        throw Problems.notFound();
      case "event_past":
        throw new ProblemError(409, "event-archived", "Past events cannot be planned", { code: "event_archived" });
      case "disabled":
        throw Problems.unavailable("calendar_gap_fill_disabled");
      case "quota_exceeded":
        throw Problems.rateLimited(r.retryAfterMs / 1000);
      case "catalog_unavailable":
        throw Problems.unavailable("catalog_unavailable");
    }
  }

  @Post("events/:eventId/add-gap-to-bag")
  @HttpCode(200)
  @Authorize({ action: "update", resourceType: "wishlist", resolver: CALENDAR_EVENT_RESOLVER, idParam: "eventId" })
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 20, windowSeconds: 60 }])
  async addToBag(@Req() req: ApiRequest, @Param("eventId") eventId: string, @Body(new ZodPipe(AddGapBody)) b: z.infer<typeof AddGapBody>) {
    const r = await this.addGap.execute({
      userId: principalOf(req).actor.id,
      eventId: eventId.toLowerCase(),
      outfitId: b.outfit_id.toLowerCase(),
      idempotencyKey: idemKey(req),
    });
    switch (r.kind) {
      case "not_found":
        throw Problems.notFound();
      case "already_added":
        return { added: false, already_added: true, item_ids: [], unavailable: [], price_changes: [] };
      case "nothing_available":
        throw new ProblemError(409, "nothing-available", "None of the items are available any more", { code: "nothing_available" });
      case "budget_exceeded":
        throw new ProblemError(409, "budget-exceeded", "Current prices put this outfit over your budget", {
          code: "budget_exceeded",
          extensions: { total_piastres: r.totalPiastres.toString(), budget_piastres: r.budgetPiastres.toString() },
        });
      case "added":
        return {
          added: true,
          already_added: false,
          item_ids: r.itemIds,
          total_piastres: r.totalPiastres.toString(),
          unavailable: r.unavailable.map(unavailableWire),
          price_changes: r.priceChanges.map(priceChangeWire),
          delivery: deliveryWire(r.feasibility),
        };
    }
  }
}
