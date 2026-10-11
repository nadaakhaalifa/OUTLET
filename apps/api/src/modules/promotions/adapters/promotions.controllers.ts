import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query, Req, Res } from "@nestjs/common";
import type { Grant, Resource } from "@outlet/policy";
import type { z } from "zod";
import { AuthenticatedSelf, Idempotent, Public, RateLimit } from "../../../platform/decorators";
import { headerValue, type ApiRequest, type ApiResponse } from "../../../platform/http-types";
import { ProblemError, Problems } from "../../../platform/problem";
import { ZodPipe } from "../../../platform/zod.pipe";
import {
  type CreatePromotion,
  type EvaluatePromotions,
  type GetPromotion,
  type ListPromotions,
  type UpdatePromotion,
  type CreateInput,
} from "../application/promotions";
import { promotions } from "../domain/bridge";
import {
  PromotionsUnavailableError,
  type OwnerFilter,
  type PromotionPatch,
  type PromotionRecord,
  type ServiceAuthenticator,
} from "../domain/ports";
import { type PromotionAuthorizer } from "./authorizer";
import {
  CREATE_PROMOTION,
  EVALUATE_PROMOTIONS,
  GET_PROMOTION,
  LIST_PROMOTIONS,
  PROMOTION_AUTHORIZER,
  PROMOTION_SERVICE_AUTH,
  UPDATE_PROMOTION,
} from "./tokens";
import {
  EvaluateBody,
  IdParam,
  ListQuery,
  PromotionInput,
  PromotionUpdate,
  etagOf,
  evaluationWire,
  promotionWire,
  type PromotionInputT,
  type PromotionUpdateT,
} from "./wire";

// ---- shared helpers ---------------------------------------------------------------------

const unprocessable = (slug: string, title: string, code: string, detail?: string) =>
  new ProblemError(422, slug, title, { code, ...(detail !== undefined ? { detail } : {}) });

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof PromotionsUnavailableError) throw Problems.unavailable("promotions_unavailable");
    throw e;
  }
}

const SUPPORTED = new Set<string>(promotions.PROMOTION_KINDS);
const DEFAULT_SCOPE: Record<promotions.PromotionKind, promotions.PromotionScope> = {
  percent: "order",
  fixed: "order",
  bogo: "item",
  tiered: "order",
  free_shipping: "shipping",
};

type Mapped = { readonly ok: true; readonly input: Omit<CreateInput, "owner" | "createdBy"> } | { readonly ok: false; readonly error: ProblemError };

function mapCreate(b: PromotionInputT): Mapped {
  if (!SUPPORTED.has(b.type)) {
    return {
      ok: false,
      error: unprocessable("promotion-type-not-supported", "This promotion type is not available yet", "promotion_type_not_supported"),
    };
  }
  const kind = b.type as promotions.PromotionKind;
  let value: promotions.PromotionValue;
  switch (kind) {
    case "percent":
      if (b.value?.percent_bp === undefined) return missing("value.percent_bp");
      value = { kind, percentBps: b.value.percent_bp };
      break;
    case "fixed":
      if (b.value?.fixed === undefined) return missing("value.fixed");
      value = { kind, amount: b.value.fixed };
      break;
    case "bogo":
      if (b.bogo === undefined) return missing("bogo");
      value = { kind, buyQty: b.bogo.buy_qty, getQty: b.bogo.get_qty, getPercentBps: b.bogo.get_percent_bp ?? 10_000 };
      break;
    case "tiered":
      if (b.tiers === undefined) return missing("tiers");
      value = { kind, tiers: b.tiers.map((t) => ({ minSubtotal: t.min_subtotal, percentBps: t.percent_bp })) };
      break;
    case "free_shipping":
      value = { kind };
      break;
  }
  const code = b.code === undefined ? null : promotions.normalizeCode(b.code);
  return {
    ok: true,
    input: {
      title: { ar: b.title.ar, ...(b.title.en !== undefined ? { en: b.title.en } : {}) },
      kind,
      scope: b.scope ?? DEFAULT_SCOPE[kind],
      value,
      code,
      autoApply: b.auto_apply ?? false,
      funding: { platformPct: b.funding.platform_pct, sellerPct: b.funding.seller_pct },
      targeting: {
        storeIds: b.targeting?.store_ids ?? [],
        skuIds: b.targeting?.sku_ids ?? [],
        paymentMethods: b.targeting?.payment_methods ?? [],
        plusOnly: b.targeting?.plus_only ?? false,
      },
      minOrder: b.min_order ?? null,
      maxDiscount: b.max_discount ?? null,
      perUserCap: b.per_user_cap ?? null,
      perDayCap: b.per_day_cap ?? null,
      totalBudget: b.total_budget ?? null,
      startsAtMs: Date.parse(b.starts_at),
      endsAtMs: Date.parse(b.ends_at),
    },
  };
}

function missing(field: string): Mapped {
  return { ok: false, error: unprocessable("promotion-value-required", "The promotion value is required", "value_required", field) };
}

function toPatch(b: PromotionUpdateT): PromotionPatch {
  return {
    ...(b.title !== undefined ? { title: { ar: b.title.ar, ...(b.title.en !== undefined ? { en: b.title.en } : {}) } } : {}),
    ...(b.status !== undefined ? { status: b.status } : {}),
    ...(b.ends_at !== undefined ? { endsAtMs: Date.parse(b.ends_at) } : {}),
    ...(b.total_budget !== undefined ? { totalBudget: b.total_budget } : {}),
    ...(b.max_discount !== undefined ? { maxDiscount: b.max_discount } : {}),
  };
}

function ifMatchVersion(req: ApiRequest, promotionId: string): number {
  const header = headerValue(req, "if-match");
  if (header === undefined) {
    throw new ProblemError(428, "precondition-required", "If-Match is required", { code: "precondition_required" });
  }
  const m = /^"([0-9a-f-]{36})-v(\d{1,9})"$/.exec(header.trim());
  if (m === null || m[1] !== promotionId) {
    throw new ProblemError(412, "precondition-failed", "The promotion changed; reload and retry", {
      code: "precondition_failed",
    });
  }
  return Number(m[2]);
}

const staleError = () =>
  new ProblemError(412, "precondition-failed", "The promotion changed; reload and retry", { code: "precondition_failed" });

function cursorOf(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(raw)) throw Problems.validation([{ pointer: "/query/cursor", code: "invalid" }]);
  try {
    const id = Buffer.from(raw, "base64url").toString("utf8");
    return /^[0-9a-f-]{36}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}
const cursorFor = (id: string): string => Buffer.from(id, "utf8").toString("base64url");

function principalId(req: ApiRequest): string {
  const id = req.principal?.actor.id;
  if (id === undefined) throw Problems.unauthenticated();
  return id;
}

interface Handlers {
  readonly list: ListPromotions;
  readonly create: CreatePromotion;
  readonly get: GetPromotion;
  readonly update: UpdatePromotion;
}

async function doList(h: Handlers, owner: OwnerFilter, query: z.infer<typeof ListQuery>) {
  const out = await guarded(() => h.list.execute({ owner, afterId: cursorOf(query.cursor), limit: query.limit }));
  const last = out.items[out.items.length - 1];
  return {
    items: out.items.map(promotionWire),
    page: { next_cursor: out.hasMore && last !== undefined ? cursorFor(last.id) : null, has_more: out.hasMore },
  };
}

async function doCreate(h: Handlers, owner: OwnerFilter, req: ApiRequest, res: ApiResponse, body: PromotionInputT) {
  const mapped = mapCreate(body);
  if (!mapped.ok) throw mapped.error;
  const r = await guarded(() => h.create.execute({ ...mapped.input, owner, createdBy: principalId(req) }));
  if (r.kind === "invalid") {
    throw unprocessable("promotion-invalid", "The promotion is not valid", "promotion_invalid", r.issues.join(","));
  }
  if (r.kind === "code_taken") throw unprocessable("code-taken", "This voucher code is already in use", "code_taken");
  res.status(201);
  res.setHeader("ETag", etagOf(r.record));
  return promotionWire(r.record);
}

async function doPatch(
  h: Handlers,
  owner: OwnerFilter,
  req: ApiRequest,
  res: ApiResponse,
  id: string,
  body: PromotionUpdateT,
) {
  const expectedVersion = ifMatchVersion(req, id);
  const r = await guarded(() => h.update.execute({ id, owner, expectedVersion, patch: toPatch(body) }));
  switch (r.kind) {
    case "ok":
      res.setHeader("ETag", etagOf(r.record));
      return promotionWire(r.record);
    case "not_found":
      throw Problems.notFound();
    case "stale":
      throw staleError();
    case "invalid":
      throw unprocessable("promotion-invalid", "The change is not allowed", "promotion_invalid", r.issues.join(","));
  }
}

async function doEnd(h: Handlers, owner: OwnerFilter, id: string): Promise<void> {
  const current = await guarded(() => h.get.execute(id, owner));
  if (current === null) throw Problems.notFound();
  if (current.status === "ended") return;
  const r = await guarded(() =>
    h.update.execute({ id, owner, expectedVersion: current.version, patch: { status: "ended" } }),
  );
  if (r.kind === "ok") return;
  if (r.kind === "not_found") throw Problems.notFound();
  throw new ProblemError(409, "promotion-conflict", "The promotion changed; retry", { code: "promotion_conflict" });
}

function sendOne(req: ApiRequest, res: ApiResponse, p: PromotionRecord) {
  const etag = etagOf(p);
  res.setHeader("ETag", etag);
  res.setHeader("Cache-Control", "private, no-cache");
  const inm = headerValue(req, "if-none-match");
  if (inm !== undefined && inm.split(",").some((t) => t.trim() === etag || t.trim() === "*")) {
    throw new ProblemError(304, "not-modified", "Not modified");
  }
  return promotionWire(p);
}

const adminResource = (id: string): Resource => ({ type: "admin_console", id, state: "active" });
const sellerResource = (id: string, storeId: string): Resource => ({ type: "store_settings", id, storeId, state: "active" });
const NO_STORE = "00000000-0000-0000-0000-000000000000";

// ---- admin ------------------------------------------------------------------------------

@Controller("admin/promotions")
export class AdminPromotionsController {
  private readonly platform: OwnerFilter = { kind: "platform" };
  private readonly h: Handlers;

  constructor(
    @Inject(LIST_PROMOTIONS) list: ListPromotions,
    @Inject(CREATE_PROMOTION) create: CreatePromotion,
    @Inject(GET_PROMOTION) get: GetPromotion,
    @Inject(UPDATE_PROMOTION) update: UpdatePromotion,
    @Inject(PROMOTION_AUTHORIZER) private readonly authz: PromotionAuthorizer,
  ) {
    this.h = { list, create, get, update };
  }

  /** Admin object routes only see platform promotions; anything else answers 404 after the role check. */
  private async object(req: ApiRequest, id: string, action: "read" | "update" | "delete") {
    const p = await guarded(() => this.h.get.execute(id, this.platform));
    await this.authz.authorize(req, {
      action,
      resourceType: "admin_console",
      resource: p === null ? null : adminResource(p.id),
    });
    return p;
  }

  @Get()
  @AuthenticatedSelf("admin_api")
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async list(@Req() req: ApiRequest, @Query(new ZodPipe(ListQuery, "/query")) query: z.infer<typeof ListQuery>) {
    await this.authz.authorize(req, { action: "read", resourceType: "admin_console", resource: adminResource("promotions") });
    return doList(this.h, this.platform, query);
  }

  @Post()
  @AuthenticatedSelf("admin_api")
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 30, windowSeconds: 60 }])
  async create(
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: ApiResponse,
    @Body(new ZodPipe(PromotionInput)) body: PromotionInputT,
  ) {
    await this.authz.authorize(req, { action: "create", resourceType: "admin_console", resource: adminResource("promotions") });
    return doCreate(this.h, this.platform, req, res, body);
  }

  @Get(":promotionId")
  @AuthenticatedSelf("admin_api")
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async read(
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: ApiResponse,
    @Param(new ZodPipe(IdParam, "/params")) params: z.infer<typeof IdParam>,
  ) {
    const p = await this.object(req, params.promotionId, "read");
    if (p === null) throw Problems.notFound();
    return sendOne(req, res, p);
  }

  @Patch(":promotionId")
  @AuthenticatedSelf("admin_api")
  @Idempotent({ required: false })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async patch(
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: ApiResponse,
    @Param(new ZodPipe(IdParam, "/params")) params: z.infer<typeof IdParam>,
    @Body(new ZodPipe(PromotionUpdate)) body: PromotionUpdateT,
  ) {
    await this.object(req, params.promotionId, "update");
    return doPatch(this.h, this.platform, req, res, params.promotionId, body);
  }

  @Delete(":promotionId")
  @AuthenticatedSelf("admin_api")
  @Idempotent({ required: false })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async end(
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: ApiResponse,
    @Param(new ZodPipe(IdParam, "/params")) params: z.infer<typeof IdParam>,
  ) {
    await this.object(req, params.promotionId, "delete");
    await doEnd(this.h, this.platform, params.promotionId);
    res.status(204);
  }
}

// ---- seller -----------------------------------------------------------------------------

const brandStores = (grants: readonly Grant[]): string[] => [
  ...new Set(grants.flatMap((g) => (g.kind === "brand" ? [g.storeId] : []))),
];

@Controller("seller/promotions")
export class SellerPromotionsController {
  private readonly h: Handlers;

  constructor(
    @Inject(LIST_PROMOTIONS) list: ListPromotions,
    @Inject(CREATE_PROMOTION) create: CreatePromotion,
    @Inject(GET_PROMOTION) get: GetPromotion,
    @Inject(UPDATE_PROMOTION) update: UpdatePromotion,
    @Inject(PROMOTION_AUTHORIZER) private readonly authz: PromotionAuthorizer,
  ) {
    this.h = { list, create, get, update };
  }

  /**
   * The store the call acts for: `X-Store-Id` when present, else the actor's only brand store.
   * A store the actor has no grant for is a 404 from policy, never a hint that it exists.
   */
  private storeOf(req: ApiRequest): string {
    const header = headerValue(req, "x-store-id");
    if (header !== undefined) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(header)) {
        throw Problems.validation([{ pointer: "/headers/x-store-id", code: "invalid" }]);
      }
      return header.toLowerCase();
    }
    const stores = brandStores(req.principal?.actor.grants ?? []);
    if (stores.length > 1) {
      throw Problems.validation([{ pointer: "/headers/x-store-id", code: "required" }]);
    }
    return stores[0] ?? NO_STORE;
  }

  /** Loads the promotion within the acting store; a foreign promotion is a null resource (404). */
  private async object(req: ApiRequest, id: string, action: "read" | "update" | "delete") {
    const storeId = this.storeOf(req);
    const owner: OwnerFilter = { kind: "store", storeId };
    const p = await guarded(() => this.h.get.execute(id, owner));
    await this.authz.authorize(req, {
      action,
      resourceType: "store_settings",
      resource: p === null ? null : sellerResource(p.id, storeId),
    });
    return { p, owner };
  }

  @Get()
  @AuthenticatedSelf("seller_api")
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async list(@Req() req: ApiRequest, @Query(new ZodPipe(ListQuery, "/query")) query: z.infer<typeof ListQuery>) {
    const storeId = this.storeOf(req);
    await this.authz.authorize(req, { action: "read", resourceType: "store_settings", resource: sellerResource("promotions", storeId) });
    return doList(this.h, { kind: "store", storeId }, query);
  }

  @Post()
  @AuthenticatedSelf("seller_api")
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 30, windowSeconds: 60 }])
  async create(
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: ApiResponse,
    @Body(new ZodPipe(PromotionInput)) body: PromotionInputT,
  ) {
    const storeId = this.storeOf(req);
    await this.authz.authorize(req, { action: "create", resourceType: "store_settings", resource: sellerResource("promotions", storeId) });
    return doCreate(this.h, { kind: "store", storeId }, req, res, body);
  }

  @Get(":promotionId")
  @AuthenticatedSelf("seller_api")
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async read(
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: ApiResponse,
    @Param(new ZodPipe(IdParam, "/params")) params: z.infer<typeof IdParam>,
  ) {
    const { p } = await this.object(req, params.promotionId, "read");
    if (p === null) throw Problems.notFound();
    return sendOne(req, res, p);
  }

  @Patch(":promotionId")
  @AuthenticatedSelf("seller_api")
  @Idempotent({ required: false })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async patch(
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: ApiResponse,
    @Param(new ZodPipe(IdParam, "/params")) params: z.infer<typeof IdParam>,
    @Body(new ZodPipe(PromotionUpdate)) body: PromotionUpdateT,
  ) {
    const { owner } = await this.object(req, params.promotionId, "update");
    return doPatch(this.h, owner, req, res, params.promotionId, body);
  }

  @Delete(":promotionId")
  @AuthenticatedSelf("seller_api")
  @Idempotent({ required: false })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async end(
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: ApiResponse,
    @Param(new ZodPipe(IdParam, "/params")) params: z.infer<typeof IdParam>,
  ) {
    const { owner } = await this.object(req, params.promotionId, "delete");
    await doEnd(this.h, owner, params.promotionId);
    res.status(204);
  }
}

// ---- internal evaluate -------------------------------------------------------------------

@Controller("promotions")
export class InternalPromotionsController {
  constructor(
    @Inject(EVALUATE_PROMOTIONS) private readonly evaluate: EvaluatePromotions,
    @Inject(PROMOTION_SERVICE_AUTH) private readonly serviceAuth: ServiceAuthenticator,
  ) {}

  /**
   * Service-to-service only (OpenAPI x-internal). Declared `@Public` to the user policy guard because
   * no user principal exists here; the handler verifies the service credential before anything else.
   */
  @Post("evaluate")
  @HttpCode(200)
  @Public()
  @RateLimit([{ dimension: "ip", limit: 600, windowSeconds: 60 }])
  async run(@Req() req: ApiRequest, @Body() raw: unknown) {
    // Credential first, then the body: a stranger learns nothing about the request schema.
    if (!this.serviceAuth.verify(headerValue(req, "authorization"))) {
      throw Problems.unauthenticated("invalid_credentials");
    }
    const body = new ZodPipe(EvaluateBody).transform(raw);
    const result = await guarded(() =>
      this.evaluate.execute({
        userId: body.user_id,
        lines: body.lines.map((l) => ({ skuId: l.sku_id, storeId: l.store_id, qty: l.qty, unitPrice: l.unit_price })),
        shippingFees: (body.shipping_fees ?? []).map((f) => ({ storeId: f.store_id, fee: f.fee })),
        codes: body.voucher_codes ?? [],
        paymentMethod: body.payment_method ?? null,
        isPlus: body.is_plus_member ?? false,
        atMs: Date.parse(body.at),
      }),
    );
    return evaluationWire(result);
  }
}
