import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Patch, Post, Query, Req, Res } from "@nestjs/common";
import type { Actor } from "@outlet/policy";
import { CursorSchema, MoneySchema, PaginationQuerySchema, UuidSchema } from "@outlet/validation";
import { z } from "zod";
import { AuthenticatedSelf, Authorize, Idempotent, RateLimit } from "../../../platform/decorators";
import { headerValue, type ApiRequest, type ApiResponse } from "../../../platform/http-types";
import { ProblemError, Problems } from "../../../platform/problem";
import { ZodPipe } from "../../../platform/zod.pipe";
import type { CreateImport, GetImport } from "../application/imports";
import type { CreateProduct, GetPublicProduct, GetSellerProduct, ListSellerProducts, UpdateProduct } from "../application/products";
import type { Condition, ProductDraft, ProductPatch, SkuDraft } from "../domain/catalog-domain";
import {
  CREATE_IMPORT,
  CREATE_PRODUCT,
  GET_IMPORT,
  GET_PUBLIC_PRODUCT,
  GET_SELLER_PRODUCT,
  IMPORT_RESOLVER,
  LIST_SELLER_PRODUCTS,
  PRODUCT_RESOLVER,
  UPDATE_PRODUCT,
} from "./tokens";
import { StoreAccess } from "./store-access";
import { importWire, issuesToViolations, publicEtag, publicProductWire, sellerEtag, sellerProductWire } from "./wire";

const CONDITION = z.enum(["new_with_tags", "new_without_tags", "sample", "minor_defect"]);
const LocalizedIn = z.strictObject({ ar: z.string().min(1).max(2000), en: z.string().max(2000).optional() });

const CreateSchema = z.strictObject({
  title: LocalizedIn,
  description: LocalizedIn.optional(),
  category_id: UuidSchema,
  brand_id: UuidSchema.optional(),
  condition: CONDITION,
  material: z.string().max(120).optional(),
  image_upload_ids: z.array(UuidSchema).max(12).optional(),
  defect_photo_upload_ids: z.array(UuidSchema).max(12).optional(),
  size_chart_id: UuidSchema.optional(),
  skus: z
    .array(
      z.strictObject({
        seller_sku: z.string().max(64).optional(),
        barcode_gtin: z.string().max(14).optional(),
        size_label: z.string().min(1).max(20),
        color: z.string().max(40).optional(),
        price: MoneySchema,
        initial_stock: z.number().int().min(0).max(100_000).optional(),
      }),
    )
    .min(1)
    .max(100),
});

const UpdateSchema = z
  .strictObject({
    title: LocalizedIn.optional(),
    description: LocalizedIn.optional(),
    status: z.enum(["active", "paused"]).optional(),
    condition: CONDITION.optional(),
    material: z.string().max(120).optional(),
    size_chart_id: UuidSchema.optional(),
    image_upload_ids: z.array(UuidSchema).max(12).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "at least one property is required" });

const ImportSchema = z.strictObject({ upload_id: UuidSchema, dry_run: z.boolean().default(true) });

const ProductIdPipe = new ZodPipe(UuidSchema, "/params");

function localized(v: { ar: string; en?: string | undefined }): { ar: string; en?: string } {
  return { ar: v.ar, ...(v.en !== undefined ? { en: v.en } : {}) };
}

function toDraft(b: z.output<typeof CreateSchema>): ProductDraft {
  return {
    title: localized(b.title),
    ...(b.description !== undefined ? { description: localized(b.description) } : {}),
    categoryId: b.category_id,
    ...(b.brand_id !== undefined ? { brandId: b.brand_id } : {}),
    condition: b.condition as Condition,
    ...(b.material !== undefined ? { material: b.material } : {}),
    imageUploadIds: b.image_upload_ids ?? [],
    defectPhotoUploadIds: b.defect_photo_upload_ids ?? [],
    ...(b.size_chart_id !== undefined ? { sizeChartId: b.size_chart_id } : {}),
    skus: b.skus.map(
      (s): SkuDraft => ({
        ...(s.seller_sku !== undefined ? { sellerSku: s.seller_sku } : {}),
        ...(s.barcode_gtin !== undefined ? { gtin: s.barcode_gtin } : {}),
        sizeLabel: s.size_label,
        ...(s.color !== undefined ? { color: s.color } : {}),
        price: s.price,
        ...(s.initial_stock !== undefined ? { initialStock: s.initial_stock } : {}),
      }),
    ),
  };
}

function toPatch(b: z.output<typeof UpdateSchema>): ProductPatch {
  return {
    ...(b.title !== undefined ? { title: localized(b.title) } : {}),
    ...(b.description !== undefined ? { description: localized(b.description) } : {}),
    ...(b.condition !== undefined ? { condition: b.condition as Condition } : {}),
    ...(b.material !== undefined ? { material: b.material } : {}),
    ...(b.size_chart_id !== undefined ? { sizeChartId: b.size_chart_id } : {}),
    ...(b.image_upload_ids !== undefined ? { imageUploadIds: b.image_upload_ids } : {}),
  };
}

function actorOf(req: ApiRequest): Actor {
  const a = req.principal?.actor;
  if (a === undefined) throw Problems.unauthenticated();
  return a;
}

function matchesList(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  return header.split(",").some((t) => {
    const v = t.trim();
    return v === "*" || v === etag || v === `W/${etag}`;
  });
}

function unprocessable(slug: string, code: string, issues: readonly { pointer: string; code: string }[]): ProblemError {
  return new ProblemError(422, slug, "The request is well formed but cannot be applied", { code, errors: issues });
}

function encodeCursor(raw: string): string {
  return Buffer.from(raw, "utf8").toString("base64url");
}
function decodeCursor(c: string): { createdAtMs: number; id: string } {
  const raw = Buffer.from(c, "base64url").toString("utf8");
  const m = /^(\d{1,15}):([0-9a-f-]{36})$/.exec(raw);
  if (m === null || m[1] === undefined || m[2] === undefined) throw Problems.validation([{ pointer: "/query/cursor", code: "invalid_cursor" }]);
  return { createdAtMs: Number(m[1]), id: m[2] };
}

@Controller("products")
export class ShopperCatalogController {
  constructor(@Inject(GET_PUBLIC_PRODUCT) private readonly getProduct: GetPublicProduct) {}

  @Get(":productId")
  @AuthenticatedSelf("buyer_api")
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async read(
    @Param("productId", ProductIdPipe) productId: string,
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: ApiResponse,
  ) {
    const viewer = actorOf(req).id;
    const found = await this.getProduct.execute(productId, viewer);
    if (found === null) throw Problems.notFound();
    const wire = publicProductWire(found);
    const etag = publicEtag(wire);
    // Price and stock are live: the response must be revalidated every time.
    res.setHeader("ETag", etag);
    res.setHeader("Cache-Control", "private, no-cache");
    if (matchesList(headerValue(req, "if-none-match"), etag)) throw new ProblemError(304, "not-modified", "Not modified");
    return wire;
  }
}

@Controller("seller")
export class SellerCatalogController {
  constructor(
    @Inject(StoreAccess) private readonly access: StoreAccess,
    @Inject(CREATE_PRODUCT) private readonly createProduct: CreateProduct,
    @Inject(LIST_SELLER_PRODUCTS) private readonly listProducts: ListSellerProducts,
    @Inject(GET_SELLER_PRODUCT) private readonly getProduct: GetSellerProduct,
    @Inject(UPDATE_PRODUCT) private readonly updateProduct: UpdateProduct,
    @Inject(CREATE_IMPORT) private readonly createImport: CreateImport,
    @Inject(GET_IMPORT) private readonly getImport: GetImport,
  ) {}

  @Get("products")
  @AuthenticatedSelf("seller_api")
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async list(
    @Req() req: ApiRequest,
    @Query(new ZodPipe(PaginationQuerySchema, "/query")) q: z.output<typeof PaginationQuerySchema>,
    @Headers("x-store-id") storeHeader: string | undefined,
  ) {
    const storeId = await this.access.resolve(actorOf(req), "read", storeHeader);
    const cursor = q.cursor === undefined ? null : decodeCursor(CursorSchema.parse(q.cursor));
    const { page, levels } = await this.listProducts.execute({ storeId, cursor, limit: q.limit });
    return {
      items: page.items.map((p) => sellerProductWire(p, levels)),
      page: { next_cursor: page.nextCursor === null ? null : encodeCursor(page.nextCursor), has_more: page.nextCursor !== null },
    };
  }

  @Post("products")
  @HttpCode(201)
  @AuthenticatedSelf("seller_api")
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async create(
    @Req() req: ApiRequest,
    @Body(new ZodPipe(CreateSchema)) body: z.output<typeof CreateSchema>,
    @Headers("x-store-id") storeHeader: string | undefined,
  ) {
    const actor = actorOf(req);
    const storeId = await this.access.resolve(actor, "create", storeHeader);
    const result = await this.createProduct.execute({ storeId, actorId: actor.id, draft: toDraft(body) });
    switch (result.kind) {
      case "ok":
        return sellerProductWire(result.product, result.levels);
      case "invalid":
        throw unprocessable("catalog-validation-failed", "catalog_validation_failed", issuesToViolations(result.issues));
      case "conflict":
        throw new ProblemError(409, "gtin-conflict", "A variant with this barcode already exists", { code: result.code });
    }
  }

  @Get("products/:productId")
  @Authorize({ audience: "seller_api", action: "read", resourceType: "store_product", resolver: PRODUCT_RESOLVER, idParam: "productId" })
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async read(
    @Param("productId", ProductIdPipe) productId: string,
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: ApiResponse,
  ) {
    const found = await this.getProduct.executeAuthorised(productId);
    if (found === null) throw Problems.notFound();
    const etag = sellerEtag(found.product, found.levels);
    res.setHeader("ETag", etag);
    res.setHeader("Cache-Control", "private, no-cache");
    if (matchesList(headerValue(req, "if-none-match"), etag)) throw new ProblemError(304, "not-modified", "Not modified");
    return sellerProductWire(found.product, found.levels);
  }

  @Patch("products/:productId")
  @HttpCode(200)
  @Authorize({ audience: "seller_api", action: "update", resourceType: "store_product", resolver: PRODUCT_RESOLVER, idParam: "productId" })
  @Idempotent({ required: false })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async update(
    @Param("productId", ProductIdPipe) productId: string,
    @Req() req: ApiRequest,
    @Body(new ZodPipe(UpdateSchema)) body: z.output<typeof UpdateSchema>,
  ) {
    const actor = actorOf(req);
    const ifMatch = headerValue(req, "if-match");
    if (ifMatch === undefined) {
      throw new ProblemError(428, "precondition-required", "If-Match is required", { code: "precondition_required" });
    }
    const current = await this.getProduct.executeAuthorised(productId);
    if (current === null) throw Problems.notFound();
    if (!matchesList(ifMatch, sellerEtag(current.product, current.levels))) {
      throw new ProblemError(412, "precondition-failed", "The product changed since it was read", { code: "precondition_failed" });
    }
    const result = await this.updateProduct.execute({
      storeId: current.product.storeId,
      productId,
      actorId: actor.id,
      expectedVersion: current.product.version,
      patch: toPatch(body),
      ...(body.status !== undefined ? { status: body.status } : {}),
    });
    switch (result.kind) {
      case "ok":
        return sellerProductWire(result.product, result.levels);
      case "not_found":
        throw Problems.notFound();
      case "stale":
        throw new ProblemError(412, "precondition-failed", "The product changed since it was read", { code: "precondition_failed" });
      case "invalid_transition":
        throw new ProblemError(422, "invalid-transition", "That status change is not allowed", {
          code: "invalid_transition",
          extensions: { from: result.from },
        });
      case "invalid":
        throw unprocessable("catalog-validation-failed", "catalog_validation_failed", issuesToViolations(result.issues));
    }
  }

  @Post("catalog/imports")
  @HttpCode(202)
  @AuthenticatedSelf("seller_api")
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 10, windowSeconds: 3600 }])
  async startImport(
    @Req() req: ApiRequest,
    @Body(new ZodPipe(ImportSchema)) body: z.output<typeof ImportSchema>,
    @Headers("x-store-id") storeHeader: string | undefined,
  ) {
    const actor = actorOf(req);
    const storeId = await this.access.resolve(actor, "create", storeHeader);
    const result = await this.createImport.execute({ storeId, actorId: actor.id, uploadId: body.upload_id, dryRun: body.dry_run });
    if (result.kind === "upload_not_found") {
      throw unprocessable("catalog-validation-failed", "catalog_validation_failed", [{ pointer: "/upload_id", code: "upload_not_found" }]);
    }
    return importWire(result.record);
  }

  @Get("catalog/imports/:importId")
  @Authorize({ audience: "seller_api", action: "read", resourceType: "store_product", resolver: IMPORT_RESOLVER, idParam: "importId" })
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async readImport(@Param("importId", new ZodPipe(UuidSchema, "/params")) importId: string, @Req() req: ApiRequest) {
    void req;
    const r = await this.getImport.executeAuthorised(importId);
    if (r === null) throw Problems.notFound();
    return importWire(r);
  }
}
