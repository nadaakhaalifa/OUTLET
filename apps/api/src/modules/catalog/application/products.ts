import {
  CatalogValidationError,
  InvalidListingTransitionError,
  allowedListingEvents,
  applyProductPatch,
  buildPublicProductView,
  createProduct,
  gtinVariantKey,
  nextListingStatus,
  publishBlockers,
  validateProductDraft,
  type Issue,
  type ListingEvent,
  type ListingStatus,
  type Product,
  type ProductDraft,
  type ProductPatch,
  type PublicProductView,
} from "../domain/catalog-domain";
import type {
  CatalogClock,
  CatalogEvent,
  CatalogEventPublisher,
  CatalogIds,
  CategoryRecord,
  MediaUrl,
  MediaUrlResolver,
  PriceBlockReader,
  ProductPage,
  ProductRepository,
  SizeChartStatusReader,
  StockLevel,
  StockReader,
  StockSeeder,
  StoreProfile,
  StoreReader,
  TaxonomyRepository,
  UploadReader,
} from "../domain/ports";

export interface CatalogDeps {
  readonly products: ProductRepository;
  readonly taxonomy: TaxonomyRepository;
  readonly uploads: UploadReader;
  readonly stock: StockReader;
  readonly stockSeeder: StockSeeder;
  readonly prices: PriceBlockReader;
  readonly stores: StoreReader;
  readonly sizeCharts: SizeChartStatusReader;
  readonly media: MediaUrlResolver;
  readonly events: CatalogEventPublisher;
  readonly clock: CatalogClock;
  readonly ids: CatalogIds;
}

export type CreateProductResult =
  | { readonly kind: "ok"; readonly product: Product; readonly levels: ReadonlyMap<string, StockLevel> }
  | { readonly kind: "invalid"; readonly issues: readonly Issue[] }
  | { readonly kind: "conflict"; readonly code: "gtin_conflict" };

/** Shared by single create and bulk import so both apply the same checks in the same order. */
export async function checkReferences(
  deps: Pick<CatalogDeps, "taxonomy" | "uploads" | "sizeCharts">,
  storeId: string,
  d: ProductDraft,
): Promise<{ issues: Issue[]; category: CategoryRecord | null }> {
  const issues: Issue[] = [];
  const category = await deps.taxonomy.categoryById(d.categoryId);
  if (category === null) issues.push({ pointer: "/category_id", code: "category_not_found" });
  else if (!category.active) issues.push({ pointer: "/category_id", code: "category_inactive" });
  if (d.brandId !== undefined && (await deps.taxonomy.brandById(d.brandId)) === null) {
    issues.push({ pointer: "/brand_id", code: "brand_not_found" });
  }
  const ids = [...new Set([...d.imageUploadIds, ...d.defectPhotoUploadIds])];
  if (ids.length > 0) {
    const owned = await deps.uploads.ownedBy(storeId, ids);
    d.imageUploadIds.forEach((id, i) => {
      if (!owned.has(id)) issues.push({ pointer: `/image_upload_ids/${i}`, code: "upload_not_found" });
    });
    d.defectPhotoUploadIds.forEach((id, i) => {
      if (!owned.has(id)) issues.push({ pointer: `/defect_photo_upload_ids/${i}`, code: "upload_not_found" });
    });
  }
  if (d.sizeChartId !== undefined && (await deps.sizeCharts.status(storeId, d.sizeChartId)) === "none") {
    issues.push({ pointer: "/size_chart_id", code: "invalid_value" });
  }
  return { issues, category };
}

export class CreateProduct {
  constructor(private readonly deps: CatalogDeps) {}

  async execute(input: { storeId: string; actorId: string; draft: ProductDraft }): Promise<CreateProductResult> {
    const { storeId, actorId, draft } = input;
    const structural = validateProductDraft(draft);
    const refs = await checkReferences(this.deps, storeId, draft);
    const issues = [...structural, ...refs.issues];
    if (issues.length > 0) return { kind: "invalid", issues };

    const taken = await this.deps.products.takenGtinVariants(storeId);
    for (const s of draft.skus) {
      if (s.gtin !== undefined && taken.has(gtinVariantKey(s.gtin, s.color, s.sizeLabel))) {
        return { kind: "conflict", code: "gtin_conflict" };
      }
    }
    const product = await this.persist(storeId, actorId, draft);
    const levels = await this.deps.stock.levels(product.skus.map((s) => s.id));
    return { kind: "ok", product, levels };
  }

  /** Domain construction, insert, stock seeding, outbox. Caller has already validated references. */
  async persist(storeId: string, actorId: string, draft: ProductDraft): Promise<Product> {
    const nowMs = this.deps.clock.nowMs();
    const product = createProduct(draft, { storeId, nowMs, newId: () => this.deps.ids.uuidV7() });
    await this.deps.products.insert(product);
    // Stock is owned by inventory; creation only seeds the opening quantity.
    for (let i = 0; i < product.skus.length; i += 1) {
      const qty = draft.skus[i]?.initialStock;
      const sku = product.skus[i];
      if (qty !== undefined && qty > 0 && sku !== undefined) await this.deps.stockSeeder.seed(storeId, sku.id, qty);
    }
    await this.deps.events.publish([
      {
        name: "product.created",
        productId: product.id,
        storeId,
        skuIds: product.skus.map((s) => s.id),
        version: product.version,
        status: product.status,
        actorId,
        occurredAtMs: nowMs,
      },
    ]);
    return product;
  }
}

export type SellerProductView = { readonly product: Product; readonly levels: ReadonlyMap<string, StockLevel> };

export class GetSellerProduct {
  constructor(private readonly deps: CatalogDeps) {}
  /** Only after the policy guard has authorised the product's tenant (resource authorization). */
  async executeAuthorised(productId: string): Promise<SellerProductView | null> {
    const product = await this.deps.products.findById(productId);
    if (product === null) return null;
    return { product, levels: await this.deps.stock.levels(product.skus.map((s) => s.id)) };
  }
  async execute(storeId: string, productId: string): Promise<SellerProductView | null> {
    const product = await this.deps.products.findInStore(storeId, productId);
    if (product === null) return null;
    return { product, levels: await this.deps.stock.levels(product.skus.map((s) => s.id)) };
  }
}

export interface ListInput {
  readonly storeId: string;
  readonly cursor: { readonly createdAtMs: number; readonly id: string } | null;
  readonly limit: number;
}

export class ListSellerProducts {
  constructor(private readonly deps: CatalogDeps) {}
  async execute(input: ListInput): Promise<{ page: ProductPage; levels: ReadonlyMap<string, StockLevel> }> {
    const page = await this.deps.products.listByStore(input.storeId, input.cursor, input.limit);
    const levels = await this.deps.stock.levels(page.items.flatMap((p) => p.skus.map((s) => s.id)));
    return { page, levels };
  }
}

export type UpdateProductResult =
  | { readonly kind: "ok"; readonly product: Product; readonly levels: ReadonlyMap<string, StockLevel> }
  | { readonly kind: "not_found" }
  | { readonly kind: "invalid"; readonly issues: readonly Issue[] }
  | { readonly kind: "invalid_transition"; readonly from: ListingStatus }
  | { readonly kind: "stale" };

export interface UpdateInput {
  readonly storeId: string;
  readonly productId: string;
  readonly actorId: string;
  readonly expectedVersion: number;
  readonly patch: ProductPatch;
  /** Seller may only ask for these two. */
  readonly status?: "active" | "paused";
}

export class UpdateProduct {
  constructor(private readonly deps: CatalogDeps) {}

  async execute(input: UpdateInput): Promise<UpdateProductResult> {
    const current = await this.deps.products.findInStore(input.storeId, input.productId);
    if (current === null) return { kind: "not_found" };
    if (current.version !== input.expectedVersion) return { kind: "stale" };
    if (current.status === "delisted") return { kind: "invalid_transition", from: current.status };

    // Plan the status change first so an illegal request fails before anything is built.
    let event: ListingEvent | null = null;
    if (input.status !== undefined && input.status !== current.status) {
      event = input.status === "paused" ? "pause" : current.status === "draft" ? "publish" : "resume";
      if (!allowedListingEvents(current.status, "seller").includes(event)) {
        return { kind: "invalid_transition", from: current.status };
      }
    }

    // References touched by the patch.
    const touched: ProductDraft = {
      title: current.title,
      categoryId: current.categoryId,
      condition: input.patch.condition ?? current.condition,
      imageUploadIds: input.patch.imageUploadIds ?? current.imageUploadIds,
      defectPhotoUploadIds: current.defectPhotoUploadIds,
      ...(input.patch.sizeChartId !== undefined ? { sizeChartId: input.patch.sizeChartId } : {}),
      skus: [],
    };
    const refIssues: Issue[] = [];
    if (input.patch.imageUploadIds !== undefined) {
      const owned = await this.deps.uploads.ownedBy(input.storeId, input.patch.imageUploadIds);
      input.patch.imageUploadIds.forEach((id, i) => {
        if (!owned.has(id)) refIssues.push({ pointer: `/image_upload_ids/${i}`, code: "upload_not_found" });
      });
    }
    if (touched.sizeChartId !== undefined && (await this.deps.sizeCharts.status(input.storeId, touched.sizeChartId)) === "none") {
      refIssues.push({ pointer: "/size_chart_id", code: "invalid_value" });
    }
    if (refIssues.length > 0) return { kind: "invalid", issues: refIssues };

    const nowMs = this.deps.clock.nowMs();
    let next: Product;
    try {
      next = Object.keys(input.patch).length > 0 ? applyProductPatch(current, input.patch, nowMs) : { ...current, version: current.version + 1, updatedAtMs: nowMs };
    } catch (e) {
      if (e instanceof CatalogValidationError) return { kind: "invalid", issues: e.issues };
      throw e;
    }

    if (event !== null) {
      if (event === "publish" || event === "resume") {
        const category = await this.deps.taxonomy.categoryById(next.categoryId);
        const chart = next.sizeChartId === undefined ? "none" : await this.deps.sizeCharts.status(next.storeId, next.sizeChartId);
        const blockers = publishBlockers({
          titleAr: next.title.ar,
          descriptionAr: next.description?.ar,
          condition: next.condition,
          imageCount: next.imageUploadIds.length,
          defectPhotoCount: next.defectPhotoUploadIds.length,
          pricedSkuCount: next.skus.filter((s) => s.price.amount > 0n && s.status === "active").length,
          categoryRequiresSizeChart: category?.requiresSizeChart ?? false,
          sizeChartStatus: chart,
        });
        if (blockers.length > 0) return { kind: "invalid", issues: blockers };
      }
      try {
        const to = nextListingStatus(current.status, event, "seller");
        next = { ...next, status: to, ...(to === "active" && next.publishedAtMs === undefined ? { publishedAtMs: nowMs } : {}) };
      } catch (e) {
        if (e instanceof InvalidListingTransitionError) return { kind: "invalid_transition", from: current.status };
        throw e;
      }
    }

    const ok = await this.deps.products.replace(next, input.expectedVersion);
    if (!ok) return { kind: "stale" };

    const base = { productId: next.id, storeId: next.storeId, version: next.version, actorId: input.actorId, occurredAtMs: nowMs } as const;
    const events: CatalogEvent[] = [{ name: "product.updated", ...base, status: next.status }];
    if (next.status !== current.status) {
      events.push({ name: "product.status_changed", ...base, from: current.status, to: next.status });
    }
    await this.deps.events.publish(events);
    return { kind: "ok", product: next, levels: await this.deps.stock.levels(next.skus.map((s) => s.id)) };
  }
}

export interface PublicProduct {
  readonly view: PublicProductView;
  readonly store: StoreProfile;
  readonly images: readonly MediaUrl[];
  readonly defectPhotos: readonly MediaUrl[];
}

/** Public read model. Every call reads price, stock and price block from their owners. Nothing is cached here. */
export class GetPublicProduct {
  constructor(private readonly deps: CatalogDeps) {}

  async execute(productId: string, viewerUserId: string): Promise<PublicProduct | null> {
    const product = await this.deps.products.findById(productId);
    if (product === null || product.status !== "active") return null;
    const store = await this.deps.stores.profile(product.storeId, viewerUserId);
    if (store === null || !store.visible) return null;
    const category = await this.deps.taxonomy.categoryById(product.categoryId);
    const skuIds = product.skus.map((s) => s.id);
    const stock = await this.safe(() => this.deps.stock.levels(skuIds), new Map<string, StockLevel>());
    const prices = await this.safe(() => this.deps.prices.blocks(skuIds), new Map());
    const chart =
      product.sizeChartId === undefined ? "none" : await this.safe(() => this.deps.sizeCharts.status(product.storeId, product.sizeChartId ?? ""), "none" as const);
    const view = buildPublicProductView({
      product,
      returnClass: category?.returnClass ?? "standard",
      seller: store.legal,
      stock: new Map([...stock].map(([k, v]) => [k, v.available])),
      priceBlocks: prices,
      sizeChartValidated: chart === "validated",
    });
    if (view === null) return null;
    const ids = [...product.imageUploadIds, ...(product.condition === "minor_defect" ? product.defectPhotoUploadIds : [])];
    const urls = await this.safe(() => this.deps.media.resolve(ids), new Map<string, MediaUrl>());
    const pick = (list: readonly string[]): MediaUrl[] => list.flatMap((id) => {
      const u = urls.get(id);
      return u === undefined ? [] : [u];
    });
    return {
      view,
      store,
      images: pick(product.imageUploadIds),
      defectPhotos: product.condition === "minor_defect" ? pick(product.defectPhotoUploadIds) : [],
    };
  }

  /** A failing dependency degrades the page (no claims, nothing purchasable) instead of failing it. */
  private async safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await fn();
    } catch {
      return fallback;
    }
  }
}
