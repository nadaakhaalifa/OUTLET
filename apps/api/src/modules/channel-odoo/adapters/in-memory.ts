import type {
  ChannelDirectoryPort,
  OdooChannelStatus,
  OdooClock,
  OdooConfig,
  OdooDnsPort,
  OdooFlagsPort,
  OdooMetrics,
  OdooSleeper,
  OdooStore,
  PriceSinkPort,
  ProductLink,
  SecretExistsPort,
  SellerSkuResolverPort,
  StockSinkPort,
} from "../domain/ports";

export class InMemoryOdooStore implements OdooStore {
  private readonly configs = new Map<string, OdooConfig>();
  private readonly linkMap = new Map<string, ProductLink>();
  async insertConfig(c: OdooConfig) {
    const prev = this.configs.get(c.channelId);
    if (prev !== undefined) return { kind: "exists" as const, config: prev };
    this.configs.set(c.channelId, c);
    return { kind: "created" as const, config: c };
  }
  async getConfig(channelId: string) {
    return this.configs.get(channelId) ?? null;
  }
  async listConfigs(storeId: string) {
    return [...this.configs.values()].filter((c) => c.storeId === storeId).sort((a, b) => b.createdAtMs - a.createdAtMs);
  }
  async listDue(nowMs: number, limit: number) {
    return [...this.configs.values()]
      .filter((c) => c.lastPolledAtMs === null || nowMs - c.lastPolledAtMs >= c.pollIntervalSeconds * 1_000)
      .sort((a, b) => (a.lastPolledAtMs ?? -1) - (b.lastPolledAtMs ?? -1))
      .slice(0, limit);
  }
  async updateConfig(c: OdooConfig) {
    if (this.configs.has(c.channelId)) this.configs.set(c.channelId, c);
  }
  async links(channelId: string) {
    return [...this.linkMap.values()].filter((l) => l.channelId === channelId);
  }
  async upsertLink(l: ProductLink) {
    this.linkMap.set(`${l.channelId}:${l.odooProductId}`, l);
  }
}

interface Ch {
  id: string;
  storeId: string;
  kind: string;
  status: OdooChannelStatus;
  tokenRef: string;
  kmsKeyRef: string;
}
export class InMemoryChannelDirectory implements ChannelDirectoryPort {
  readonly channels = new Map<string, Ch>();
  /** storeId -> targetId -> domain (verified targets). */
  readonly targets = new Map<string, Map<string, string>>();
  addTarget(storeId: string, targetId: string, domain: string): void {
    const m = this.targets.get(storeId) ?? new Map<string, string>();
    m.set(targetId, domain);
    this.targets.set(storeId, m);
  }
  async createChannel(i: { id: string; storeId: string; tokenRef: string; kmsKeyRef: string }) {
    this.channels.set(i.id, { id: i.id, storeId: i.storeId, kind: "odoo", status: "active", tokenRef: i.tokenRef, kmsKeyRef: i.kmsKeyRef });
  }
  async channel(channelId: string) {
    return this.channels.get(channelId) ?? null;
  }
  async revokeChannel(channelId: string) {
    const c = this.channels.get(channelId);
    if (c !== undefined) c.status = "revoked";
  }
  async verifiedTarget(storeId: string, targetId: string) {
    const d = this.targets.get(storeId)?.get(targetId);
    return d === undefined ? null : { domain: d };
  }
  async verifiedDomains(storeId: string) {
    return [...(this.targets.get(storeId)?.values() ?? [])];
  }
}

export class StaticSecrets implements SecretExistsPort {
  readonly refs = new Set<string>();
  async exists(tokenRef: string) {
    return this.refs.has(tokenRef);
  }
}
export class StaticOdooFlags implements OdooFlagsPort {
  constructor(public on = true) {}
  async enabled() {
    return this.on;
  }
}
export class FakeOdooDns implements OdooDnsPort {
  private readonly answers = new Map<string, string[][]>();
  private readonly seen = new Map<string, number>();
  /** Several answers per host model DNS rebinding: each resolve returns the next one. */
  set(host: string, ...answers: string[][]): void {
    this.answers.set(host, answers);
    this.seen.delete(host);
  }
  async resolve(host: string) {
    const list = this.answers.get(host) ?? [];
    const n = this.seen.get(host) ?? 0;
    this.seen.set(host, n + 1);
    return list[Math.min(n, list.length - 1)] ?? [];
  }
}
export class InMemorySkuResolver implements SellerSkuResolverPort {
  /** storeId -> sellerSku -> skuId */
  readonly map = new Map<string, Map<string, string>>();
  add(storeId: string, code: string, skuId: string): void {
    const m = this.map.get(storeId) ?? new Map<string, string>();
    m.set(code, skuId);
    this.map.set(storeId, m);
  }
  async resolve(storeId: string, sellerSkus: readonly string[]) {
    const out = new Map<string, string>();
    const m = this.map.get(storeId);
    for (const c of sellerSkus) {
      const v = m?.get(c);
      if (v !== undefined) out.set(c, v);
    }
    return out;
  }
}
export class RecordingStockSink implements StockSinkPort {
  readonly calls: Parameters<StockSinkPort["set"]>[0][] = [];
  readonly versions = new Map<string, number>();
  readonly keys = new Set<string>();
  readonly qty = new Map<string, number>();
  async set(i: Parameters<StockSinkPort["set"]>[0]) {
    this.calls.push(i);
    if (this.keys.has(i.idempotencyKey)) return "replayed" as const;
    const cur = this.versions.get(i.skuId);
    if (cur !== undefined && i.sourceVersion < cur) return "stale" as const;
    this.keys.add(i.idempotencyKey);
    this.versions.set(i.skuId, i.sourceVersion);
    this.qty.set(i.skuId, i.quantity);
    return "applied" as const;
  }
}
export class RecordingPriceSink implements PriceSinkPort {
  readonly calls: Parameters<PriceSinkPort["record"]>[0][] = [];
  readonly keys = new Set<string>();
  /** skuId -> storeId owning it; unknown skus are accepted. */
  readonly owners = new Map<string, string>();
  async record(i: Parameters<PriceSinkPort["record"]>[0]) {
    this.calls.push(i);
    const o = this.owners.get(i.skuId);
    if (o !== undefined && o !== i.storeId) return "rejected" as const;
    if (this.keys.has(`${i.skuId}:${i.idempotencyKey}`)) return "replayed" as const;
    this.keys.add(`${i.skuId}:${i.idempotencyKey}`);
    return "recorded" as const;
  }
}
export class InMemoryOdooMetrics implements OdooMetrics {
  readonly counters = new Map<string, number>();
  increment(name: string, labels?: Readonly<Record<string, string>>): void {
    const k = labels === undefined ? name : `${name}:${Object.entries(labels).map(([a, b]) => `${a}=${b}`).join(",")}`;
    this.counters.set(k, (this.counters.get(k) ?? 0) + 1);
  }
}
export class ManualClock implements OdooClock, OdooSleeper {
  constructor(private ms = Date.UTC(2026, 9, 12, 8, 0, 0)) {}
  nowMs() {
    return this.ms;
  }
  advance(ms: number) {
    this.ms += ms;
  }
  async sleep(ms: number) {
    this.ms += ms;
  }
}
