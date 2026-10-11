import { Body, Controller, Delete, Get, HttpCode, Inject, Patch, Post, Query, Req } from "@nestjs/common";
import { z } from "zod";
import { AuthenticatedSelf, Idempotent, RateLimit } from "../../../platform/decorators";
import type { ApiRequest } from "../../../platform/http-types";
import { ProblemError, Problems } from "../../../platform/problem";
import { ZodPipe } from "../../../platform/zod.pipe";
import { HISTORY_EVENT_TYPES, type HistoryEvent, type RecentlyViewed } from "../domain/bridge";
import type {
  ClearHistory,
  ListHistory,
  ListRecentlyViewed,
  RecordProductView,
  SetHistoryPaused,
  SetPersonalization,
} from "../application/history";
import {
  CLEAR_HISTORY,
  LIST_HISTORY,
  LIST_RECENTLY_VIEWED,
  RECORD_PRODUCT_VIEW,
  SET_HISTORY_PAUSED,
  SET_PERSONALIZATION,
} from "./tokens";

const iso = (ms: number): string => new Date(ms).toISOString();

const ListQuery = z
  .object({
    type: z.enum(HISTORY_EVENT_TYPES).optional(),
    cursor: z.string().min(1).max(80).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();
const PauseBody = z.object({ paused: z.boolean() }).strict();
const SettingsBody = z.object({ personalization: z.boolean() }).strict();
const ViewBody = z.object({ product_id: z.uuid() }).strict();
const RecentQuery = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) }).strict();

/** Own data only: no user id, no store staff id leaves the API. Prices are piastres as strings. */
export const eventWire = (e: HistoryEvent) => ({
  id: e.id,
  type: e.type,
  item_id: e.itemId,
  store_id: e.storeId,
  category_id: e.categoryId,
  price_piastres: e.priceMinor === null ? null : e.priceMinor.toString(),
  detail: e.detail,
  at: iso(e.atMs),
});
export const recentWire = (r: RecentlyViewed) => ({
  product_id: r.productId,
  price_piastres: r.priceMinor === null ? null : r.priceMinor.toString(),
  viewed_at: iso(r.viewedAtMs),
});
const settingsWire = (s: { personalization: boolean; historyPaused: boolean }) => ({
  personalization: s.personalization,
  history_paused: s.historyPaused,
});

const principalOf = (req: ApiRequest) => {
  const p = req.principal;
  if (p === null || p === undefined) throw Problems.unauthenticated();
  return p;
};

/** All routes act on the token subject only: there is no object id, hence no BOLA surface. */
@Controller()
export class HistoryController {
  constructor(
    @Inject(LIST_HISTORY) private readonly list: ListHistory,
    @Inject(CLEAR_HISTORY) private readonly clear: ClearHistory,
    @Inject(SET_HISTORY_PAUSED) private readonly pause: SetHistoryPaused,
    @Inject(SET_PERSONALIZATION) private readonly personalization: SetPersonalization,
    @Inject(RECORD_PRODUCT_VIEW) private readonly view: RecordProductView,
    @Inject(LIST_RECENTLY_VIEWED) private readonly recent: ListRecentlyViewed,
  ) {}

  @Get("me/history")
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 30, windowSeconds: 60 }])
  async history(@Req() req: ApiRequest, @Query(new ZodPipe(ListQuery, "/query")) q: z.infer<typeof ListQuery>) {
    const r = await this.list.execute(principalOf(req).actor.id, q.type ?? null, q.cursor ?? null, q.limit);
    if (r.kind === "invalid_cursor") {
      throw new ProblemError(400, "validation-failed", "Request validation failed", {
        code: "invalid_cursor",
        errors: [{ pointer: "/query/cursor", code: "invalid_cursor" }],
      });
    }
    return {
      items: r.items.map(eventWire),
      page: { next_cursor: r.nextCursor, has_more: r.nextCursor !== null },
      settings: settingsWire(r.settings),
    };
  }

  @Delete("me/history")
  @AuthenticatedSelf()
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 5, windowSeconds: 86_400 }])
  async clearHistory(@Req() req: ApiRequest) {
    const r = await this.clear.execute(principalOf(req).actor.id);
    return {
      request_id: r.requestId,
      complete_by: iso(r.deadlineMs),
      deleted: { events: r.counts.events, features: r.counts.features, recently_viewed: r.counts.recentlyViewed },
    };
  }

  @Post("me/history/pause")
  @HttpCode(200)
  @AuthenticatedSelf()
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 20, windowSeconds: 3600 }])
  async setPaused(@Req() req: ApiRequest, @Body(new ZodPipe(PauseBody)) b: z.infer<typeof PauseBody>) {
    return settingsWire(await this.pause.execute(principalOf(req).actor.id, b.paused));
  }

  @Patch("me/settings")
  @AuthenticatedSelf()
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 20, windowSeconds: 3600 }])
  async setSettings(@Req() req: ApiRequest, @Body(new ZodPipe(SettingsBody)) b: z.infer<typeof SettingsBody>) {
    return settingsWire(await this.personalization.execute(principalOf(req).actor.id, b.personalization));
  }

  @Get("me/recently-viewed")
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async recentlyViewed(@Req() req: ApiRequest, @Query(new ZodPipe(RecentQuery, "/query")) q: z.infer<typeof RecentQuery>) {
    const items = await this.recent.execute(principalOf(req).actor.id, q.limit);
    return { items: items.map(recentWire) };
  }

  @Post("me/recently-viewed")
  @HttpCode(200)
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async recordView(@Req() req: ApiRequest, @Body(new ZodPipe(ViewBody)) b: z.infer<typeof ViewBody>) {
    const r = await this.view.execute(principalOf(req).actor.id, b.product_id.toLowerCase());
    if (r.kind === "not_found") throw Problems.notFound();
    return { recorded: r.recorded };
  }
}
