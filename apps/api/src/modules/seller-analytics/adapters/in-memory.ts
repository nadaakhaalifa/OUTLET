/**
 * DEVELOPMENT AND TEST FIXTURES: per-process store, fakes for ports. The module refuses to boot
 * with these outside test mode (MissingSellerAnalyticsPortsError).
 */
import { emptyFunnelCounts, type FunnelCounts, type KCell, type SalesTotals } from "../domain/bridge";
import type {
  AnalyticsStore,
  AuditPort,
  EventSourcePort,
  ExportAuditEntry,
  FreshnessRow,
  GeoValue,
  IngestResult,
  ProductStoreLookup,
  Range,
  ReturnReasonRow,
  SkuSalesRow,
  SourceEvent,
  SourceMessage,
  StockRow,
} from "../domain/ports";

type Purchase = Extract<SourceEvent, { kind: "purchase" }>;
type Return = Extract<SourceEvent, { kind: "return" }>;

const inRange = (e: SourceEvent, r: Range): boolean => e.occurredAtMs >= r.fromMs && e.occurredAtMs < r.toMs;
const distinct = (keys: readonly (string | null)[]): number => new Set(keys.filter((k): k is string => k !== null)).size;

interface StockEntry extends StockRow {
  observedAtMs: number;
}

export class InMemoryAnalyticsStore implements AnalyticsStore {
  private readonly facts: SourceEvent[] = [];
  private readonly processed = new Set<string>();
  private readonly stock = new Map<string, StockEntry>();
  private readonly fresh = new Map<string, FreshnessRow>();

  async ingest(consumer: string, events: readonly SourceEvent[], nowMs: number): Promise<IngestResult> {
    let applied = 0;
    let duplicates = 0;
    for (const e of events) {
      const key = `${consumer}:${e.messageId}`;
      if (this.processed.has(key)) {
        duplicates += 1;
        continue;
      }
      this.processed.add(key);
      applied += 1;
      if (e.kind === "stock_snapshot") {
        const k = `${e.storeId}:${e.skuId}`;
        const cur = this.stock.get(k);
        if (cur === undefined || e.occurredAtMs >= cur.observedAtMs) {
          this.stock.set(k, {
            skuId: e.skuId,
            productId: e.productId,
            sizeLabel: e.sizeLabel,
            onHand: e.onHand,
            priceMinor: e.priceMinor,
            listedAtMs: Math.min(e.listedAtMs, cur?.listedAtMs ?? e.listedAtMs),
            observedAtMs: e.occurredAtMs,
          });
        } else {
          this.stock.set(k, { ...cur, listedAtMs: Math.min(cur.listedAtMs, e.listedAtMs) });
        }
      } else {
        this.facts.push(e);
      }
      const f = this.fresh.get(e.storeId);
      this.fresh.set(e.storeId, {
        lastEventMs: Math.max(f?.lastEventMs ?? 0, e.occurredAtMs),
        lastIngestMs: Math.max(f?.lastIngestMs ?? 0, nowMs),
      });
    }
    return { applied, duplicates };
  }

  private scoped(storeId: string, r: Range): SourceEvent[] {
    return this.facts.filter((e) => e.storeId === storeId && inRange(e, r));
  }

  async trafficTotals(storeId: string, r: Range) {
    const rows = this.scoped(storeId, r).filter((e) => e.kind === "store_view" || e.kind === "view");
    return {
      storeViews: rows.filter((e) => e.kind === "store_view").length,
      productViews: rows.filter((e) => e.kind === "view").length,
      uniqueVisitors: distinct(rows.map((e) => e.shopperKey)),
    };
  }

  async trafficBySource(storeId: string, r: Range): Promise<readonly KCell<number>[]> {
    const by = new Map<string, SourceEvent[]>();
    for (const e of this.scoped(storeId, r)) {
      if (e.kind !== "store_view" && e.kind !== "view") continue;
      const s = e.source ?? "unknown";
      by.set(s, [...(by.get(s) ?? []), e]);
    }
    return [...by].map(([key, es]) => ({ key, distinctShoppers: distinct(es.map((e) => e.shopperKey)), value: es.length }));
  }

  async funnelByProduct(storeId: string, r: Range) {
    const by = new Map<string, { -readonly [K in keyof FunnelCounts]: number }>();
    for (const e of this.scoped(storeId, r)) {
      if (!("productId" in e)) continue;
      if (e.kind === "return" || e.kind === "stock_snapshot") continue;
      const c = by.get(e.productId) ?? emptyFunnelCounts();
      c[e.kind] += 1;
      by.set(e.productId, c);
    }
    return [...by].map(([productId, counts]) => ({ productId, counts })).sort((a, b) => (a.productId < b.productId ? -1 : 1));
  }

  private purchases(storeId: string, r: Range): Purchase[] {
    return this.scoped(storeId, r).filter((e): e is Purchase => e.kind === "purchase");
  }

  async salesTotals(storeId: string, r: Range): Promise<SalesTotals> {
    const ps = this.purchases(storeId, r);
    const ordersByShopper = new Map<string, Set<string>>();
    for (const p of ps) {
      if (p.shopperKey === null) continue;
      const s = ordersByShopper.get(p.shopperKey) ?? new Set<string>();
      s.add(p.sellerOrderId);
      ordersByShopper.set(p.shopperKey, s);
    }
    return {
      gmvMinor: ps.reduce((n, p) => n + p.grossMinor, 0n),
      commissionMinor: ps.reduce((n, p) => n + p.commissionMinor, 0n),
      units: ps.reduce((n, p) => n + p.qty, 0),
      orders: new Set(ps.map((p) => p.sellerOrderId)).size,
      distinctShoppers: ordersByShopper.size,
      repeatShoppers: [...ordersByShopper.values()].filter((s) => s.size >= 2).length,
    };
  }

  async skuSales(storeId: string, r: Range): Promise<readonly SkuSalesRow[]> {
    const by = new Map<string, { productId: string; soldUnits: number; returnedUnits: number }>();
    for (const e of this.scoped(storeId, r)) {
      if (e.kind !== "purchase" && e.kind !== "return") continue;
      const cur = by.get(e.skuId) ?? { productId: e.productId, soldUnits: 0, returnedUnits: 0 };
      if (e.kind === "purchase") cur.soldUnits += e.qty;
      else cur.returnedUnits += e.qty;
      by.set(e.skuId, cur);
    }
    return [...by].map(([skuId, v]) => ({ skuId, ...v })).sort((a, b) => (a.skuId < b.skuId ? -1 : 1));
  }

  async returnReasons(storeId: string, r: Range): Promise<readonly ReturnReasonRow[]> {
    const by = new Map<string, ReturnReasonRow>();
    for (const e of this.scoped(storeId, r)) {
      if (e.kind !== "return") continue;
      const k = `${(e as Return).skuId}|${e.reason}`;
      const cur = by.get(k);
      by.set(k, { skuId: e.skuId, productId: e.productId, reason: e.reason, units: (cur?.units ?? 0) + e.qty });
    }
    return [...by.values()].sort((a, b) => (a.skuId + a.reason < b.skuId + b.reason ? -1 : 1));
  }

  async stockLevels(storeId: string): Promise<readonly StockRow[]> {
    return [...this.stock]
      .filter(([k]) => k.startsWith(`${storeId}:`))
      .map(([, v]) => ({ skuId: v.skuId, productId: v.productId, sizeLabel: v.sizeLabel, onHand: v.onHand, priceMinor: v.priceMinor, listedAtMs: v.listedAtMs }))
      .sort((a, b) => (a.skuId < b.skuId ? -1 : 1));
  }

  async searchTerms(storeId: string, r: Range): Promise<readonly KCell<number>[]> {
    const by = new Map<string, SourceEvent[]>();
    for (const e of this.scoped(storeId, r)) {
      if (e.kind !== "search_click") continue;
      by.set(e.term, [...(by.get(e.term) ?? []), e]);
    }
    return [...by].map(([key, es]) => ({ key, distinctShoppers: distinct(es.map((e) => e.shopperKey)), value: es.length }));
  }

  async geography(storeId: string, r: Range): Promise<readonly KCell<GeoValue>[]> {
    const by = new Map<string, Purchase[]>();
    for (const p of this.purchases(storeId, r)) {
      if (p.governorate === undefined) continue;
      by.set(p.governorate, [...(by.get(p.governorate) ?? []), p]);
    }
    return [...by].map(([key, ps]) => ({
      key,
      distinctShoppers: distinct(ps.map((p) => p.shopperKey)),
      value: { orders: new Set(ps.map((p) => p.sellerOrderId)).size, gmvMinor: ps.reduce((n, p) => n + p.grossMinor, 0n) },
    }));
  }

  async freshness(storeId: string): Promise<FreshnessRow | null> {
    return this.fresh.get(storeId) ?? null;
  }
}

export class InMemoryEventSource implements EventSourcePort {
  private readonly queue: SourceMessage[] = [];
  readonly acked: string[] = [];
  push(...m: SourceMessage[]): void {
    this.queue.push(...m);
  }
  async poll(max: number): Promise<readonly SourceMessage[]> {
    return this.queue.slice(0, max);
  }
  async ack(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      const i = this.queue.findIndex((m) => m.messageId === id);
      if (i >= 0) this.queue.splice(i, 1);
      this.acked.push(id);
    }
  }
}

export class InMemoryAudit implements AuditPort {
  readonly entries: ExportAuditEntry[] = [];
  /** Test hook: simulate an unavailable audit trail. */
  failing = false;
  async record(entry: ExportAuditEntry): Promise<void> {
    if (this.failing) throw new Error("audit unavailable");
    this.entries.push(entry);
  }
}

export class StaticProductStoreLookup implements ProductStoreLookup {
  private readonly map = new Map<string, string>();
  set(productId: string, storeId: string): void {
    this.map.set(productId, storeId);
  }
  async storeOf(productId: string): Promise<string | null> {
    return this.map.get(productId) ?? null;
  }
}
