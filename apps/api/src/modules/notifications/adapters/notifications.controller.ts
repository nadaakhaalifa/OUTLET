import { Body, Controller, Get, HttpCode, Inject, Patch, Post, Put, Query, Req, Res } from "@nestjs/common";
import { sha256Hex } from "@outlet/idempotency";
import { UuidSchema } from "@outlet/validation";
import { z } from "zod";
import { AuthenticatedSelf, Idempotent, RateLimit } from "../../../platform/decorators";
import { headerValue, type ApiRequest, type ApiResponse } from "../../../platform/http-types";
import { ProblemError, Problems } from "../../../platform/problem";
import { ZodPipe } from "../../../platform/zod.pipe";
import type { ListInbox, MarkInboxRead, RegisterPushToken } from "../application/inbox";
import type { NotificationPreferences, PreferencePatch, PreferencesView, PreferenceRule } from "../application/preferences";
import type { InboxMessage } from "../domain/types";
import { LIST_INBOX, MARK_INBOX_READ, NOTIFICATION_PREFERENCES, REGISTER_PUSH_TOKEN } from "./tokens";

const TypeEntry = z
  .object({ type: z.string().regex(/^[A-Z_]{3,32}(\.[a-z_]{2,12})?$/), enabled: z.boolean() })
  .strict();

const PreferencesUpdateSchema = z
  .object({
    push_marketing: z.boolean().optional(),
    whatsapp_marketing: z.boolean().optional(),
    sms_marketing: z.boolean().optional(),
    email_marketing: z.boolean().optional(),
    types: z.array(TypeEntry).min(1).max(40).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "at least one property is required" });

const PushTokenSchema = z
  .object({
    install_id: UuidSchema,
    platform: z.enum(["ios", "android"]),
    push_token: z.string().min(8).max(512).regex(/^\S+$/),
  })
  .strict();

const InboxQuerySchema = z
  .object({
    cursor: z.string().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();

const MarkReadSchema = z.object({ ids: z.array(UuidSchema).min(1).max(100) }).strict();

const iso = (ms: number): string => new Date(ms).toISOString();

function preferencesWire(v: PreferencesView) {
  return {
    push_marketing: v.pushMarketing,
    whatsapp_marketing: v.whatsappMarketing,
    sms_marketing: v.smsMarketing,
    email_marketing: v.emailMarketing,
    types: v.types.map((t) => ({ type: t.type, enabled: t.enabled })),
    quiet_hours: { from: v.quietHours.from, to: v.quietHours.to, timezone: v.quietHours.timezone },
  };
}

function inboxWire(m: InboxMessage) {
  return {
    id: m.id,
    type: m.type,
    title: { ar: m.titleAr, ...(m.titleEn !== null ? { en: m.titleEn } : {}) },
    body: { ar: m.bodyAr, ...(m.bodyEn !== null ? { en: m.bodyEn } : {}) },
    ...(m.deepLink !== null ? { deep_link: m.deepLink } : {}),
    read_at: m.readAtMs === null ? null : iso(m.readAtMs),
    created_at: iso(m.createdAtMs),
  };
}

const etagOf = (wire: unknown): string => `"${sha256Hex(JSON.stringify(wire)).slice(0, 32)}"`;
function tagMatches(header: string, etag: string): boolean {
  return header.split(",").some((t) => {
    const tag = t.trim();
    return tag === "*" || tag === etag || tag === `W/${etag}`;
  });
}

const RULE_TITLES: Readonly<Record<PreferenceRule, string>> = {
  consent_required: "Marketing consent for this channel has not been granted; grant it in the Privacy Center first",
  channel_not_supported: "This channel is not available for marketing",
  type_not_switchable: "Transactional notifications cannot be switched off",
  unknown_type: "The notification type is not known",
};

function userIdOf(req: ApiRequest): string {
  const id = req.principal?.actor.id;
  if (id === undefined) throw Problems.unauthenticated();
  return id;
}

@Controller()
export class NotificationsController {
  constructor(
    @Inject(NOTIFICATION_PREFERENCES) private readonly prefs: NotificationPreferences,
    @Inject(LIST_INBOX) private readonly listInbox: ListInbox,
    @Inject(MARK_INBOX_READ) private readonly markRead: MarkInboxRead,
    @Inject(REGISTER_PUSH_TOKEN) private readonly registerToken: RegisterPushToken,
  ) {}

  @Get("me/notification-preferences")
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async getPreferences(@Req() req: ApiRequest, @Res({ passthrough: true }) res: ApiResponse) {
    const wire = preferencesWire(await this.prefs.get(userIdOf(req)));
    const etag = etagOf(wire);
    res.setHeader("ETag", etag);
    res.setHeader("Cache-Control", "private, no-cache");
    const inm = headerValue(req, "if-none-match");
    if (inm !== undefined && tagMatches(inm, etag)) throw new ProblemError(304, "not-modified", "Not modified");
    return wire;
  }

  @Patch("me/notification-preferences")
  @HttpCode(200)
  @AuthenticatedSelf()
  @Idempotent({ required: false })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async updatePreferences(
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: ApiResponse,
    @Body(new ZodPipe(PreferencesUpdateSchema)) b: z.infer<typeof PreferencesUpdateSchema>,
  ) {
    const ifMatch = headerValue(req, "if-match");
    if (ifMatch === undefined || ifMatch.trim() === "") {
      throw new ProblemError(428, "precondition-required", "If-Match is required for this update", {
        code: "precondition_required",
      });
    }
    const patch: PreferencePatch = {
      ...(b.push_marketing !== undefined ? { pushMarketing: b.push_marketing } : {}),
      ...(b.whatsapp_marketing !== undefined ? { whatsappMarketing: b.whatsapp_marketing } : {}),
      ...(b.sms_marketing !== undefined ? { smsMarketing: b.sms_marketing } : {}),
      ...(b.email_marketing !== undefined ? { emailMarketing: b.email_marketing } : {}),
      ...(b.types !== undefined ? { types: b.types } : {}),
    };
    const r = await this.prefs.update(userIdOf(req), patch, (current) =>
      tagMatches(ifMatch, etagOf(preferencesWire(current))),
    );
    switch (r.kind) {
      case "updated": {
        const wire = preferencesWire(r.view);
        res.setHeader("ETag", etagOf(wire));
        return wire;
      }
      case "precondition_failed":
        throw new ProblemError(412, "precondition-failed", "Preferences changed; reload and try again", {
          code: "precondition_failed",
        });
      case "rule":
        throw new ProblemError(422, r.code.replace(/_/g, "-"), RULE_TITLES[r.code], { code: r.code });
    }
  }

  @Put("me/devices/push-token")
  @HttpCode(204)
  @AuthenticatedSelf()
  @Idempotent({ required: false })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async putPushToken(
    @Req() req: ApiRequest,
    @Body(new ZodPipe(PushTokenSchema)) b: z.infer<typeof PushTokenSchema>,
  ): Promise<void> {
    await this.registerToken.execute(userIdOf(req), {
      installId: b.install_id,
      platform: b.platform,
      token: b.push_token,
    });
  }

  @Get("me/notifications")
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async inbox(@Req() req: ApiRequest, @Query(new ZodPipe(InboxQuerySchema, "/query")) q: z.infer<typeof InboxQuerySchema>) {
    const r = await this.listInbox.execute(userIdOf(req), { cursor: q.cursor, limit: q.limit });
    if (r.kind === "invalid_cursor") {
      throw new ProblemError(400, "validation-failed", "Request validation failed", {
        code: "invalid_cursor",
        errors: [{ pointer: "/query/cursor", code: "invalid_cursor" }],
      });
    }
    return { items: r.items.map(inboxWire), page: { next_cursor: r.nextCursor, has_more: r.nextCursor !== null } };
  }

  @Post("me/notifications/read")
  @HttpCode(204)
  @AuthenticatedSelf()
  @Idempotent({ required: false })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async read(@Req() req: ApiRequest, @Body(new ZodPipe(MarkReadSchema)) b: z.infer<typeof MarkReadSchema>): Promise<void> {
    const r = await this.markRead.execute(userIdOf(req), b.ids);
    if (r.kind === "not_found") throw Problems.notFound();
  }
}
