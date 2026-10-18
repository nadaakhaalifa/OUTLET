import { z } from "zod";
import {
  MAX_PAGES,
  OdooPricelist,
  OdooPricelistItem,
  OdooProduct,
  OdooQuant,
  PAGE_SIZE,
  aggregateStock,
  authenticate,
  execute,
  resolvePrice,
} from "../domain/odoo";
import { breakerCanAttempt, breakerOnFailure, breakerOnSuccess } from "../domain/egress";
import {
  SECRET_API_KEY,
  SECRET_LOGIN,
  type ChannelDirectoryPort,
  type OdooClock,
  type OdooConfig,
  type OdooErrorCode,
  type OdooFlagsPort,
  type OdooMetrics,
  type OdooStore,
  type PriceSinkPort,
  type ProductLink,
  type SecretExistsPort,
  type SellerSkuResolverPort,
  type StockSinkPort,
} from "../domain/ports";
import type { OdooTransport, RpcResult } from "./transport";

export interface OdooDeps {
  readonly store: OdooStore;
  readonly directory: ChannelDirectoryPort;
  readonly secrets: SecretExistsPort;
  readonly flags: OdooFlagsPort;
  readonly transport: OdooTransport;
  readonly skus: SellerSkuResolverPort;
  readonly stock: StockSinkPort;
  readonly prices: PriceSinkPort;
  readonly metrics: OdooMetrics;
  readonly clock: OdooClock;
  readonly ids: { uuidV7(): string };
}

const REF = /^[A-Za-z0-9:/_.-]{8,256}$/;
const rpcId = (): number => 1;

const Uid = z.number().int().positive();

async function authenticateWith(d: OdooDeps, i: { storeId: string; targetId: string; database: string; tokenRef: string; kmsKeyRef: string }): Promise<{ readonly ok: true; readonly uid: number } | { readonly ok: false; readonly code: OdooErrorCode }> {
  const r = await d.transport.call({
    storeId: i.storeId,
    targetId: i.targetId,
    tokenRef: i.tokenRef,
    kmsKeyRef: i.kmsKeyRef,
    body: authenticate({ database: i.database, loginPlaceholder: SECRET_LOGIN, apiKeyPlaceholder: SECRET_API_KEY, rpcId: rpcId() }),
  });
  if (!r.ok) return r;
  const uid = Uid.safeParse(r.value);
  return uid.success ? { ok: true, uid: uid.data } : { ok: false, code: "auth_failed" };
}

// ---- connect / disconnect / test ----

export type ConnectResult =
  | { readonly kind: "connected"; readonly config: OdooConfig }
  | { readonly kind: "invalid_ref" | "secret_missing" | "target_required" | "disabled" | "exists" }
  | { readonly kind: "failed"; readonly code: OdooErrorCode };

export class ConnectOdooChannel {
  constructor(private readonly d: OdooDeps) {}
  async execute(i: {
    readonly storeId: string;
    readonly targetId: string;
    readonly database: string;
    readonly tokenRef: string;
    readonly kmsKeyRef: string;
    readonly pricelistId: number | null;
    readonly stockLocationId: number | null;
    readonly pollIntervalSeconds: number;
  }): Promise<ConnectResult> {
    if (!REF.test(i.tokenRef) || !REF.test(i.kmsKeyRef)) return { kind: "invalid_ref" };
    if (!(await this.d.flags.enabled())) return { kind: "disabled" };
    const target = await this.d.directory.verifiedTarget(i.storeId, i.targetId);
    if (target === null) return { kind: "target_required" };
    if (!(await this.d.secrets.exists(i.tokenRef, i.kmsKeyRef))) return { kind: "secret_missing" };
    const auth = await authenticateWith(this.d, i);
    if (!auth.ok) return { kind: "failed", code: auth.code };

    const now = this.d.clock.nowMs();
    const channelId = this.d.ids.uuidV7();
    await this.d.directory.createChannel({ id: channelId, storeId: i.storeId, tokenRef: i.tokenRef, kmsKeyRef: i.kmsKeyRef, nowMs: now });
    const config: OdooConfig = {
      channelId,
      storeId: i.storeId,
      targetId: i.targetId,
      database: i.database,
      uid: auth.uid,
      pricelistId: i.pricelistId,
      stockLocationId: i.stockLocationId,
      pollIntervalSeconds: i.pollIntervalSeconds,
      breakerFailures: 0,
      breakerOpenedAtMs: null,
      lastPolledAtMs: null,
      lastErrorCode: null,
      createdAtMs: now,
    };
    try {
      const r = await this.d.store.insertConfig(config);
      return r.kind === "created" ? { kind: "connected", config: r.config } : { kind: "exists" };
    } catch (e) {
      await this.d.directory.revokeChannel(channelId, now);
      throw e;
    }
  }
}

export class DisconnectOdooChannel {
  constructor(private readonly d: OdooDeps) {}
  async execute(storeId: string, channelId: string): Promise<{ readonly kind: "disconnected" | "not_found" }> {
    const c = await this.d.store.getConfig(channelId);
    if (c === null || c.storeId !== storeId) return { kind: "not_found" };
    const ch = await this.d.directory.channel(channelId);
    if (ch === null || ch.storeId !== storeId || ch.kind !== "odoo") return { kind: "not_found" };
    if (ch.status !== "revoked") await this.d.directory.revokeChannel(channelId, this.d.clock.nowMs());
    return { kind: "disconnected" };
  }
}

export type TestResult = { readonly kind: "ok" } | { readonly kind: "not_found" | "inactive" | "disabled" } | { readonly kind: "failed"; readonly code: OdooErrorCode };

export class TestOdooConnection {
  constructor(private readonly d: OdooDeps) {}
  async execute(storeId: string, channelId: string): Promise<TestResult> {
    const c = await this.d.store.getConfig(channelId);
    if (c === null || c.storeId !== storeId) return { kind: "not_found" };
    const ch = await this.d.directory.channel(channelId);
    if (ch === null || ch.storeId !== storeId || ch.kind !== "odoo") return { kind: "not_found" };
    if (ch.status !== "active") return { kind: "inactive" };
    if (!(await this.d.flags.enabled())) return { kind: "disabled" };
    const a = await authenticateWith(this.d, { storeId, targetId: c.targetId, database: c.database, tokenRef: ch.tokenRef, kmsKeyRef: ch.kmsKeyRef });
    if (a.ok && a.uid === c.uid) {
      await this.d.store.updateConfig({ ...c, lastErrorCode: null });
      return { kind: "ok" };
    }
    const code: OdooErrorCode = a.ok ? "auth_failed" : a.code;
    await this.d.store.updateConfig({ ...c, lastErrorCode: code });
    return { kind: "failed", code };
  }
}

// ---- poll ----

export interface PollSummary {
  readonly products: number;
  readonly unmapped: number;
  readonly stockApplied: number;
  readonly stockStale: number;
  readonly pricesRecorded: number;
  readonly rejected: number;
  readonly truncated: boolean;
}
export type PollResult =
  | { readonly kind: "synced"; readonly summary: PollSummary }
  | { readonly kind: "not_found" | "inactive" | "disabled" | "breaker_open" }
  | { readonly kind: "failed"; readonly code: OdooErrorCode };

const unwrap = <T>(r: RpcResult, schema: z.ZodType<T>): { ok: true; rows: T[] } | { ok: false; code: OdooErrorCode } => {
  if (!r.ok) return r;
  const arr = z.array(z.unknown()).safeParse(r.value);
  if (!arr.success) return { ok: false, code: "bad_response" };
  const rows: T[] = [];
  for (const raw of arr.data) {
    const p = schema.safeParse(raw);
    if (!p.success) return { ok: false, code: "bad_response" };
    rows.push(p.data);
  }
  return { ok: true, rows };
};

export class SyncOdooChannel {
  constructor(private readonly d: OdooDeps) {}

  async execute(channelId: string): Promise<PollResult> {
    const now = this.d.clock.nowMs();
    if (!(await this.d.flags.enabled())) return { kind: "disabled" };
    const cfg = await this.d.store.getConfig(channelId);
    if (cfg === null) return { kind: "not_found" };
    const ch = await this.d.directory.channel(channelId);
    if (ch === null || ch.kind !== "odoo" || ch.storeId !== cfg.storeId) return { kind: "not_found" };
    if (ch.status !== "active") {
      await this.d.store.updateConfig({ ...cfg, lastPolledAtMs: now });
      return { kind: "inactive" };
    }
    if (!breakerCanAttempt({ failures: cfg.breakerFailures, openedAtMs: cfg.breakerOpenedAtMs }, now)) return { kind: "breaker_open" };

    const result = await this.run(cfg, ch.tokenRef, ch.kmsKeyRef, now);
    if (result.kind === "failed") {
      const b = breakerOnFailure({ failures: cfg.breakerFailures, openedAtMs: cfg.breakerOpenedAtMs }, now);
      await this.d.store.updateConfig({ ...cfg, breakerFailures: b.failures, breakerOpenedAtMs: b.openedAtMs, lastPolledAtMs: now, lastErrorCode: result.code });
      this.d.metrics.increment("odoo_poll_failed", { code: result.code });
      return result;
    }
    const ok = breakerOnSuccess();
    await this.d.store.updateConfig({ ...cfg, breakerFailures: ok.failures, breakerOpenedAtMs: ok.openedAtMs, lastPolledAtMs: now, lastErrorCode: null });
    this.d.metrics.increment("odoo_poll_ok");
    return result;
  }

  private async run(cfg: OdooConfig, tokenRef: string, kmsKeyRef: string, now: number): Promise<PollResult> {
    const call = (model: string, method: string, args: unknown[], kwargs: Record<string, unknown>) =>
      this.d.transport.call({
        storeId: cfg.storeId,
        targetId: cfg.targetId,
        tokenRef,
        kmsKeyRef,
        body: execute({ database: cfg.database, uid: cfg.uid, model, method, args, kwargs, apiKeyPlaceholder: SECRET_API_KEY, rpcId: rpcId() }),
      });

    // 1. Products (paged, bounded). Only products with a seller SKU code can be linked.
    const products: OdooProduct[] = [];
    let truncated = false;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const r = unwrap(
        await call("product.product", "search_read", [[["active", "=", true], ["default_code", "!=", false]]], {
          fields: ["id", "default_code", "list_price", "write_date", "product_tmpl_id"],
          limit: PAGE_SIZE,
          offset: page * PAGE_SIZE,
          order: "id asc",
        }),
        OdooProduct,
      );
      if (!r.ok) return { kind: "failed", code: r.code };
      products.push(...r.rows);
      if (r.rows.length < PAGE_SIZE) break;
      if (page === MAX_PAGES - 1) truncated = true;
    }
    if (products.length === 0) return { kind: "synced", summary: { products: 0, unmapped: 0, stockApplied: 0, stockStale: 0, pricesRecorded: 0, rejected: 0, truncated } };

    // 2. Stock (internal locations only, optionally under one location).
    const ids = products.map((p) => p.id);
    const quantDomain: unknown[] = [["product_id", "in", ids], ["location_id.usage", "=", "internal"]];
    if (cfg.stockLocationId !== null) quantDomain.push(["location_id", "child_of", cfg.stockLocationId]);
    const q = unwrap(
      await call("stock.quant", "search_read", [quantDomain], { fields: ["product_id", "quantity", "reserved_quantity", "write_date"], limit: 20_000 }),
      OdooQuant,
    );
    if (!q.ok) return { kind: "failed", code: q.code };
    const stock = aggregateStock(products, q.rows);

    // 3. Prices: a pricelist is used only when it is in EGP (no currency conversion, ever).
    let items: OdooPricelistItem[] = [];
    if (cfg.pricelistId !== null) {
      const pl = unwrap(await call("product.pricelist", "read", [[cfg.pricelistId]], { fields: ["id", "currency_id"] }), OdooPricelist);
      if (!pl.ok) return { kind: "failed", code: pl.code };
      const cur = pl.rows[0]?.currency_id;
      if (cur === undefined || cur === false || cur[1] !== "EGP") return { kind: "failed", code: "currency_unsupported" };
      const it = unwrap(
        await call(
          "product.pricelist.item",
          "search_read",
          [[["pricelist_id", "=", cfg.pricelistId], ["compute_price", "=", "fixed"], ["applied_on", "in", ["0_product_variant", "1_product"]]]],
          { fields: ["product_id", "product_tmpl_id", "fixed_price", "min_quantity", "date_start", "date_end", "write_date"], limit: 20_000 },
        ),
        OdooPricelistItem,
      );
      if (!it.ok) return { kind: "failed", code: it.code };
      items = it.rows;
    }

    // 4. Map to SKUs of THIS store only, then write through the owning modules' ports.
    const codes = [...new Set(products.map((p) => p.default_code).filter((c): c is string => c !== null && c.length > 0))];
    const skuByCode = await this.d.skus.resolve(cfg.storeId, codes);
    const links = new Map((await this.d.store.links(cfg.channelId)).map((l) => [l.odooProductId, l]));
    const s = { products: products.length, unmapped: 0, stockApplied: 0, stockStale: 0, pricesRecorded: 0, rejected: 0, truncated };

    for (const p of products) {
      const skuId = p.default_code === null ? undefined : skuByCode.get(p.default_code);
      if (skuId === undefined) {
        s.unmapped += 1;
        continue;
      }
      const prev = links.get(p.id);
      const same = prev !== undefined && prev.skuId === skuId;
      let link: ProductLink = same
        ? prev
        : { channelId: cfg.channelId, odooProductId: p.id, storeId: cfg.storeId, skuId, lastPriceAmount: null, lastStockSourceVersion: null, lastStockQty: null, lastSyncedAtMs: null };

      const obs = stock.get(p.id);
      if (obs !== undefined && !(link.lastStockSourceVersion === obs.sourceVersion && link.lastStockQty === obs.available)) {
        try {
          const o = await this.d.stock.set({
            skuId,
            storeId: cfg.storeId,
            quantity: obs.available,
            sourceVersion: obs.sourceVersion,
            idempotencyKey: `odoo:${cfg.channelId}:${p.id}:v${obs.sourceVersion}:q${obs.available}`,
            actorId: `odoo:${cfg.channelId}`,
          });
          if (o === "applied" || o === "replayed") {
            s.stockApplied += o === "applied" ? 1 : 0;
            link = { ...link, lastStockSourceVersion: obs.sourceVersion, lastStockQty: obs.available };
          } else if (o === "stale") s.stockStale += 1;
          else s.rejected += 1;
        } catch {
          s.rejected += 1;
        }
      }

      const price = resolvePrice(p, items, now);
      if (price !== null && price.priceAmount !== link.lastPriceAmount) {
        try {
          const o = await this.d.prices.record({
            skuId,
            storeId: cfg.storeId,
            priceAmount: price.priceAmount,
            validFromMs: now,
            idempotencyKey: `odoo:${cfg.channelId}:${p.id}:${price.priceAmount.toString()}:v${price.version}`,
          });
          if (o === "rejected") s.rejected += 1;
          else {
            s.pricesRecorded += o === "recorded" ? 1 : 0;
            link = { ...link, lastPriceAmount: price.priceAmount };
          }
        } catch {
          s.rejected += 1;
        }
      }
      await this.d.store.upsertLink({ ...link, lastSyncedAtMs: now });
    }
    return { kind: "synced", summary: s };
  }
}

export class RunOdooPollBatch {
  constructor(
    private readonly d: OdooDeps,
    private readonly sync: SyncOdooChannel,
  ) {}
  /** Due channels only (poll interval per channel), one after another; the transport paces per domain. */
  async execute(limit = 20): Promise<{ readonly polled: number; readonly failed: number }> {
    const due = await this.d.store.listDue(this.d.clock.nowMs(), Math.max(1, Math.min(limit, 100)));
    let failed = 0;
    for (const c of due) {
      const r = await this.sync.execute(c.channelId);
      if (r.kind === "failed") failed += 1;
    }
    return { polled: due.length, failed };
  }
}
