import { Body, Controller, Get, Inject, Put, Query, Req } from "@nestjs/common";
import { z } from "zod";
import { AuthenticatedSelf, Idempotent, RateLimit } from "../../../platform/decorators";
import type { ApiRequest } from "../../../platform/http-types";
import { ProblemError, Problems } from "../../../platform/problem";
import { ZodPipe } from "../../../platform/zod.pipe";
import type { ListCalendarEvents, SaveCalendarEvent } from "../application/calendar";
import { CALENDAR_KINDS, CALENDAR_STATUSES, type CalendarEvent, type CalendarPos } from "../domain/calendar";
import type { PromotionAuthorizer } from "./authorizer";
import { LIST_CALENDAR, PROMOTION_AUTHORIZER, SAVE_CALENDAR } from "./tokens";

const Cursor = z
  .string()
  .min(1)
  .max(200)
  .transform((s, ctx): CalendarPos => {
    try {
      const v = z.object({ ms: z.number().int().nonnegative(), id: z.uuid() }).strict().parse(JSON.parse(Buffer.from(s, "base64url").toString("utf8")));
      return { ms: v.ms, id: v.id.toLowerCase() };
    } catch {
      ctx.addIssue({ code: "custom", message: "invalid cursor" });
      return z.NEVER;
    }
  });
const Instant = z.iso.datetime({ offset: true }).transform((s) => Date.parse(s));
const ListQuery = z
  .object({ cursor: Cursor.optional(), limit: z.coerce.number().int().min(1).max(50).default(50), from: Instant.optional(), to: Instant.optional() })
  .strict();
const PutBody = z
  .object({
    id: z.uuid(),
    kind: z.enum(CALENDAR_KINDS),
    title_ar: z.string().min(1).max(300),
    title_en: z.string().max(300).nullable().default(null),
    note: z.string().max(2000).nullable().default(null),
    starts_at: Instant,
    ends_at: Instant,
    status: z.enum(CALENDAR_STATUSES).default("planned"),
    expected_version: z.number().int().min(1).optional(),
  })
  .strict();

const adminResource = { type: "admin_console", id: "calendar", state: "active" } as const;
const iso = (ms: number): string => new Date(ms).toISOString();
export const calendarWire = (e: CalendarEvent) => ({
  id: e.id, kind: e.kind, title_ar: e.titleAr, title_en: e.titleEn, note: e.note, starts_at: iso(e.startsAtMs), ends_at: iso(e.endsAtMs),
  status: e.status, version: e.version, updated_by: e.updatedBy, updated_at: iso(e.updatedAtMs),
});

@Controller("admin/calendar")
export class AdminCalendarController {
  constructor(
    @Inject(LIST_CALENDAR) private readonly list: ListCalendarEvents,
    @Inject(SAVE_CALENDAR) private readonly save: SaveCalendarEvent,
    @Inject(PROMOTION_AUTHORIZER) private readonly authz: PromotionAuthorizer,
  ) {}

  @Get()
  @AuthenticatedSelf("admin_api")
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async index(@Req() req: ApiRequest, @Query(new ZodPipe(ListQuery, "/query")) q: z.output<typeof ListQuery>) {
    await this.authz.authorize(req, { action: "read", resourceType: "admin_console", resource: adminResource });
    const r = await this.list.execute({ fromMs: q.from ?? null, toMs: q.to ?? null, after: q.cursor ?? null, limit: q.limit });
    return {
      items: r.rows.map(calendarWire),
      next_cursor: r.next === null ? null : Buffer.from(JSON.stringify({ ms: r.next.ms, id: r.next.id })).toString("base64url"),
    };
  }

  @Put()
  @AuthenticatedSelf("admin_api")
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async put(@Req() req: ApiRequest, @Body(new ZodPipe(PutBody)) b: z.output<typeof PutBody>) {
    await this.authz.authorize(req, { action: "update", resourceType: "admin_console", resource: adminResource });
    const actorId = req.principal?.actor.id;
    if (actorId === undefined) throw Problems.unauthenticated();
    const r = await this.save.execute({
      actorId, id: b.id.toLowerCase(), kind: b.kind, titleAr: b.title_ar, titleEn: b.title_en, note: b.note,
      startsAtMs: b.starts_at, endsAtMs: b.ends_at, status: b.status, expectedVersion: b.expected_version ?? null,
    });
    switch (r.kind) {
      case "ok":
        return { event: calendarWire(r.event), created: r.created };
      case "invalid_range":
        throw Problems.validation([{ pointer: "/body/ends_at", code: "must_be_after_starts_at" }]);
      case "conflict":
        throw new ProblemError(409, "conflict", "The event changed or the expected version is wrong, reload and retry", { code: "conflict" });
    }
  }
}
