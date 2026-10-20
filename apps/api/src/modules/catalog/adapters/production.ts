import { createHash, createHmac } from "node:crypto";
import { sql, type Kysely } from "kysely";
import type { InventoryStore, SkuDirectory } from "../../inventory";
import type { SizeChartRepository } from "../../sizing";
import type { FavoriteRepository, StoreRepository } from "../../stores";
import type { KyselyTransactionRunner } from "../../../platform/db";
import { GetPublicProduct, type CatalogDeps } from "../application/products";
import { KyselyProductRepository, KyselyTaxonomy, type CatalogDb, type SessionProvider } from "./kysely";
import type { PriceBlockInput, SizeChartStatus } from "../domain/catalog-domain";
import type {
  CatalogClock,
  CatalogEvent,
  CatalogEventPublisher,
  CatalogObjectStore,
  ListedProductFacts,
  ListingSnapshot,
  ListingSnapshotReader,
  MediaUrl,
  MediaUrlResolver,
  PriceBlockReader,
  ProductImageJobs,
  ProductFactsReader,
  SizeChartStatusReader,
  StockLevel,
  StockReader,
  StockSeeder,
  StoreProfile,
  StoreReader,
  UploadReader,
} from "../domain/ports";
import { publicProductWire } from "./wire";

/** Every external or cross-module port the catalog needs in production. All required: none has a fixture fallback. */
export interface CatalogProductionPorts {
  readonly stock: StockReader;
  readonly stockSeeder: StockSeeder;
  readonly prices: PriceBlockReader;
  readonly stores: StoreReader;
  readonly sizeCharts: SizeChartStatusReader;
  readonly uploads: UploadReader;
  readonly media: MediaUrlResolver;
  /** Optional: normally resolved by DI from the product-media module ("catalog.ImageJobs"). */
  readonly imageJobs?: ProductImageJobs;
}

/** Thrown at boot when a genuinely external or cross-module port is missing in production. */
export class MissingCatalogPortsError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(`CatalogModule requires ${missing.join(", ")} in production: supply them through CatalogModule.forRoot(config, fixtures, persistence, ports)`);
    this.name = "MissingCatalogPortsError";
  }
}

export const REQUIRED_CATALOG_PORTS = ["stock", "stockSeeder", "prices", "stores", "sizeCharts", "uploads", "media"] as const;

/** Stock is owned by inventory: the catalog reads the STANDARD pool level of each SKU and never caches it. */
export class InventoryStockReader implements StockReader {
  constructor(
    private readonly store: Pick<InventoryStore, "levelView">,
    private readonly directory: SkuDirectory,
    private readonly standardPoolId: string,
  ) {}

  async levels(skuIds: readonly string[]): Promise<ReadonlyMap<string, StockLevel>> {
    const out = new Map<string, StockLevel>();
    for (const skuId of new Set(skuIds)) {
      const loc = await this.directory.lookup(skuId);
      if (loc === null) continue;
      const v = await this.store.levelView(skuId, loc.locationId, this.standardPoolId);
      if (v !== null) out.set(skuId, { onHand: v.onHand, available: v.available });
    }
    return out;
  }
}

/** Where a store's stock lives. Inventory has no provisioning API yet, so this reuses or creates one warehouse row. */
export interface StoreLocations {
  locationFor(storeId: string): Promise<string>;
}

function uuidFrom(seed: string): string {
  const h = createHash("sha256").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export class KyselyStoreLocations implements StoreLocations {
  constructor(private readonly db: Kysely<Record<string, never>>) {}

  async locationFor(storeId: string): Promise<string> {
    const fallback = uuidFrom(`catalog.default-location:${storeId}`);
    return this.db.transaction().execute(async (trx) => {
      await sql`select set_config('app.role', 'system', true)`.execute(trx);
      const existing = await sql<{ id: string }>`
        select id::text as id from locations
         where store_id = ${storeId}::uuid and kind = 'SELLER_WAREHOUSE' and active
         order by created_at, id limit 1`.execute(trx);
      const found = existing.rows[0];
      if (found !== undefined) return found.id;
      await sql`insert into locations (id, store_id, kind, name)
                values (${fallback}::uuid, ${storeId}::uuid, 'SELLER_WAREHOUSE', 'Main warehouse')
                on conflict (id) do nothing`.execute(trx);
      return fallback;
    });
  }
}

/** Opening quantity through the inventory sync path: idempotent per SKU, versioned, audited as an adjustment. */
export class InventoryStockSeeder implements StockSeeder {
  constructor(
    private readonly store: Pick<InventoryStore, "applySync">,
    private readonly locations: StoreLocations,
    private readonly standardPoolId: string,
    private readonly clock: CatalogClock,
  ) {}

  async seed(storeId: string, skuId: string, quantity: number): Promise<void> {
    const locationId = await this.locations.locationFor(storeId);
    const out = await this.store.applySync({
      skuId,
      locationId,
      poolId: this.standardPoolId,
      storeId,
      mode: "set",
      quantity,
      reason: "received",
      idempotencyKey: `catalog.initial_stock:${skuId}`,
      actorType: "system",
      actorId: "catalog",
      nowMs: this.clock.nowMs(),
    });
    if (out.status !== "applied") throw new Error(`initial stock for ${skuId} was not applied (${out.status})`);
  }
}

/** Stores module projection: legal identity is published only for an approved seller; invisible stores are not purchasable. */
export class StoresProfileReader implements StoreReader {
  constructor(
    private readonly stores: Pick<StoreRepository, "findById">,
    private readonly favorites: Pick<FavoriteRepository, "list">,
  ) {}

  async profile(storeId: string, viewerUserId: string): Promise<StoreProfile | null> {
    const s = await this.stores.findById(storeId);
    if (s === null) return null;
    const favs = UUID.test(viewerUserId) ? await this.favorites.list(viewerUserId) : [];
    const li = s.legalIdentity;
    const approved = s.sellerKycState === "APPROVED";
    const visible = (s.status === "ACTIVE" || s.status === "PAUSED") && approved && li !== null;
    return {
      id: s.id,
      slug: s.slug,
      nameAr: s.nameAr,
      ...(s.nameEn !== null ? { nameEn: s.nameEn } : {}),
      kind: s.kind,
      verifiedBadge: s.verifiedBadge,
      liveDrop: s.stats.liveDrop,
      paused: s.status === "PAUSED",
      isFavorite: favs.some((f) => f.storeId === storeId),
      legal:
        li === null
          ? { approved: false }
          : {
              legalName: li.legalNameAr,
              ...(li.commercialRegisterNo !== null ? { commercialRegisterNo: li.commercialRegisterNo } : {}),
              ...(li.taxCardNo !== null ? { taxCardNo: li.taxCardNo } : {}),
              governorate: li.governorate,
              approved,
            },
      visible,
    };
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Sizing module: structure status of a chart. The sizing public surface has no by-id read, so this
 * pages the store's own charts (tenant scoped) until the id is found or MAX_PAGES is reached.
 */
export class SizingChartStatusReader implements SizeChartStatusReader {
  static readonly PAGE = 100;
  static readonly MAX_PAGES = 20;

  constructor(private readonly charts: Pick<SizeChartRepository, "listForStore">) {}

  async status(storeId: string, chartId: string): Promise<SizeChartStatus> {
    let cursor: string | null = null;
    for (let i = 0; i < SizingChartStatusReader.MAX_PAGES; i += 1) {
      const page = await this.charts.listForStore(storeId, { cursor, limit: SizingChartStatusReader.PAGE });
      if (page === "invalid_cursor") return "none";
      const hit = page.items.find((c) => c.id === chartId);
      if (hit !== undefined) return hit.validated ? "validated" : "unvalidated";
      if (page.nextCursor === null) return "none";
      cursor = page.nextCursor;
    }
    return "none";
  }
}

/** Uploads and CSV reads go to the object store. Unconfigured in production: the caller sees 503, never a fabricated "owned". */
export class ObjectStoreUploads implements UploadReader {
  constructor(private readonly objects: CatalogObjectStore) {}
  ownedBy(storeId: string, uploadIds: readonly string[]): Promise<ReadonlySet<string>> {
    return this.objects.ownedBy(storeId, uploadIds);
  }
  readText(storeId: string, uploadId: string): Promise<string | null> {
    return this.objects.readText(storeId, uploadId);
  }
}

export const MAX_SIGNED_URL_TTL_SECONDS = 900;

/**
 * Read URLs for existing media: HMAC-signed, expiring, never longer than 15 minutes. Needs only a
 * public media base URL and a signing key (no object-store call), so reads keep working while the
 * store credentials are Unconfigured. Without a base URL and key it returns no URLs (images are
 * omitted from the page rather than invented).
 */
export class SignedUrlMediaResolver implements MediaUrlResolver {
  private readonly ttl: number;
  constructor(
    private readonly cfg: { readonly baseUrl: string; readonly signingKey: string; readonly ttlSeconds?: number } | null,
    private readonly clock: CatalogClock,
  ) {
    this.ttl = Math.min(Math.max(1, cfg?.ttlSeconds ?? MAX_SIGNED_URL_TTL_SECONDS), MAX_SIGNED_URL_TTL_SECONDS);
  }

  async resolve(uploadIds: readonly string[]): Promise<ReadonlyMap<string, MediaUrl>> {
    const out = new Map<string, MediaUrl>();
    if (this.cfg === null) return out;
    const exp = Math.floor(this.clock.nowMs() / 1000) + this.ttl;
    for (const id of uploadIds) {
      const sig = createHmac("sha256", this.cfg.signingKey).update(`${id}.${exp}`).digest("base64url");
      out.set(id, { url: `${this.cfg.baseUrl.replace(/\/+$/, "")}/${id}?exp=${exp}&sig=${sig}` });
    }
    return out;
  }
}

/**
 * Catalog events are appended to the outbox by the Kysely product repository in the SAME transaction
 * as the write (`insert`/`replace` take the events). This publisher exists only to satisfy the deps
 * shape and refuses any event, so a code path that forgets the transactional route fails loudly
 * instead of losing the event.
 */
export class TransactionalOutboxEvents implements CatalogEventPublisher {
  async publish(events: readonly CatalogEvent[]): Promise<void> {
    if (events.length > 0) throw new Error("catalog events must be written through the product repository (same transaction)");
  }
}

/** Late-bound reader so the price-integrity module can be attached without the catalog importing it. */
export class LatePriceBlocks implements PriceBlockReader {
  private reader: PriceBlockReader | null = null;
  bind(reader: PriceBlockReader): void {
    this.reader = reader;
  }
  /** Absent entries mean "no verified evidence": the page shows the plain price and never a reference. */
  async blocks(skuIds: readonly string[]): Promise<ReadonlyMap<string, PriceBlockInput>> {
    return this.reader === null ? new Map() : this.reader.blocks(skuIds);
  }
}

const SUMMARY_KEYS = ["id", "title", "store", "image_url", "cutout_url", "blurhash", "price", "condition", "sponsored"] as const;
const ANONYMOUS_VIEWER = "00000000-0000-4000-8000-000000000000";

/** Public facts for other modules, built from the same read model the product page uses. */
export class CatalogProductFacts implements ProductFactsReader {
  private readonly read: GetPublicProduct;
  constructor(deps: CatalogDeps) {
    this.read = new GetPublicProduct(deps);
  }

  async facts(productIds: readonly string[]): Promise<ReadonlyMap<string, ListedProductFacts>> {
    const out = new Map<string, ListedProductFacts>();
    for (const id of new Set(productIds)) {
      if (!UUID.test(id)) continue;
      const pub = await this.read.execute(id, ANONYMOUS_VIEWER);
      if (pub === null) {
        out.set(id, { id, listed: false, currentPrice: null, skuIds: [], summary: { id } });
        continue;
      }
      const wire: Record<string, unknown> = publicProductWire(pub);
      const picked: Record<string, unknown> = {};
      for (const k of SUMMARY_KEYS) if (wire[k] !== undefined) picked[k] = wire[k];
      const summary = { ...picked, id };
      const cheapest = [...pub.view.skus].sort((a, b) => (a.price.amount < b.price.amount ? -1 : a.price.amount > b.price.amount ? 1 : 0))[0];
      out.set(id, {
        id,
        listed: true,
        currentPrice: cheapest === undefined ? null : cheapest.price,
        skuIds: pub.view.skus.map((s) => s.id),
        summary,
      });
    }
    return out;
  }
}

/** Listing snapshots for the search feeder and facts provider. Reads the same owners as the product page. */
export class CatalogListingSnapshots implements ListingSnapshotReader {
  private readonly read: GetPublicProduct;
  constructor(private readonly deps: CatalogDeps) {
    this.read = new GetPublicProduct(deps);
  }

  async snapshot(productId: string): Promise<ListingSnapshot | null> {
    if (!UUID.test(productId)) return null;
    const product = await this.deps.products.findById(productId);
    if (product === null) return null;
    const hidden: ListingSnapshot = { listed: false, productId: product.id, storeId: product.storeId, status: product.status, version: product.version };
    if (product.status !== "active") return hidden;
    const pub = await this.read.execute(productId, ANONYMOUS_VIEWER);
    if (pub === null || pub.view.skus.length === 0) return hidden;
    const brand = product.brandId === undefined ? null : await this.deps.taxonomy.brandById(product.brandId);
    const first = pub.images[0];
    return {
      listed: true,
      productId: product.id,
      storeId: product.storeId,
      status: product.status,
      version: product.version,
      createdAtMs: product.createdAtMs,
      publishedAtMs: product.publishedAtMs ?? null,
      title: pub.view.title,
      categoryId: product.categoryId,
      brandId: product.brandId ?? null,
      brand,
      condition: pub.view.condition,
      department: pub.view.department,
      material: pub.view.material ?? null,
      storeKind: pub.store.kind,
      storeOpen: pub.store.paused !== true,
      imageUrl: first?.url ?? null,
      blurhash: first?.blurhash ?? null,
      skus: pub.view.skus.map((s) => ({ id: s.id, price: s.price, available: s.available, color: s.color ?? null, priceBlock: s.priceBlock })),
    };
  }
}

export interface CatalogProductionSources {
  readonly inventory: {
    readonly store: Pick<InventoryStore, "levelView" | "applySync">;
    readonly directory: SkuDirectory;
    readonly standardPoolId: string;
    readonly locations: StoreLocations;
  };
  readonly stores: { readonly stores: Pick<StoreRepository, "findById">; readonly favorites: Pick<FavoriteRepository, "list"> };
  readonly charts: Pick<SizeChartRepository, "listForStore">;
  readonly objects: CatalogObjectStore;
  /** Public media base URL and signing key. Null means no media URLs are produced (never invented). */
  readonly media: { readonly baseUrl: string; readonly signingKey: string; readonly ttlSeconds?: number } | null;
  readonly clock: CatalogClock;
}

/** Wires the catalog's cross-module ports from the other modules' public surfaces. `prices` is late-bound. */
export function createCatalogProductionPorts(src: CatalogProductionSources): { readonly ports: CatalogProductionPorts; readonly prices: LatePriceBlocks } {
  const prices = new LatePriceBlocks();
  return {
    prices,
    ports: {
      stock: new InventoryStockReader(src.inventory.store, src.inventory.directory, src.inventory.standardPoolId),
      stockSeeder: new InventoryStockSeeder(src.inventory.store, src.inventory.locations, src.inventory.standardPoolId, src.clock),
      prices,
      stores: new StoresProfileReader(src.stores.stores, src.stores.favorites),
      sizeCharts: new SizingChartStatusReader(src.charts),
      uploads: new ObjectStoreUploads(src.objects),
      media: new SignedUrlMediaResolver(src.media, src.clock),
    },
  };
}

/** Facts reader over the same Postgres products and ports the HTTP read model uses. */
export function createCatalogProductFacts(
  persistence: { readonly runner: KyselyTransactionRunner<CatalogDb>; readonly session: SessionProvider },
  ports: CatalogProductionPorts,
  clock: CatalogClock,
): CatalogProductFacts {
  return new CatalogProductFacts({
    products: new KyselyProductRepository(persistence.runner, persistence.session),
    taxonomy: new KyselyTaxonomy(persistence.runner, persistence.session),
    ...ports,
    events: new TransactionalOutboxEvents(),
    clock,
    ids: { uuidV7: () => { throw new Error("facts reader never creates ids"); } },
  });
}

/** Listing snapshot reader over the same Postgres products and ports the HTTP read model uses. */
export function createCatalogListingSnapshots(
  persistence: { readonly runner: KyselyTransactionRunner<CatalogDb>; readonly session: SessionProvider },
  ports: CatalogProductionPorts,
  clock: CatalogClock,
): CatalogListingSnapshots {
  return new CatalogListingSnapshots({
    products: new KyselyProductRepository(persistence.runner, persistence.session),
    taxonomy: new KyselyTaxonomy(persistence.runner, persistence.session),
    ...ports,
    events: new TransactionalOutboxEvents(),
    clock,
    ids: { uuidV7: () => { throw new Error("listing snapshots never create ids"); } },
  });
}
