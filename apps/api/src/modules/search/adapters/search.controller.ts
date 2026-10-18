import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query, Req, Res } from "@nestjs/common";
import { sha256Hex } from "@outlet/idempotency";
import { z } from "zod";
import { AuthenticatedSelf, Idempotent, RateLimit } from "../../../platform/decorators";
import { headerValue, type ApiRequest, type ApiResponse } from "../../../platform/http-types";
import { ProblemError, Problems } from "../../../platform/problem";
import { ZodPipe } from "../../../platform/zod.pipe";
import {
  CatalogUnavailableError,
  InvalidCursorError,
  SearchEnginesUnavailableError,
  TooManyFacetsError,
  type ParseSearchQuery,
  type SearchProducts,
  type SuggestQueries,
} from "../application/search";
import type {
  CreateSavedSearch,
  DeleteSavedSearch,
  GetSavedSearch,
  ListSavedSearches,
  UpdateSavedSearch,
} from "../application/saved-searches";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, MAX_QUERY_LENGTH } from "../domain/bridge";
import { SearchFilterSchema, SearchSortSchema, filterToWire } from "../domain/schema";
import {
  CREATE_SAVED_SEARCH,
  DELETE_SAVED_SEARCH,
  GET_SAVED_SEARCH,
  LIST_SAVED_SEARCHES,
  PARSE_SEARCH_QUERY,
  SEARCH_PRODUCTS,
  SUGGEST_QUERIES,
  UPDATE_SAVED_SEARCH,
} from "./tokens";
import { savedSearchWire, searchResultsWire, storeWire } from "./wire";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const FiltersParam = z
  .string()
  .max(4000)
  .transform((s, ctx) => {
    try {
      const v: unknown = JSON.parse(s);
      return v;
    } catch {
      ctx.addIssue({ code: "custom", message: "filters must be URL-decoded JSON" });
      return z.NEVER;
    }
  })
  .pipe(SearchFilterSchema);

const SearchQuery = z
  .object({
    q: z.string().max(MAX_QUERY_LENGTH).optional(),
    filters: FiltersParam.optional(),
    sort: SearchSortSchema.optional(),
    cursor: z.string().min(1).max(1024).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  })
  .strict();

const SuggestQuery = z.object({ q: z.string().min(1).max(100) }).strict();
const ParseBody = z
  .object({ text: z.string().min(1).max(MAX_QUERY_LENGTH), locale: z.enum(["ar", "en"]).optional() })
  .strict();

const SavedInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    query: z.string().max(MAX_QUERY_LENGTH).optional(),
    filter: SearchFilterSchema,
    alert_enabled: z.boolean().optional(),
  })
  .strict();
const SavedUpdate = z
  .object({ name: z.string().trim().min(1).max(80).optional(), alert_enabled: z.boolean().optional(), filter: SearchFilterSchema.optional() })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: "at least one property is required" });
const ListQuery = z
  .object({
    cursor: z.string().min(1).max(1024).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  })
  .strict();

function userOf(req: ApiRequest): string {
  const id = req.principal?.actor.id;
  if (id === undefined) throw Problems.unauthenticated();
  return id;
}

const unprocessable = (slug: string, title: string, code: string) => new ProblemError(422, slug, title, { code });
const badCursor = () => new ProblemError(400, "invalid-cursor", "The cursor is invalid", { code: "invalid_cursor" });

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof CatalogUnavailableError) throw Problems.unavailable("catalog_unavailable");
    if (e instanceof SearchEnginesUnavailableError) throw Problems.unavailable("search_unavailable");
    if (e instanceof InvalidCursorError) throw badCursor();
    if (e instanceof TooManyFacetsError) {
      throw Problems.validation([{ pointer: "/query/filters", code: "too_many_facets" }]);
    }
    throw e;
  }
}

const etagOf = (wire: unknown): string => `"${sha256Hex(JSON.stringify(wire)).slice(0, 32)}"`;
const tokensOf = (h: string): string[] => h.split(",").map((t) => t.trim());
const matches = (header: string | undefined, etag: string, weak: boolean): boolean =>
  header !== undefined && tokensOf(header).some((t) => t === etag || (weak && t === `W/${etag}`) || t === "*");

function encodeListCursor(c: { createdAtMs: number; id: string }): string {
  return Buffer.from(`${c.createdAtMs}.${c.id}`, "utf8").toString("base64url");
}
function decodeListCursor(s: string): { createdAtMs: number; id: string } {
  const raw = Buffer.from(s, "base64url").toString("utf8");
  const dot = raw.indexOf(".");
  const ms = Number(raw.slice(0, dot));
  const id = raw.slice(dot + 1);
  if (dot < 1 || !Number.isSafeInteger(ms) || ms < 0 || ms > 8_640_000_000_000_000 || !UUID.test(id)) throw badCursor();
  return { createdAtMs: ms, id };
}

@Controller("search")
export class SearchController {
  constructor(
    @Inject(SEARCH_PRODUCTS) private readonly search: SearchProducts,
    @Inject(SUGGEST_QUERIES) private readonly suggestions: SuggestQueries,
    @Inject(PARSE_SEARCH_QUERY) private readonly parse: ParseSearchQuery,
  ) {}

  @Get()
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 30, windowSeconds: 10 }])
  async run(@Req() req: ApiRequest, @Query(new ZodPipe(SearchQuery, "/query")) q: z.infer<typeof SearchQuery>) {
    const outcome = await guarded(() =>
      this.search.execute({
        userId: userOf(req),
        q: q.q ?? "",
        filter: q.filters ?? {},
        limit: q.limit,
        ...(q.sort !== undefined ? { sort: q.sort } : {}),
        ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
      }),
    );
    return searchResultsWire(outcome);
  }

  @Get("suggestions")
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 30, windowSeconds: 10 }])
  async suggest(@Req() req: ApiRequest, @Query(new ZodPipe(SuggestQuery, "/query")) q: z.infer<typeof SuggestQuery>) {
    const r = await guarded(() => this.suggestions.execute({ userId: userOf(req), q: q.q }));
    return {
      queries: r.queries,
      stores: r.stores.map(storeWire),
      categories: r.categories.map((c) => ({ id: c.id, name: { ar: c.name.ar, ...(c.name.en !== undefined ? { en: c.name.en } : {}) } })),
    };
  }

  @Post("parse")
  @AuthenticatedSelf()
  @Idempotent({ required: false })
  @RateLimit([{ dimension: "user", limit: 10, windowSeconds: 60 }])
  @HttpCode(200)
  async parseText(@Body(new ZodPipe(ParseBody)) body: z.infer<typeof ParseBody>) {
    const r = await this.parse.execute({ text: body.text, ...(body.locale !== undefined ? { locale: body.locale } : {}) });
    return {
      filter: filterToWire(r.filter),
      keywords: r.keywords,
      ...(r.unparsed.length > 0 ? { unparsed_fragments: [...r.unparsed] } : {}),
    };
  }
}

@Controller("me/saved-searches")
export class SavedSearchesController {
  constructor(
    @Inject(LIST_SAVED_SEARCHES) private readonly list: ListSavedSearches,
    @Inject(CREATE_SAVED_SEARCH) private readonly create: CreateSavedSearch,
    @Inject(GET_SAVED_SEARCH) private readonly getOne: GetSavedSearch,
    @Inject(UPDATE_SAVED_SEARCH) private readonly update: UpdateSavedSearch,
    @Inject(DELETE_SAVED_SEARCH) private readonly remove: DeleteSavedSearch,
  ) {}

  @Get()
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async index(@Req() req: ApiRequest, @Query(new ZodPipe(ListQuery, "/query")) q: z.infer<typeof ListQuery>) {
    const after = q.cursor === undefined ? null : decodeListCursor(q.cursor);
    const r = await this.list.execute({ userId: userOf(req), limit: q.limit, after });
    return {
      items: r.items.map(savedSearchWire),
      page: { next_cursor: r.next === null ? null : encodeListCursor(r.next), has_more: r.hasMore },
    };
  }

  @Post()
  @AuthenticatedSelf()
  @Idempotent({ required: false })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async add(@Req() req: ApiRequest, @Body(new ZodPipe(SavedInput)) body: z.infer<typeof SavedInput>) {
    const r = await this.create.execute({
      userId: userOf(req),
      name: body.name,
      query: body.query ?? null,
      filter: body.filter,
      alertEnabled: body.alert_enabled ?? false,
    });
    if (r.kind === "limit_reached") {
      throw unprocessable("saved-search-limit-reached", "At most 50 saved searches", "saved_search_limit_reached");
    }
    if (r.kind === "too_many_facets") throw unprocessable("too-many-facets", "At most 30 facets", "too_many_facets");
    return savedSearchWire(r.record);
  }

  @Get(":savedSearchId")
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async read(@Req() req: ApiRequest, @Res({ passthrough: true }) res: ApiResponse, @Param("savedSearchId") id: string) {
    if (!UUID.test(id)) throw Problems.notFound();
    const r = await this.getOne.execute({ userId: userOf(req), id });
    if (r === null) throw Problems.notFound();
    const wire = savedSearchWire(r);
    const etag = etagOf(wire);
    res.setHeader("ETag", etag);
    res.setHeader("Cache-Control", "private, no-cache");
    if (matches(headerValue(req, "if-none-match"), etag, true)) throw new ProblemError(304, "not-modified", "Not modified");
    return wire;
  }

  @Patch(":savedSearchId")
  @AuthenticatedSelf()
  @Idempotent({ required: false })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async change(
    @Req() req: ApiRequest,
    @Param("savedSearchId") id: string,
    @Body(new ZodPipe(SavedUpdate)) body: z.infer<typeof SavedUpdate>,
  ) {
    if (!UUID.test(id)) throw Problems.notFound();
    const userId = userOf(req);
    const ifMatch = headerValue(req, "if-match");
    // Ownership first: a foreign or missing id is 404 before any precondition is evaluated.
    const current = await this.getOne.execute({ userId, id });
    if (current === null) throw Problems.notFound();
    if (ifMatch === undefined) {
      throw new ProblemError(428, "precondition-required", "If-Match is required", { code: "precondition_required" });
    }
    if (!matches(ifMatch, etagOf(savedSearchWire(current)), false)) {
      throw new ProblemError(412, "precondition-failed", "The saved search changed; reload and retry", {
        code: "precondition_failed",
      });
    }
    const r = await this.update.execute({
      userId,
      id,
      patch: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.alert_enabled !== undefined ? { alertEnabled: body.alert_enabled } : {}),
        ...(body.filter !== undefined ? { filter: body.filter } : {}),
      },
    });
    if (r.kind === "not_found") throw Problems.notFound();
    if (r.kind === "too_many_facets") throw unprocessable("too-many-facets", "At most 30 facets", "too_many_facets");
    return savedSearchWire(r.record);
  }

  @Delete(":savedSearchId")
  @AuthenticatedSelf()
  @Idempotent({ required: false })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  @HttpCode(204)
  async destroy(@Req() req: ApiRequest, @Param("savedSearchId") id: string): Promise<void> {
    if (!UUID.test(id)) throw Problems.notFound();
    const ok = await this.remove.execute({ userId: userOf(req), id });
    if (!ok) throw Problems.notFound();
  }
}
