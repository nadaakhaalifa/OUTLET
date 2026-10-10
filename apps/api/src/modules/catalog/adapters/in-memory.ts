import type {
  CatalogEvent,
  CatalogEventPublisher,
  CategoryRecord,
  BrandRecord,
  ImportRecord,
  ImportRepository,
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
import { gtinVariantKey, type PriceBlockInput, type Product, type SizeChartStatus } from "../domain/catalog-domain";

/** DEVELOPMENT FIXTURE: lost on restart, single process. Production adapters are Postgres (migration 0012). */
export class InMemoryProductRepository implements ProductRepository {
  private readonly rows = new Map<string, Product>();

  async insert(product: Product): Promise<void> {
    this.rows.set(product.id, product);
  }
  async findInStore(storeId: string, id: string): Promise<Product | null> {
    const p = this.rows.get(id);
    return p !== undefined && p.storeId === storeId ? p : null;
  }
  async findById(id: string): Promise<Product | null> {
    return this.rows.get(id) ?? null;
  }
  async listByStore(
    storeId: string,
    cursor: { readonly createdAtMs: number; readonly id: string } | null,
    limit: number,
  ): Promise<ProductPage> {
    const all = [...this.rows.values()]
      .filter((p) => p.storeId === storeId)
      .sort((a, b) => b.createdAtMs - a.createdAtMs || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    const start =
      cursor === null ? 0 : all.findIndex((p) => p.createdAtMs < cursor.createdAtMs || (p.createdAtMs === cursor.createdAtMs && p.id < cursor.id));
    if (start === -1) return { items: [], nextCursor: null };
    const items = all.slice(start, start + limit);
    const last = items[items.length - 1];
    const more = start + limit < all.length;
    return { items, nextCursor: more && last !== undefined ? `${last.createdAtMs}:${last.id}` : null };
  }
  async replace(next: Product, expectedVersion: number): Promise<boolean> {
    const cur = this.rows.get(next.id);
    if (cur === undefined || cur.version !== expectedVersion) return false;
    this.rows.set(next.id, next);
    return true;
  }
  async takenGtinVariants(storeId: string): Promise<ReadonlySet<string>> {
    const out = new Set<string>();
    for (const p of this.rows.values()) {
      if (p.storeId !== storeId) continue;
      for (const s of p.skus) if (s.gtin !== undefined) out.add(gtinVariantKey(s.gtin, s.color, s.sizeLabel));
    }
    return out;
  }
  /** Test support: number of stored products (for "dry run never mutates"). */
  countForTest(): number {
    return this.rows.size;
  }
  snapshotForTest(): string {
    return JSON.stringify([...this.rows.values()], (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
  }
}

export class InMemoryTaxonomy implements TaxonomyRepository {
  constructor(
    private readonly categories: readonly CategoryRecord[],
    private readonly brands: readonly BrandRecord[],
  ) {}
  async categoryById(id: string): Promise<CategoryRecord | null> {
    return this.categories.find((c) => c.id === id) ?? null;
  }
  async categoryBySlug(slug: string): Promise<CategoryRecord | null> {
    return this.categories.find((c) => c.slug === slug) ?? null;
  }
  async brandById(id: string): Promise<BrandRecord | null> {
    return this.brands.find((b) => b.id === id) ?? null;
  }
  async allCategories(): Promise<readonly CategoryRecord[]> {
    return this.categories;
  }
  async allBrands(): Promise<readonly BrandRecord[]> {
    return this.brands;
  }
}

export class InMemoryImportRepository implements ImportRepository {
  private readonly rows = new Map<string, ImportRecord>();
  private readonly claimed = new Set<string>();
  async save(record: ImportRecord): Promise<void> {
    this.rows.set(record.id, record);
  }
  async find(id: string): Promise<ImportRecord | null> {
    return this.rows.get(id) ?? null;
  }
  async claimProduct(importId: string, productRef: string): Promise<boolean> {
    const k = `${importId}|${productRef}`;
    if (this.claimed.has(k)) return false;
    this.claimed.add(k);
    return true;
  }
}

export class InMemoryUploads implements UploadReader {
  private readonly rows = new Map<string, { storeId: string; text: string | null }>();
  add(storeId: string, uploadId: string, text: string | null = null): void {
    this.rows.set(uploadId, { storeId, text });
  }
  async ownedBy(storeId: string, uploadIds: readonly string[]): Promise<ReadonlySet<string>> {
    return new Set(uploadIds.filter((id) => this.rows.get(id)?.storeId === storeId));
  }
  async readText(storeId: string, uploadId: string): Promise<string | null> {
    const r = this.rows.get(uploadId);
    return r !== undefined && r.storeId === storeId ? r.text : null;
  }
}

export class InMemoryStock implements StockReader, StockSeeder {
  private readonly levelsBySku = new Map<string, StockLevel>();
  failReads = false;
  async levels(skuIds: readonly string[]): Promise<ReadonlyMap<string, StockLevel>> {
    if (this.failReads) throw new Error("inventory unavailable");
    const out = new Map<string, StockLevel>();
    for (const id of skuIds) {
      const l = this.levelsBySku.get(id);
      if (l !== undefined) out.set(id, l);
    }
    return out;
  }
  async seed(_storeId: string, skuId: string, quantity: number): Promise<void> {
    this.levelsBySku.set(skuId, { onHand: quantity, available: quantity });
  }
  set(skuId: string, level: StockLevel): void {
    this.levelsBySku.set(skuId, level);
  }
}

export class InMemoryPriceBlocks implements PriceBlockReader {
  private readonly blocksBySku = new Map<string, PriceBlockInput>();
  async blocks(skuIds: readonly string[]): Promise<ReadonlyMap<string, PriceBlockInput>> {
    const out = new Map<string, PriceBlockInput>();
    for (const id of skuIds) {
      const b = this.blocksBySku.get(id);
      if (b !== undefined) out.set(id, b);
    }
    return out;
  }
  set(skuId: string, block: PriceBlockInput): void {
    this.blocksBySku.set(skuId, block);
  }
}

export class InMemoryStores implements StoreReader {
  private readonly rows = new Map<string, StoreProfile>();
  async profile(storeId: string, _viewer: string): Promise<StoreProfile | null> {
    return this.rows.get(storeId) ?? null;
  }
  set(profile: StoreProfile): void {
    this.rows.set(profile.id, profile);
  }
}

export class InMemorySizeCharts implements SizeChartStatusReader {
  private readonly rows = new Map<string, SizeChartStatus>();
  async status(storeId: string, chartId: string): Promise<SizeChartStatus> {
    return this.rows.get(`${storeId}|${chartId}`) ?? "none";
  }
  set(storeId: string, chartId: string, status: SizeChartStatus): void {
    this.rows.set(`${storeId}|${chartId}`, status);
  }
}

export class InMemoryMedia implements MediaUrlResolver {
  async resolve(uploadIds: readonly string[]): Promise<ReadonlyMap<string, MediaUrl>> {
    return new Map(uploadIds.map((id) => [id, { url: `https://media.invalid/u/${id}.avif`, blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj" }]));
  }
}

export class InMemoryCatalogEvents implements CatalogEventPublisher {
  readonly events: CatalogEvent[] = [];
  async publish(events: readonly CatalogEvent[]): Promise<void> {
    this.events.push(...events);
  }
}

/** Synthetic taxonomy. Ids are fixed so tests and seed data agree. */
export const SEED = {
  categoryDresses: "0192f3a4-5b6c-7d8e-9f01-c00000000001",
  categoryUnderwear: "0192f3a4-5b6c-7d8e-9f01-c00000000002",
  categoryShoesChart: "0192f3a4-5b6c-7d8e-9f01-c00000000003",
  categoryInactive: "0192f3a4-5b6c-7d8e-9f01-c00000000004",
  brandAcme: "0192f3a4-5b6c-7d8e-9f01-b00000000001",
} as const;

export const SEED_CATEGORIES: readonly CategoryRecord[] = [
  { id: SEED.categoryDresses, slug: "dresses", nameAr: "فساتين", nameEn: "Dresses", productType: "dress", returnClass: "standard", requiresSizeChart: false, active: true },
  { id: SEED.categoryUnderwear, slug: "underwear", nameAr: "ملابس داخلية", nameEn: "Underwear", productType: "underwear", returnClass: "hygiene", requiresSizeChart: false, active: true },
  { id: SEED.categoryShoesChart, slug: "shoes", nameAr: "أحذية", nameEn: "Shoes", productType: "shoes", returnClass: "standard", requiresSizeChart: true, active: true },
  { id: SEED.categoryInactive, slug: "retired", nameAr: "قسم متوقف", productType: "misc", returnClass: "standard", requiresSizeChart: false, active: false },
];
export const SEED_BRANDS: readonly BrandRecord[] = [{ id: SEED.brandAcme, slug: "acme", nameAr: "أكمي", nameEn: "Acme" }];

export interface CatalogDevFixtures {
  readonly products: InMemoryProductRepository;
  readonly taxonomy: InMemoryTaxonomy;
  readonly imports: InMemoryImportRepository;
  readonly uploads: InMemoryUploads;
  readonly stock: InMemoryStock;
  readonly prices: InMemoryPriceBlocks;
  readonly stores: InMemoryStores;
  readonly sizeCharts: InMemorySizeCharts;
  readonly media: InMemoryMedia;
  readonly events: InMemoryCatalogEvents;
}

export function createCatalogDevFixtures(): CatalogDevFixtures {
  return {
    products: new InMemoryProductRepository(),
    taxonomy: new InMemoryTaxonomy(SEED_CATEGORIES, SEED_BRANDS),
    imports: new InMemoryImportRepository(),
    uploads: new InMemoryUploads(),
    stock: new InMemoryStock(),
    prices: new InMemoryPriceBlocks(),
    stores: new InMemoryStores(),
    sizeCharts: new InMemorySizeCharts(),
    media: new InMemoryMedia(),
    events: new InMemoryCatalogEvents(),
  };
}
