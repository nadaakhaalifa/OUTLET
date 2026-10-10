import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query, Req, Res } from "@nestjs/common";
import type { z } from "zod";
import { AuthenticatedSelf, Idempotent, RateLimit } from "../../../platform/decorators";
import { headerValue, type ApiRequest, type ApiResponse } from "../../../platform/http-types";
import { ProblemError, Problems } from "../../../platform/problem";
import { ZodPipe } from "../../../platform/zod.pipe";
import type { GetStore, ListStores } from "../application/directory";
import type { FavoritesState, GetNewCounts, ListFavorites, MarkFavoriteSeen, ReplaceFavoriteStores } from "../application/favorites";
import {
  GET_NEW_COUNTS,
  GET_STORE,
  LIST_FAVORITES,
  LIST_STORES,
  MARK_FAVORITE_SEEN,
  REPLACE_FAVORITES,
} from "./tokens";
import {
  decodeCursor,
  encodeCursor,
  etagOf,
  FavoriteStoresUpdateSchema,
  ListStoresQuerySchema,
  matchesIfMatch,
  matchesIfNoneMatch,
  StoreIdParamSchema,
  toHidden,
  toStore,
  toSummary,
} from "./wire";

function userIdOf(req: ApiRequest): string {
  const id = req.principal?.actor.id;
  if (id === undefined) throw Problems.unauthenticated();
  return id;
}

function notModified(): ProblemError {
  return new ProblemError(304, "not-modified", "Not modified");
}

function favoritesWire(state: FavoritesState) {
  return {
    stores: state.visible.map(toSummary),
    ...(state.hidden.length > 0 ? { hidden: state.hidden.map(toHidden) } : {}),
  };
}

@Controller("stores")
export class StoresController {
  constructor(
    @Inject(LIST_STORES) private readonly listStores: ListStores,
    @Inject(GET_STORE) private readonly getStore: GetStore,
  ) {}

  @Get()
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async list(
    @Req() req: ApiRequest,
    @Query(new ZodPipe(ListStoresQuerySchema, "/query")) query: z.infer<typeof ListStoresQuerySchema>,
  ) {
    const userId = userIdOf(req);
    // Resolve the ordering first so a cursor is only ever valid for the (world, ordering) that made it.
    const ordering = query.sort ?? (query.world === "my_stores" ? "favorite_position" : "trending");
    let after = null;
    if (query.cursor !== undefined) {
      after = decodeCursor(query.cursor, query.world, ordering);
      if (after === null) {
        throw new ProblemError(400, "invalid-cursor", "The cursor is not valid for this query", { code: "invalid_cursor" });
      }
    }
    const out = await this.listStores.execute({
      userId,
      world: query.world,
      sort: query.sort,
      after,
      limit: query.limit ?? 20,
    });
    return {
      items: out.items.map(toSummary),
      page: {
        next_cursor: out.hasMore && out.last !== null ? encodeCursor(query.world, out.ordering, out.last) : null,
        has_more: out.hasMore,
      },
      ...(out.hint !== null ? { hint: { kind: out.hint.kind, suggested_world: out.hint.suggestedWorld } } : {}),
    };
  }

  @Get(":storeId")
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async get(
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: ApiResponse,
    @Param(new ZodPipe(StoreIdParamSchema, "/params")) params: z.infer<typeof StoreIdParamSchema>,
  ) {
    const view = await this.getStore.execute(userIdOf(req), params.storeId);
    if (view === null) throw Problems.notFound();
    const wire = toStore(view);
    const etag = etagOf(wire);
    res.setHeader("ETag", etag);
    res.setHeader("Cache-Control", "private, no-cache");
    if (matchesIfNoneMatch(headerValue(req, "if-none-match"), etag)) throw notModified();
    return wire;
  }
}

@Controller("me/favorite-stores")
export class FavoriteStoresController {
  constructor(
    @Inject(LIST_FAVORITES) private readonly listFavorites: ListFavorites,
    @Inject(REPLACE_FAVORITES) private readonly replaceFavorites: ReplaceFavoriteStores,
    @Inject(GET_NEW_COUNTS) private readonly getNewCounts: GetNewCounts,
    @Inject(MARK_FAVORITE_SEEN) private readonly markSeen: MarkFavoriteSeen,
  ) {}

  @Get()
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async read(@Req() req: ApiRequest, @Res({ passthrough: true }) res: ApiResponse) {
    const wire = favoritesWire(await this.listFavorites.execute(userIdOf(req)));
    const etag = etagOf(wire);
    res.setHeader("ETag", etag);
    res.setHeader("Cache-Control", "private, no-cache");
    if (matchesIfNoneMatch(headerValue(req, "if-none-match"), etag)) throw notModified();
    return wire;
  }

  @Put()
  @HttpCode(200)
  @AuthenticatedSelf()
  @Idempotent({ required: false })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async replace(
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: ApiResponse,
    @Body(new ZodPipe(FavoriteStoresUpdateSchema)) body: z.infer<typeof FavoriteStoresUpdateSchema>,
  ) {
    const userId = userIdOf(req);
    const ifMatch = headerValue(req, "if-match");
    if (ifMatch === undefined) {
      throw new ProblemError(428, "precondition-required", "If-Match is required", { code: "precondition_required" });
    }
    const currentState = await this.listFavorites.execute(userId);
    const current = favoritesWire(currentState);
    const emptyAndWildcard =
      ifMatch.trim() === "*" && currentState.visible.length === 0 && currentState.hidden.length === 0;
    if (!emptyAndWildcard && !matchesIfMatch(ifMatch, etagOf(current))) {
      throw new ProblemError(412, "precondition-failed", "The favourites changed; reload and retry", {
        code: "precondition_failed",
      });
    }
    const out = await this.replaceFavorites.execute(userId, body.store_ids);
    if (out.kind === "rejected") {
      switch (out.error.kind) {
        case "too_many_favorites":
          throw new ProblemError(422, "too-many-favorites", "At most 30 favourite stores are allowed", {
            code: "too_many_favorites",
            extensions: { max: out.error.max },
          });
        case "duplicate_store":
          throw new ProblemError(422, "duplicate-store", "A store may appear once", { code: "duplicate_store" });
        case "unknown_store":
          throw new ProblemError(422, "unknown-store", "One or more stores are not available", { code: "unknown_store" });
      }
    }
    const wire = favoritesWire(out.state);
    res.setHeader("ETag", etagOf(wire));
    res.setHeader("Cache-Control", "private, no-cache");
    return wire;
  }

  @Get("new-counts")
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async newCounts(@Req() req: ApiRequest) {
    const counts = await this.getNewCounts.execute(userIdOf(req));
    return {
      counts: counts.map((c) => ({ store_id: c.storeId, new_since_last_visit: c.newSinceLastVisit })),
    };
  }

  @Post(":storeId/seen")
  @HttpCode(204)
  @AuthenticatedSelf()
  @Idempotent({ required: false })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async seen(
    @Req() req: ApiRequest,
    @Param(new ZodPipe(StoreIdParamSchema, "/params")) params: z.infer<typeof StoreIdParamSchema>,
  ): Promise<void> {
    const ok = await this.markSeen.execute(userIdOf(req), params.storeId);
    if (!ok) throw Problems.notFound();
  }
}
