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
  ProductImageJobs,
  ProductImageVariant,
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
  /** Background-removal jobs (product-media module). Absent: `media_job_id` is refused with 503. */
  readonly imageJobs?: ProductImageJobs | undefined;
}

export type MediaJobIssueCode = "media_job_not_found" | "media_job_not_decided" | "media_job_attached_elsewhere" | "media_unavailable";

/** A job reference that cannot be honoured. `index` is the position in the request's image list. */
export class MediaJobError extends Error {
  override readonly name = "MediaJobError";
  constructor(
    readonly code: MediaJobIssueCode,
    readonly index: number,
  ) {
    super(code);
  }
}

/**
 * Claims every job (compare-and-set attach + promotion) in request order. All-or-nothing: on the first failure the
 * jobs this call newly attached are released and a MediaJobError is thrown.
 */
async function claimJobs(
  deps: Pick<CatalogDeps, "imageJobs">,
  storeId: string,
  productId: string,
  imageIds: readonly string[],
  jobIds: ReadonlySet<string>,
): Promise<{ variants: ProductImageVariant[]; fresh: string[] }> {
  const variants: ProductImageVariant[] = [];
  const fresh: string[] = [];
  if (jobIds.size === 0) return { variants, fresh };
  const port = deps.imageJobs;
  const first = imageIds.findIndex((id) => jobIds.has(id));
  if (port === undefined) throw new MediaJobError("media_unavailable", Math.max(first, 0));
  for (let i = 0; i < imageIds.length; i += 1) {
    const id = imageIds[i];
    if (id === undefined || !jobIds.has(id)) continue;
    let r;
    try {
      r = await port.claim(storeId, productId, id);
    } catch {
      r = { kind: "storage_unavailable" } as const;
    }
    if (r.kind !== "ok") {
      await port.release(storeId, productId, fresh).catch(() => undefined);
      const code: MediaJobIssueCode =
        r.kind === "not_found" ? "media_job_not_found" : r.kind === "not_decided" ? "media_job_not_decided" : r.kind === "attached_elsewhere" ? "media_job_attached_elsewhere" : "media_unavailable";
      throw new MediaJobError(code, i);
    }
    variants.push({ jobId: r.image.jobId, imageRef: r.image.imageRef, cutoutRef: r.image.cutoutRef });
    if (r.image.newlyClaimed) fresh.push(id);
  }
  return { variants, fresh };
}

export type CreateProductResult =
  | { readonly kind: "ok"; readonly product: Product; readonly levels: ReadonlyMap<string, StockLevel>; readonly mediaJobIds: readonly string[] }
  | { readonly kind: "media_job"; readonly code: MediaJobIssueCode; readonly index: number }
  | { readonly kind: "invalid"; readonly issues: readonly Issue[] }
  | { readonly kind: "conflict"; readonly code: "gtin_conflict" };

/** Shared by single create and bulk import so both apply the same checks in the same order. */
export async function checkReferences(
  deps: Pick<CatalogDeps, "taxonomy" | "uploads" | "sizeCharts">,
  storeId: string,
  d: ProductDraft,
  jobIds: ReadonlySet<string> = new Set(),
): Promise<{ issues: Issue[]; category: CategoryRecord | null }> {
  const issues: Issue[] = [];
  const category = await deps.taxonomy.categoryById(d.categoryId);
  if (category === null) issues.push({ pointer: "/category_id", code: "category_not_found" });
  else if (!category.active) issues.push({ pointer: "/category_id", code: "category_inactive" });
  if (d.brandId !== undefined && (await deps.taxonomy.brandById(d.brandId)) === null) {
    issues.push({ pointer: "/brand_id", code: "brand_not_found" });
  }
  const ids = [...new Set([...d.imageUploadIds.filter((id) => !jobIds.has(id)), ...d.defectPhotoUploadIds])];
  if (ids.length > 0) {
    const owned = await deps.uploads.ownedBy(storeId, ids);
    d.imageUploadIds.forEach((id, i) => {
      if (!jobIds.has(id) && !owned.has(id)) issues.push({ pointer: `/image_upload_ids/${i}`, code: "upload_not_found" });
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

  async execute(input: { storeId: string; actorId: string; draft: ProductDraft; mediaJobIds?: readonly string[] }): Promise<CreateProductResult> {
    const { storeId, actorId, draft } = input;
    const jobIds = new Set(input.mediaJobIds ?? []);
    const structural = validateProductDraft(draft);
    const refs = await checkReferences(this.deps, storeId, draft, jobIds);
    const issues = [...structural, ...refs.issues];
    if (issues.length > 0) return { kind: "invalid", issues };

    const taken = await this.deps.products.takenGtinVariants(storeId);
    for (const s of draft.skus) {
      if (s.gtin !== undefined && taken.has(gtinVariantKey(s.gtin, s.color, s.sizeLabel))) {
        return { kind: "conflict", code: "gtin_conflict" };
      }
    }
    let product: Product;
    try {
      product = await this.persist(storeId, actorId, draft, jobIds);
    } catch (e) {
      if (e instanceof MediaJobError) return { kind: "media_job", code: e.code, index: e.index };
      throw e;
    }
    const levels = await this.deps.stock.levels(product.skus.map((s) => s.id));
    return { kind: "ok", product, levels, mediaJobIds: product.imageUploadIds.filter((id) => jobIds.has(id)) };
  }

  /** Domain construction, insert, stock seeding, outbox. Caller has already validated references. */
  async persist(storeId: string, actorId: string, draft: ProductDraft, jobIds: ReadonlySet<string> = new Set()): Promise<Product> {
    const nowMs = this.deps.clock.nowMs();
    const product = createProduct(draft, { storeId, nowMs, newId: () => this.deps.ids.uuidV7() });
    // Attach the cutout jobs to the new product id first (compare-and-set), so a job backs one product only.
    const claim = await claimJobs(this.deps, storeId, product.id, product.imageUploadIds, jobIds);
    const event: CatalogEvent = {
      name: "product.created",
      productId: product.id,
      storeId,
      skuIds: product.skus.map((s) => s.id),
      version: product.version,
      status: product.status,
      actorId,
      occurredAtMs: nowMs,
    };
    // The event is appended to the outbox inside the insert transaction.
    try {
      await this.deps.products.insert(product, [event], claim.variants);
    } catch (e) {
      await this.deps.imageJobs?.release(storeId, product.id, claim.fresh).catch(() => undefined);
      throw e;
    }
    // Stock is owned by inventory; creation only seeds the opening quantity.
    for (let i = 0; i < product.skus.length; i += 1) {
      const qty = draft.skus[i]?.initialStock;
      const sku = product.skus[i];
      if (qty !== undefined && qty > 0 && sku !== undefined) await this.deps.stockSeeder.seed(storeId, sku.id, qty);
    }
    return product;
  }
}

export type SellerProductView = {
  readonly product: Product;
  readonly levels: ReadonlyMap<string, StockLevel>;
  /** Job ids among `product.imageUploadIds` (background-removal cutouts). */
  readonly mediaJobIds: readonly string[];
};

async function jobIdsOf(deps: Pick<CatalogDeps, "products">, productIds: readonly string[]): Promise<ReadonlyMap<string, readonly string[]>> {
  const v = await deps.products.imageVariants(productIds);
  return new Map([...v].map(([id, list]) => [id, list.map((x) => x.jobId)]));
}

export class GetSellerProduct {
  constructor(private readonly deps: CatalogDeps) {}
  /** Only after the policy guard has authorised the product's tenant (resource authorization). */
  async executeAuthorised(productId: string): Promise<SellerProductView | null> {
    const product = await this.deps.products.findById(productId);
    if (product === null) return null;
    return { product, levels: await this.deps.stock.levels(product.skus.map((s) => s.id)), mediaJobIds: (await jobIdsOf(this.deps, [product.id])).get(product.id) ?? [] };
  }
  async execute(storeId: string, productId: string): Promise<SellerProductView | null> {
    const product = await this.deps.products.findInStore(storeId, productId);
    if (product === null) return null;
    return { product, levels: await this.deps.stock.levels(product.skus.map((s) => s.id)), mediaJobIds: (await jobIdsOf(this.deps, [product.id])).get(product.id) ?? [] };
  }
}

export interface ListInput {
  readonly storeId: string;
  readonly cursor: { readonly createdAtMs: number; readonly id: string } | null;
  readonly limit: number;
}

export class ListSellerProducts {
  constructor(private readonly deps: CatalogDeps) {}
  async execute(input: ListInput): Promise<{ page: ProductPage; levels: ReadonlyMap<string, StockLevel>; mediaJobIds: ReadonlyMap<string, readonly string[]> }> {
    const page = await this.deps.products.listByStore(input.storeId, input.cursor, input.limit);
    const levels = await this.deps.stock.levels(page.items.flatMap((p) => p.skus.map((s) => s.id)));
    return { page, levels, mediaJobIds: await jobIdsOf(this.deps, page.items.map((p) => p.id)) };
  }
}

/** Active categories a seller may pick when creating a product (taxonomy is platform-owned). */
export class ListSellerCategories {
  constructor(private readonly deps: Pick<CatalogDeps, "taxonomy">) {}
  async execute(): Promise<readonly CategoryRecord[]> {
    const all = await this.deps.taxonomy.allCategories();
    return all.filter((c) => c.active);
  }
}

export type UpdateProductResult =
  | { readonly kind: "ok"; readonly product: Product; readonly levels: ReadonlyMap<string, StockLevel>; readonly mediaJobIds: readonly string[] }
  | { readonly kind: "not_found" }
  | { readonly kind: "invalid"; readonly issues: readonly Issue[] }
  | { readonly kind: "invalid_transition"; readonly from: ListingStatus }
  | { readonly kind: "media_job"; readonly code: MediaJobIssueCode; readonly index: number }
  | { readonly kind: "stale" };

export interface UpdateInput {
  readonly storeId: string;
  readonly productId: string;
  readonly actorId: string;
  readonly expectedVersion: number;
  readonly patch: ProductPatch;
  /** Job ids among `patch.imageUploadIds` (background-removal cutouts). */
  readonly mediaJobIds?: readonly string[];
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
      department: input.patch.department ?? current.department,
      imageUploadIds: input.patch.imageUploadIds ?? current.imageUploadIds,
      defectPhotoUploadIds: current.defectPhotoUploadIds,
      ...(input.patch.sizeChartId !== undefined ? { sizeChartId: input.patch.sizeChartId } : {}),
      skus: [],
    };
    const refIssues: Issue[] = [];
    if (input.patch.imageUploadIds !== undefined) {
      const jobIds = new Set(input.mediaJobIds ?? []);
      const plain = input.patch.imageUploadIds.filter((id) => !jobIds.has(id));
      const owned = plain.length === 0 ? new Set<string>() : await this.deps.uploads.ownedBy(input.storeId, plain);
      input.patch.imageUploadIds.forEach((id, i) => {
        if (!jobIds.has(id) && !owned.has(id)) refIssues.push({ pointer: `/image_upload_ids/${i}`, code: "upload_not_found" });
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
          titleEn: next.title.en,
          descriptionAr: next.description?.ar,
          condition: next.condition,
          imageCount: next.imageUploadIds.length,
          defectPhotoCount: next.defectPhotoUploadIds.length,
          pricedSkuCount: next.skus.filter((s) => s.price.amount > 0n && s.status === "active").length,
          categoryRequiresSizeChart: category?.requiresSizeChart ?? false,
          sizeChartStatus: chart,
        });
        // Legacy rows may lack an English name: resuming them must not trap them paused (soft deadline, not enforced).
        const effective = event === "resume" ? blockers.filter((b) => b.code !== "title_en_missing") : blockers;
        if (effective.length > 0) return { kind: "invalid", issues: effective };
      }
      try {
        const to = nextListingStatus(current.status, event, "seller");
        next = { ...next, status: to, ...(to === "active" && next.publishedAtMs === undefined ? { publishedAtMs: nowMs } : {}) };
      } catch (e) {
        if (e instanceof InvalidListingTransitionError) return { kind: "invalid_transition", from: current.status };
        throw e;
      }
    }

    const base = { productId: next.id, storeId: next.storeId, version: next.version, actorId: input.actorId, occurredAtMs: nowMs } as const;
    const events: CatalogEvent[] = [{ name: "product.updated", ...base, status: next.status }];
    if (next.status !== current.status) {
      events.push({ name: "product.status_changed", ...base, from: current.status, to: next.status });
    }
    // Cutout variants: carried over unchanged unless the image list is replaced; then the new jobs are attached
    // (compare-and-set) before the write and the dropped ones are freed after it.
    const before = (await this.deps.products.imageVariants([current.id])).get(current.id) ?? [];
    let variants: readonly ProductImageVariant[] = before;
    let fresh: string[] = [];
    if (input.patch.imageUploadIds !== undefined) {
      try {
        const claim = await claimJobs(this.deps, input.storeId, current.id, input.patch.imageUploadIds, new Set(input.mediaJobIds ?? []));
        variants = claim.variants;
        fresh = claim.fresh;
      } catch (e) {
        if (e instanceof MediaJobError) return { kind: "media_job", code: e.code, index: e.index };
        throw e;
      }
    }
    let ok: boolean;
    try {
      ok = await this.deps.products.replace(next, input.expectedVersion, events, variants);
    } catch (e) {
      await this.deps.imageJobs?.release(input.storeId, current.id, fresh).catch(() => undefined);
      throw e;
    }
    if (!ok) {
      await this.deps.imageJobs?.release(input.storeId, current.id, fresh).catch(() => undefined);
      return { kind: "stale" };
    }
    const kept = new Set(variants.map((v) => v.jobId));
    const dropped = before.map((v) => v.jobId).filter((id) => !kept.has(id));
    if (dropped.length > 0) await this.deps.imageJobs?.release(input.storeId, current.id, dropped).catch(() => undefined);
    return { kind: "ok", product: next, levels: await this.deps.stock.levels(next.skus.map((s) => s.id)), mediaJobIds: variants.map((v) => v.jobId) };
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
    const variants = await this.safe(() => this.deps.products.imageVariants([product.id]), new Map<string, readonly ProductImageVariant[]>());
    const byJob = new Map((variants.get(product.id) ?? []).map((v) => [v.jobId, v]));
    const keyOf = (id: string): string => byJob.get(id)?.imageRef ?? id;
    const ids = [
      ...product.imageUploadIds.flatMap((id) => {
        const v = byJob.get(id);
        return v === undefined ? [id] : [v.imageRef, ...(v.cutoutRef !== null ? [v.cutoutRef] : [])];
      }),
      ...(product.condition === "minor_defect" ? product.defectPhotoUploadIds : []),
    ];
    const urls = await this.safe(() => this.deps.media.resolve(ids), new Map<string, MediaUrl>());
    const pick = (list: readonly string[]): MediaUrl[] => list.flatMap((id) => {
      const u = urls.get(keyOf(id));
      if (u === undefined) return [];
      const cutout = byJob.get(id)?.cutoutRef;
      const c = cutout === null || cutout === undefined ? undefined : urls.get(cutout);
      return [c === undefined ? u : { ...u, cutoutUrl: c.url }];
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
