import type { ChannelDirectoryPort, PriceSinkPort, SellerSkuResolverPort, StockSinkPort } from "../modules/channel-odoo";
import type { CrawlStore } from "../modules/price-crawler";
import type { PriceIntegrityService } from "../modules/price-integrity";

/**
 * Bindings of the Odoo channel module's ports to the owning modules' public surfaces (A2.3).
 * Each adapter is thin: ownership, idempotency and versioning rules stay in the owning module.
 */

/** channel_connections and verified crawl targets, through the price-crawler store. */
export class CrawlStoreChannelDirectory implements ChannelDirectoryPort {
  constructor(private readonly store: CrawlStore) {}

  async createChannel(i: { id: string; storeId: string; tokenRef: string; kmsKeyRef: string; nowMs: number }): Promise<void> {
    await this.store.insertChannel({
      id: i.id,
      storeId: i.storeId,
      kind: "odoo",
      status: "active",
      tokenRef: i.tokenRef,
      kmsKeyRef: i.kmsKeyRef,
      targetId: null,
      createdAtMs: i.nowMs,
      revokedAtMs: null,
    });
  }

  async channel(channelId: string) {
    const c = await this.store.getChannel(channelId);
    return c === null ? null : { id: c.id, storeId: c.storeId, kind: c.kind, status: c.status, tokenRef: c.tokenRef, kmsKeyRef: c.kmsKeyRef };
  }

  async revokeChannel(channelId: string, nowMs: number): Promise<void> {
    const c = await this.store.getChannel(channelId);
    if (c === null || c.status === "revoked") return;
    await this.store.updateChannel({ ...c, status: "revoked", revokedAtMs: nowMs }, [{ type: "channel.token_revoked", channelId: c.id, storeId: c.storeId }]);
  }

  async verifiedTarget(storeId: string, targetId: string) {
    const t = await this.store.getTarget(targetId);
    // Another store's target is indistinguishable from a missing one.
    if (t === null || t.storeId !== storeId || t.status !== "verified" || t.kind !== "seller") return null;
    return { domain: t.domain };
  }

  async verifiedDomains(storeId: string) {
    return this.store.verifiedDomains(storeId);
  }
}

/** Appends to the immutable price ledger with source = odoo. A single event never creates a claim by itself. */
export class PriceIntegrityPriceSink implements PriceSinkPort {
  constructor(private readonly service: Pick<PriceIntegrityService, "recordPriceChange">) {}
  async record(i: Parameters<PriceSinkPort["record"]>[0]) {
    try {
      const o = await this.service.recordPriceChange({
        skuId: i.skuId,
        storeId: i.storeId,
        priceAmount: i.priceAmount,
        validFromMs: i.validFromMs,
        source: "odoo",
        actorId: null,
        idempotencyKey: i.idempotencyKey,
      });
      return o.created ? ("recorded" as const) : ("replayed" as const);
    } catch {
      // Store mismatch, back-dated event, reused key with another payload, invalid price: all refused.
      return "rejected" as const;
    }
  }
}

/** The inventory use case's public shape (SyncSellerStock.execute). */
export interface StockSyncUseCase {
  execute(raw: unknown): Promise<
    | { readonly kind: "applied"; readonly replayed: boolean }
    | { readonly kind: "stale" | "version_conflict" | "negative" | "not_found" | "invalid_input" }
  >;
}

/** Idempotent, versioned absolute stock set through the existing mechanism (mode set, reason channel_sync). */
export class InventoryStockSink implements StockSinkPort {
  constructor(private readonly sync: StockSyncUseCase) {}
  async set(i: Parameters<StockSinkPort["set"]>[0]) {
    const r = await this.sync.execute({
      skuId: i.skuId,
      actorStoreIds: [i.storeId],
      actorId: i.actorId,
      actorType: "channel",
      mode: "set",
      quantity: i.quantity,
      reason: "channel_sync",
      idempotencyKey: i.idempotencyKey,
      sourceVersion: i.sourceVersion,
    });
    if (r.kind === "applied") return r.replayed ? ("replayed" as const) : ("applied" as const);
    if (r.kind === "stale") return "stale" as const;
    return "rejected" as const;
  }
}

/** Catalog read model: seller SKU code to SKU id within one store. Supplied by the catalog composition. */
export interface SellerSkuLookup {
  bySellerSku(storeId: string, codes: readonly string[]): Promise<ReadonlyMap<string, string>>;
}
export class CatalogSellerSkuResolver implements SellerSkuResolverPort {
  constructor(private readonly lookup: SellerSkuLookup) {}
  async resolve(storeId: string, sellerSkus: readonly string[]) {
    return this.lookup.bySellerSku(storeId, sellerSkus);
  }
}
