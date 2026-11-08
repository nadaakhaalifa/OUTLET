import type { MultipartFile } from "@fastify/multipart";
import { Controller, Get, HttpCode, Inject, Patch, Post, Req } from "@nestjs/common";
import { PublishResult, SellerProduct, SellerProductSummaryPage } from "@outlet/catalog";
import type { z } from "zod";
import type { Principal } from "@outlet/policy";
import { CategoriesQuery, CategoryEntryPage } from "../catalog-public/index.js";
import { Authorize, Contract, Paginated, RateLimit } from "../../platform/decorators.js";
import { API_DEPS } from "../../platform/deps.js";
import type { ApiDeps, CatalogServices } from "../../platform/deps.js";
import { headerValue } from "../../platform/http.js";
import type { ApiRequest, RequestState } from "../../platform/http.js";
import { ProblemError, Problems } from "../../platform/problem.js";
import { RATE_BUDGETS } from "../../platform/rate-limit/budgets.js";
import { activeStore } from "../../platform/resolvers.js";
import { Body, Ctx, Params, Query } from "../../platform/validation.js";
import { AttributeSetResult, CategoryIdParams, DefectCardBody, DefectCardResult, MediaUploadForm, MediaUploadKind, MediaUploadResult, ProductIdParams, ProductPatch, PublishBody, SellerProductsQuery } from "./dto.js";

/** 10 MB, the MediaService hard cap for product and defect photos. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

interface Tenant {
  readonly principal: Principal;
  readonly storeId: string;
  readonly catalog: CatalogServices;
}

const tenant = (s: RequestState, deps: ApiDeps): Tenant => {
  // PolicyGuard set these; the services re-check the same principal against the same store (defence in depth).
  if (s.principal === undefined || s.storeId === undefined || s.marketId === undefined) throw Problems.internal("tenant-context-missing");
  return { principal: s.principal, storeId: s.storeId, catalog: deps.catalog(s.marketId) };
};

/** If-Match carries the listing `version` (integer, optionally quoted or weak-prefixed). Missing → 428, malformed → 400. */
const versionOf = (req: ApiRequest, required: boolean): number | undefined => {
  const raw = headerValue(req, "if-match");
  if (raw === undefined) {
    if (required) throw new ProblemError(428, "precondition-required", "If-Match is required");
    return undefined;
  }
  const m = /^(?:W\/)?"?(\d{1,9})"?$/.exec(raw.trim());
  if (m?.[1] === undefined) throw Problems.badRequest("if-match-invalid");
  return Number(m[1]);
};

/**
 * Seller Center listing editor (the 4-step "Add a product" wizard). Store tenant: X-Store-Id, passkey session, role from
 * @outlet/policy SELLER_POLICY. Production store memberships are still Unconfigured (every route answers 404 until the
 * store_members adapter is wired); tests use InMemoryStoreMemberships.
 */
@Controller("v1/:market/seller")
export class SellerCatalogController {
  constructor(@Inject(API_DEPS) private readonly deps: ApiDeps) {}

  @Get("products")
  @Paginated()
  @Authorize("listing.read", activeStore, { tenant: "store" })
  @RateLimit({ budget: RATE_BUDGETS.sellerRead })
  @Contract({
    operationId: "listSellerProducts",
    summary: "My listings",
    tags: ["Seller Listings"],
    query: SellerProductsQuery,
    response: SellerProductSummaryPage,
    maxQueries: 2,
  })
  list(@Ctx() s: RequestState, @Query() q: SellerProductsQuery): Promise<z.output<typeof SellerProductSummaryPage>> {
    const t = tenant(s, this.deps);
    return t.catalog.listings.listOwn(t.principal, t.storeId, { ...(q.cursor === undefined ? {} : { cursor: q.cursor }), limit: q.limit, ...(q.status === undefined ? {} : { status: q.status }) });
  }

  @Get("products/:product_id")
  @Authorize("listing.read", activeStore, { tenant: "store" })
  @RateLimit({ budget: RATE_BUDGETS.sellerRead })
  @Contract({
    operationId: "getSellerProduct",
    summary: "One listing (the body carries the `version` used as If-Match)",
    tags: ["Seller Listings"],
    params: ProductIdParams,
    response: SellerProduct,
    maxQueries: 6,
  })
  get(@Ctx() s: RequestState, @Params() p: ProductIdParams): Promise<SellerProduct> {
    const t = tenant(s, this.deps);
    return t.catalog.listings.get(t.principal, t.storeId, p.product_id);
  }

  @Get("products/:product_id/readiness")
  @Authorize("listing.read", activeStore, { tenant: "store" })
  @RateLimit({ budget: RATE_BUDGETS.sellerRead })
  @Contract({
    operationId: "getProductReadiness",
    summary: "Review step: what would block publishing, as reason codes",
    tags: ["Seller Listings"],
    params: ProductIdParams,
    response: PublishResult,
    maxQueries: 8,
  })
  readiness(@Ctx() s: RequestState, @Params() p: ProductIdParams): Promise<PublishResult> {
    const t = tenant(s, this.deps);
    return t.catalog.listings.readiness(t.principal, t.storeId, p.product_id);
  }

  @Patch("products/:product_id")
  @Authorize("listing.write", activeStore, { tenant: "store" })
  @RateLimit({ budget: RATE_BUDGETS.sellerWrite })
  @Contract({
    operationId: "patchSellerProduct",
    summary: "Autosave: photos and condition, details and price in one call (If-Match = version)",
    tags: ["Seller Listings"],
    params: ProductIdParams,
    body: ProductPatch,
    response: SellerProduct,
    // Up to three sections, each its own catalog transaction, plus the final read and the two idempotency statements.
    maxQueries: 32,
  })
  async patch(@Ctx() s: RequestState, @Req() req: ApiRequest, @Params() p: ProductIdParams, @Body() body: ProductPatch): Promise<SellerProduct> {
    const t = tenant(s, this.deps);
    const { listings, variants } = t.catalog;
    let version = versionOf(req, true) ?? 0;
    // Sections apply in a fixed order; a failing section leaves the earlier ones saved (the client re-reads and retries).
    if (body.condition !== undefined) {
      version = (await listings.setConditionAndMedia(t.principal, t.storeId, p.product_id, version, body.condition)).version;
    }
    if (body.details !== undefined) {
      await listings.updateDetails(t.principal, t.storeId, p.product_id, version, body.details);
    }
    if (body.price !== undefined) {
      const skus = await variants.list(t.principal, t.storeId, p.product_id);
      const first = skus.find((k) => k.status === "active");
      if (first === undefined) await variants.create(t.principal, t.storeId, p.product_id, { seller_sku: body.price.seller_sku ?? `SKU-${p.product_id.slice(0, 8)}`, option_values: {}, price: body.price.price });
      else await variants.update(t.principal, t.storeId, p.product_id, first.id, first.version, { price: body.price.price });
    }
    return listings.get(t.principal, t.storeId, p.product_id);
  }

  @Post("products/:product_id/media")
  @HttpCode(201)
  @Authorize("listing.write", activeStore, { tenant: "store" })
  @RateLimit({ budget: RATE_BUDGETS.sellerWrite })
  @Contract({
    operationId: "uploadSellerProductMedia",
    summary: "Upload one photo (multipart: field `kind` first, then `file`; image/jpeg|png|webp|heic, up to 10 MB)",
    tags: ["Seller Listings"],
    params: ProductIdParams,
    body: MediaUploadForm,
    response: MediaUploadResult,
    status: 201,
    maxQueries: 10,
  })
  async uploadMedia(@Ctx() s: RequestState, @Req() req: ApiRequest, @Params() p: ProductIdParams): Promise<MediaUploadResult> {
    const t = tenant(s, this.deps);
    // 404 for a foreign or unknown listing before any byte is read or stored.
    await t.catalog.listings.get(t.principal, t.storeId, p.product_id);
    if (!req.isMultipart()) throw Problems.unsupportedMediaType();
    const part: MultipartFile | undefined = await req.file({ limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 2, parts: 3 } });
    if (part === undefined) throw Problems.badRequest("file-required");
    const field = part.fields.kind;
    const rawKind = field !== undefined && !Array.isArray(field) && field.type === "field" ? field.value : undefined;
    const kind = MediaUploadKind.safeParse(rawKind);
    if (!kind.success) throw Problems.validation([{ path: "/body/kind", code: "invalid_value" }]);
    const bytes = await part.toBuffer();
    const asset = await t.catalog.media.ingest({ bytes, declaredMime: part.mimetype, kind: kind.data, actor: t.principal, storeId: t.storeId });
    if (asset.status !== "ready") throw Problems.unprocessable("media-rejected", [{ path: "/body/file", code: "media_rejected" }]);
    return { media_id: asset.id, kind: kind.data, status: asset.status, width: asset.width, height: asset.height, url: `/media/${asset.id}` };
  }

  @Post("products/:product_id/defect-cards")
  @HttpCode(201)
  @Authorize("listing.write", activeStore, { tenant: "store" })
  @RateLimit({ budget: RATE_BUDGETS.sellerWrite })
  @Contract({
    operationId: "createSellerDefectCard",
    summary: "Record the defect card (a new immutable version) for the listing's condition grade (If-Match = version)",
    tags: ["Seller Listings"],
    params: ProductIdParams,
    body: DefectCardBody,
    response: DefectCardResult,
    status: 201,
    maxQueries: 12,
  })
  createDefectCard(@Ctx() s: RequestState, @Req() req: ApiRequest, @Params() p: ProductIdParams, @Body() body: DefectCardBody): Promise<DefectCardResult> {
    const t = tenant(s, this.deps);
    return t.catalog.defects.putDefectCard(t.principal, t.storeId, p.product_id, versionOf(req, true) ?? 0, body).then((defect_card) => ({ defect_card }));
  }

  @Post("products/:product_id/publish")
  @HttpCode(200)
  @Authorize("listing.write", activeStore, { tenant: "store" })
  @RateLimit({ budget: RATE_BUDGETS.sellerWrite })
  @Contract({
    operationId: "publishProduct",
    summary: "Publish; 409 `activation-blocked` lists every unmet requirement",
    tags: ["Seller Listings"],
    params: ProductIdParams,
    body: PublishBody,
    response: PublishResult,
    maxQueries: 30,
  })
  async publish(@Ctx() s: RequestState, @Req() req: ApiRequest, @Params() p: ProductIdParams): Promise<PublishResult> {
    const t = tenant(s, this.deps);
    const given = versionOf(req, false);
    const version = given ?? (await t.catalog.listings.get(t.principal, t.storeId, p.product_id)).version;
    try {
      const live = await t.catalog.listings.activate(t.principal, t.storeId, p.product_id, version);
      return { product_id: live.id, status: live.status === "PUBLISHED" ? "PUBLISHED" : "IN_REVIEW", blocked_reasons: [] };
    } catch (e) {
      if (e instanceof Error && "code" in e && e.code === "activation_blocked" && "details" in e && Array.isArray(e.details)) {
        throw new ProblemError(409, "activation-blocked", "Listing cannot be published yet", {
          errors: (e.details as string[]).slice(0, 50).map((d) => ({ path: "/", code: d })),
        });
      }
      throw e;
    }
  }

  @Get("categories")
  @Paginated()
  @Authorize("listing.read", activeStore, { tenant: "store" })
  @RateLimit({ budget: RATE_BUDGETS.sellerRead })
  @Contract({
    operationId: "listSellerCategories",
    summary: "Categories a listing can use in this market (path order)",
    tags: ["Seller Listings"],
    query: CategoriesQuery,
    response: CategoryEntryPage,
    maxQueries: 1,
  })
  categories(@Ctx() s: RequestState, @Req() req: ApiRequest, @Query() q: CategoriesQuery): Promise<CategoryEntryPage> {
    const t = tenant(s, this.deps);
    const locale = /^\s*en\b/i.test(headerValue(req, "accept-language") ?? "") ? "en" : "ar";
    return t.catalog.discovery.listCategories(q, locale);
  }

  @Get("attribute-sets/:category_id")
  @Authorize("listing.read", activeStore, { tenant: "store" })
  @RateLimit({ budget: RATE_BUDGETS.sellerRead })
  @Contract({
    operationId: "getSellerAttributeSet",
    summary: "Attributes (and which are required) for a category",
    tags: ["Seller Listings"],
    params: CategoryIdParams,
    response: AttributeSetResult,
    maxQueries: 3,
  })
  attributeSet(@Ctx() s: RequestState, @Params() p: z.infer<typeof CategoryIdParams>): Promise<AttributeSetResult> {
    const t = tenant(s, this.deps);
    return t.catalog.attributeSets.forCategory(p.category_id);
  }
}
