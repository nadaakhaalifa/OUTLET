import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from "@nestjs/common";
import { z } from "zod";
import { REFUND_PREFERENCES, REJECTION_REASONS, RETURN_METHODS, RETURN_REASONS, RETURN_RESOLUTIONS } from "../domain/bridge";
import { AuthenticatedSelf, Authorize, Idempotent, RateLimit } from "../../../platform/decorators";
import { headerValue, type ApiRequest } from "../../../platform/http-types";
import { ProblemError, Problems } from "../../../platform/problem";
import { ZodPipe } from "../../../platform/zod.pipe";
import type {
  DisputeReturn,
  GetMyReturn,
  InspectReturn,
  ListMyReturns,
  ListResult,
  ListSellerReturns,
  RequestReturn,
} from "../application/returns";
import { ReturnsDependencyUnavailableError, type Page, type ReturnRecord } from "../domain/ports";
import {
  DISPUTE_RETURN,
  GET_MY_RETURN,
  INSPECT_RETURN,
  LIST_MY_RETURNS,
  LIST_SELLER_RETURNS,
  REQUEST_RETURN,
  RETURNS_LINE_RESOLVER,
  RETURNS_OWN_RESOLVER,
  RETURNS_STORE_LIST_RESOLVER,
  RETURNS_STORE_RETURN_RESOLVER,
} from "./tokens";
import { returnStoreIdsOf } from "./resolvers";
import { disputeWire, returnWire } from "./wire";

const PhotoIds = z.array(z.uuid()).max(8);

const CreateBody = z
  .object({
    qty: z.number().int().min(1).max(1000),
    reason: z.enum(RETURN_REASONS),
    resolution: z.enum(RETURN_RESOLUTIONS),
    exchange_sku_id: z.uuid().optional(),
    refund_preference: z.enum(REFUND_PREFERENCES).optional(),
    method: z.enum(RETURN_METHODS),
    photo_upload_ids: PhotoIds.optional(),
    note: z.string().max(500).optional(),
  })
  .strict()
  .refine((b) => b.resolution === "exchange" || b.exchange_sku_id === undefined, {
    message: "exchange_sku_id is only valid for an exchange",
    path: ["exchange_sku_id"],
  });

const InspectBody = z
  .object({
    result: z.enum(["approve", "reject"]),
    rejection_reason: z.enum(REJECTION_REASONS).optional(),
    photo_upload_ids: PhotoIds.optional(),
    note: z.string().max(500).optional(),
  })
  .strict();

const DisputeBody = z
  .object({
    statement: z.string().min(1).max(1000),
    photo_upload_ids: PhotoIds.optional(),
  })
  .strict();

const ListQuery = z
  .object({
    cursor: z.string().max(512).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();

const LineParam = z.object({ orderLineId: z.uuid() }).strict();
const ReturnParam = z.object({ returnId: z.uuid() }).strict();

function principalOf(req: ApiRequest) {
  const p = req.principal;
  if (p === null || p === undefined) throw Problems.unauthenticated();
  return p;
}

function idempotencyKey(req: ApiRequest): string {
  const key = headerValue(req, "idempotency-key");
  if (key === undefined) throw Problems.invalidIdempotencyKey();
  return key;
}

const iso = (ms: number): string => new Date(ms).toISOString();

const conflict = () =>
  new ProblemError(409, "return-conflict", "The return changed at the same time; reload and retry", { code: "return_conflict" });

const invalidTransition = () =>
  new ProblemError(409, "invalid-transition", "The return is not in a state that allows this action", {
    code: "invalid_transition",
  });

function pageWire(page: Page<ReturnRecord>) {
  return {
    items: page.items.map(returnWire),
    page: { next_cursor: page.nextCursor, has_more: page.nextCursor !== null },
  };
}

function listOrThrow(r: ListResult) {
  if (r.kind === "invalid_cursor") {
    throw Problems.validation([{ pointer: "/query/cursor", code: "invalid" }]);
  }
  return pageWire(r.page);
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ReturnsDependencyUnavailableError) throw Problems.unavailable("returns_dependency_unavailable");
    throw e;
  }
}

@Controller()
export class ReturnsController {
  constructor(
    @Inject(REQUEST_RETURN) private readonly requestReturn: RequestReturn,
    @Inject(LIST_MY_RETURNS) private readonly listMine: ListMyReturns,
    @Inject(GET_MY_RETURN) private readonly getMine: GetMyReturn,
    @Inject(DISPUTE_RETURN) private readonly dispute: DisputeReturn,
    @Inject(LIST_SELLER_RETURNS) private readonly listSeller: ListSellerReturns,
    @Inject(INSPECT_RETURN) private readonly inspect: InspectReturn,
  ) {}

  /** createReturn. Outside the window, ineligible or non-returnable: 422 return-not-eligible, Arabic and English. */
  @Post("orders/lines/:orderLineId/returns")
  @Authorize({ action: "create", resourceType: "return_request", resolver: RETURNS_LINE_RESOLVER, idParam: "orderLineId" })
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async create(
    @Req() req: ApiRequest,
    @Param(new ZodPipe(LineParam, "/params")) params: z.infer<typeof LineParam>,
    @Body(new ZodPipe(CreateBody)) body: z.infer<typeof CreateBody>,
  ) {
    const key = idempotencyKey(req);
    const userId = principalOf(req).actor.id;
    const r = await guarded(() =>
      this.requestReturn.execute({
        userId,
        orderLineId: params.orderLineId.toLowerCase(),
        qty: body.qty,
        reason: body.reason,
        resolution: body.resolution,
        method: body.method,
        ...(body.exchange_sku_id === undefined ? {} : { exchangeSkuId: body.exchange_sku_id }),
        ...(body.refund_preference === undefined ? {} : { refundPreference: body.refund_preference }),
        photoUploadIds: body.photo_upload_ids ?? [],
        ...(body.note === undefined ? {} : { note: body.note }),
        idempotencyKey: key,
      }),
    );
    switch (r.kind) {
      case "ok":
        return returnWire(r.record);
      case "not_found":
        throw Problems.notFound();
      case "conflict":
        throw conflict();
      case "refused":
        throw new ProblemError(422, "return-not-eligible", "This item is not eligible for return", {
          code: r.code,
          detail: r.reason.en,
          extensions: {
            reason_ar: r.reason.ar,
            reason_en: r.reason.en,
            window_ends_at: r.windowEndsAtMs === null ? null : iso(r.windowEndsAtMs),
          },
        });
    }
  }

  @Get("me/returns")
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async mine(@Req() req: ApiRequest, @Query(new ZodPipe(ListQuery, "/query")) q: z.infer<typeof ListQuery>) {
    return listOrThrow(await this.listMine.execute(principalOf(req).actor.id, q.cursor ?? null, q.limit));
  }

  @Get("me/returns/:returnId")
  @Authorize({ action: "read", resourceType: "return_request", resolver: RETURNS_OWN_RESOLVER, idParam: "returnId" })
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async one(@Req() req: ApiRequest, @Param(new ZodPipe(ReturnParam, "/params")) p: z.infer<typeof ReturnParam>) {
    const r = await this.getMine.execute(principalOf(req).actor.id, p.returnId.toLowerCase());
    if (r === null) throw Problems.notFound();
    return returnWire(r);
  }

  @Post("returns/:returnId/dispute")
  @Authorize({ action: "update", resourceType: "return_request", resolver: RETURNS_OWN_RESOLVER, idParam: "returnId" })
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 10, windowSeconds: 60 }])
  async disputeIt(
    @Req() req: ApiRequest,
    @Param(new ZodPipe(ReturnParam, "/params")) p: z.infer<typeof ReturnParam>,
    @Body(new ZodPipe(DisputeBody)) body: z.infer<typeof DisputeBody>,
  ) {
    idempotencyKey(req);
    const r = await guarded(() =>
      this.dispute.execute({
        userId: principalOf(req).actor.id,
        returnId: p.returnId.toLowerCase(),
        statement: body.statement,
        photoUploadIds: body.photo_upload_ids ?? [],
      }),
    );
    switch (r.kind) {
      case "ok":
        if (r.record.dispute === null) throw Problems.internal();
        return disputeWire(r.record.dispute);
      case "not_found":
        throw Problems.notFound();
      case "invalid_transition":
        throw invalidTransition();
      case "conflict":
        throw conflict();
      case "dispute_window_elapsed":
        throw new ProblemError(422, "dispute-window-elapsed", "The dispute window for this rejection has ended", {
          code: "dispute_window_elapsed",
          extensions: {
            reason_ar: "انتهت مهلة الاعتراض على رفض الإرجاع.",
            reason_en: "The time to dispute this rejection has ended.",
          },
        });
      case "invalid_evidence":
        throw Problems.validation([{ pointer: "/body/photo_upload_ids", code: "invalid" }]);
    }
  }

  @Get("seller/returns")
  @Authorize({
    audience: "seller_api",
    action: "read",
    resourceType: "store_return",
    resolver: RETURNS_STORE_LIST_RESOLVER,
    idParam: "none",
  })
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async sellerList(@Req() req: ApiRequest, @Query(new ZodPipe(ListQuery, "/query")) q: z.infer<typeof ListQuery>) {
    const stores = returnStoreIdsOf(principalOf(req).actor);
    return listOrThrow(await this.listSeller.execute(stores, q.cursor ?? null, q.limit));
  }

  @Post("seller/returns/:returnId/inspect")
  @HttpCode(200)
  @Authorize({
    audience: "seller_api",
    action: "update",
    resourceType: "store_return",
    resolver: RETURNS_STORE_RETURN_RESOLVER,
    idParam: "returnId",
  })
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async inspectIt(
    @Req() req: ApiRequest,
    @Param(new ZodPipe(ReturnParam, "/params")) p: z.infer<typeof ReturnParam>,
    @Body(new ZodPipe(InspectBody)) body: z.infer<typeof InspectBody>,
  ) {
    idempotencyKey(req);
    const actor = principalOf(req).actor;
    const r = await guarded(() =>
      this.inspect.execute({
        returnId: p.returnId.toLowerCase(),
        actorId: actor.id,
        storeIds: returnStoreIdsOf(actor),
        decision: body.result,
        ...(body.rejection_reason === undefined ? {} : { rejectionReason: body.rejection_reason }),
        photoUploadIds: body.photo_upload_ids ?? [],
        ...(body.note === undefined ? {} : { note: body.note }),
      }),
    );
    switch (r.kind) {
      case "ok":
        return returnWire(r.record);
      case "not_found":
        throw Problems.notFound();
      case "invalid_transition":
        throw invalidTransition();
      case "conflict":
        throw conflict();
      case "inspection_window_elapsed":
        throw new ProblemError(409, "inspection-window-elapsed", "The 48 hour inspection window has passed; the return was approved", {
          code: "inspection_window_elapsed",
        });
      case "rejection_reason_required":
        throw Problems.validation([{ pointer: "/body/rejection_reason", code: "required" }]);
      case "photos_required":
        throw new ProblemError(422, "photos-required", "A rejection needs at least one photo", { code: "photos_required" });
      case "invalid_evidence":
        throw Problems.validation([{ pointer: "/body/photo_upload_ids", code: "invalid" }]);
    }
  }
}
