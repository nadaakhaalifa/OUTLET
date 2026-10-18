import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Req } from "@nestjs/common";
import { z } from "zod";
import { Authorize, AuthenticatedSelf, Idempotent, RateLimit } from "../../../platform/decorators";
import type { ApiRequest } from "../../../platform/http-types";
import { ProblemError, Problems } from "../../../platform/problem";
import { ZodPipe } from "../../../platform/zod.pipe";
import type { ChatAction, StylistChat } from "../application/chat";
import { CHAT_WORLDS } from "../domain/chat";
import { STYLIST_CHAT, STYLIST_CHAT_SESSION_RESOLVER } from "./tokens";
import { sessionViewWire, sessionWire, turnWire } from "./chat-wire";

const Uuid = z.uuid();
const Scope = z.object({ world: z.enum(CHAT_WORLDS), store_ids: z.array(Uuid).max(30).default([]) }).strict();
const Locale = z.enum(["ar", "en"]);

const CreateBody = z.object({ locale: Locale.optional(), scope: Scope.optional() }).strict();

const ActionBody = z.discriminatedUnion("type", [
  z.object({ type: z.literal("cheaper") }).strict(),
  z.object({ type: z.literal("more_modest") }).strict(),
  z.object({ type: z.literal("swap_item"), item_id: Uuid }).strict(),
  z.object({ type: z.literal("scope"), world: z.enum(CHAT_WORLDS), store_ids: z.array(Uuid).max(30).default([]) }).strict(),
  z
    .object({
      type: z.literal("chip"),
      topic: z.enum(["palette", "occasion", "budget", "swap_slot"]),
      value: z.string().min(1).max(40).regex(/^[a-z0-9_]+$/),
    })
    .strict(),
]);

/** `text` is capped generously here; the service truncates to 500 characters and sets `truncated`. */
const MessageBody = z
  .object({
    text: z.string().max(2000).optional(),
    action: ActionBody.optional(),
    locale: Locale.optional(),
    use_remaining_budget: z.boolean().default(false),
  })
  .strict()
  .refine((b) => (b.text !== undefined && b.text.trim().length > 0) !== (b.action !== undefined), {
    message: "send exactly one of text or action",
  });

const SettingsBody = z.object({ history_enabled: z.boolean() }).strict();

const principalOf = (req: ApiRequest) => {
  const p = req.principal;
  if (p === null || p === undefined) throw Problems.unauthenticated();
  return p;
};
const idempotencyKeyOf = (req: ApiRequest): string => {
  const key = req.headers["idempotency-key"];
  const v = Array.isArray(key) ? (key[0] ?? "") : (key ?? "");
  if (!Uuid.safeParse(v).success) throw Problems.invalidIdempotencyKey();
  return v.toLowerCase();
};
const disabled = () =>
  new ProblemError(503, "stylist-chat-disabled", "Stylist chat is currently disabled", {
    code: "stylist_chat_disabled",
    headers: { "Retry-After": "60" },
  });

function actionOf(a: z.infer<typeof ActionBody>): ChatAction {
  switch (a.type) {
    case "cheaper":
    case "more_modest":
      return { type: a.type };
    case "swap_item":
      return { type: "swap_item", itemId: a.item_id.toLowerCase() };
    case "scope":
      return { type: "scope", world: a.world, storeIds: a.store_ids.map((s) => s.toLowerCase()) };
    case "chip":
      return { type: "chip", topic: a.topic, value: a.value };
  }
}

@Controller()
export class StylistChatController {
  constructor(@Inject(STYLIST_CHAT) private readonly chat: StylistChat) {}

  @Post("stylist/chat/sessions")
  @HttpCode(201)
  @AuthenticatedSelf()
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 10, windowSeconds: 60 }])
  async create(@Req() req: ApiRequest, @Body(new ZodPipe(CreateBody)) b: z.infer<typeof CreateBody>) {
    const r = await this.chat.createSession({
      userId: principalOf(req).actor.id,
      localeHint: b.locale ?? null,
      scope: b.scope === undefined ? null : { world: b.scope.world, storeIds: b.scope.store_ids.map((s) => s.toLowerCase()) },
    });
    if (r.kind === "disabled") throw disabled();
    return sessionWire(r.session);
  }

  @Get("stylist/chat/sessions")
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async list(@Req() req: ApiRequest) {
    const rows = await this.chat.listSessions(principalOf(req).actor.id);
    return { items: rows.map(sessionWire) };
  }

  @Get("stylist/chat/sessions/:sessionId")
  @Authorize({ action: "read", resourceType: "wishlist", resolver: STYLIST_CHAT_SESSION_RESOLVER, idParam: "sessionId" })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async get(@Req() req: ApiRequest, @Param("sessionId") sessionId: string) {
    const v = await this.chat.getSession(principalOf(req).actor.id, sessionId.toLowerCase());
    if (v === null) throw Problems.notFound();
    return sessionViewWire(v);
  }

  @Post("stylist/chat/sessions/:sessionId/messages")
  @HttpCode(200)
  @Authorize({ action: "update", resourceType: "wishlist", resolver: STYLIST_CHAT_SESSION_RESOLVER, idParam: "sessionId" })
  @Idempotent({ required: true })
  @RateLimit([
    { dimension: "user", limit: 12, windowSeconds: 60 },
    { dimension: "user", limit: 30, windowSeconds: 86_400 },
  ])
  async message(
    @Req() req: ApiRequest,
    @Param("sessionId") sessionId: string,
    @Body(new ZodPipe(MessageBody)) b: z.infer<typeof MessageBody>,
  ) {
    const r = await this.chat.send({
      userId: principalOf(req).actor.id,
      sessionId: sessionId.toLowerCase(),
      clientMessageId: idempotencyKeyOf(req),
      text: b.text ?? null,
      action: b.action === undefined ? null : actionOf(b.action),
      localeHint: b.locale ?? null,
      useRemainingBudget: b.use_remaining_budget,
    });
    switch (r.kind) {
      case "disabled":
        throw disabled();
      case "not_found":
        throw Problems.notFound();
      case "quota_exceeded":
        throw new ProblemError(429, "chat-quota-exceeded", "Daily stylist chat limit reached", {
          code: "chat_quota_exceeded",
          detail: `Free fair use is ${r.limit} chat turns per day. It resets at 00:00 UTC.`,
          headers: { "Retry-After": String(Math.max(1, Math.ceil(r.retryAfterMs / 1000))) },
          extensions: { limit: r.limit },
        });
      case "generation_quota":
        throw Problems.rateLimited(r.retryAfterMs / 1000);
      case "ok":
        return turnWire(r.view);
    }
  }

  @Delete("stylist/chat/sessions/:sessionId")
  @HttpCode(204)
  @Authorize({ action: "delete", resourceType: "wishlist", resolver: STYLIST_CHAT_SESSION_RESOLVER, idParam: "sessionId" })
  @RateLimit([{ dimension: "user", limit: 20, windowSeconds: 60 }])
  async remove(@Req() req: ApiRequest, @Param("sessionId") sessionId: string): Promise<void> {
    const ok = await this.chat.deleteSession(principalOf(req).actor.id, sessionId.toLowerCase());
    if (!ok) throw Problems.notFound();
  }

  @Get("me/stylist-chat/settings")
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async settings(@Req() req: ApiRequest) {
    return { history_enabled: await this.chat.getHistoryEnabled(principalOf(req).actor.id) };
  }

  @Patch("me/stylist-chat/settings")
  @HttpCode(200)
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 20, windowSeconds: 60 }])
  async setSettings(@Req() req: ApiRequest, @Body(new ZodPipe(SettingsBody)) b: z.infer<typeof SettingsBody>) {
    await this.chat.setHistoryEnabled(principalOf(req).actor.id, b.history_enabled);
    return { history_enabled: b.history_enabled };
  }
}
