import { z } from "zod";
import type { EvidenceGate } from "../domain/matching";
import type {
  AttributeCheckPort,
  ChannelRecord,
  ConfigChange,
  CrawlEvent,
  CrawlFlagsPort,
  CrawlMetrics,
  CrawlStore,
  DnsResolverPort,
  DomainVerifierPort,
  EmbeddingCandidate,
  EmbeddingIndexPort,
  FetchRequest,
  FetchResponse,
  FingerprintSource,
  HttpFetchPort,
  IncidentQuery,
  IncidentRecord,
  IncidentRow,
  MatchRecord,
  MatchingConfigRecord,
  OfferParserPort,
  ParsedOffer,
  ProductFingerprintFacts,
  SnapshotRecord,
  TargetRecord,
  TokenVaultPort,
  VerificationMethod,
} from "../domain/ports";
import type { AttributeVerdict, ProductFingerprint } from "../domain/matching";

export class InMemoryCrawlStore implements CrawlStore {
  readonly targets = new Map<string, TargetRecord>();
  readonly channels = new Map<string, ChannelRecord>();
  readonly snapshots: SnapshotRecord[] = [];
  readonly matches = new Map<string, MatchRecord>();
  readonly incidents: IncidentRow[] = [];
  readonly configChanges: ConfigChange[] = [];
  readonly outbox: CrawlEvent[] = [];
  config: MatchingConfigRecord = { tauBp: 9_200, shadowOnly: true, version: 1 };
  labels = { pairs: 0, kappaMilli: 0 };

  async insertTarget(t: TargetRecord) {
    for (const x of this.targets.values()) if (x.storeId === t.storeId && x.domain === t.domain) return { kind: "exists" as const, target: x };
    this.targets.set(t.id, t);
    return { kind: "created" as const, target: t };
  }
  async getTarget(id: string) {
    return this.targets.get(id) ?? null;
  }
  async listTargets(storeId: string) {
    return [...this.targets.values()].filter((t) => t.storeId === storeId).sort((a, b) => b.consentAtMs - a.consentAtMs);
  }
  async listVerifiedTargets(limit: number) {
    return [...this.targets.values()]
      .filter((t) => t.status === "verified")
      .sort((a, b) => (a.robotsFetchedAtMs ?? 0) - (b.robotsFetchedAtMs ?? 0))
      .slice(0, limit);
  }
  async updateTarget(t: TargetRecord, events: readonly CrawlEvent[]) {
    this.targets.set(t.id, t);
    this.outbox.push(...events);
  }
  async verifiedDomains(storeId: string) {
    return [...this.targets.values()].filter((t) => t.storeId === storeId && t.status === "verified").map((t) => t.domain);
  }
  async insertChannel(c: ChannelRecord) {
    this.channels.set(c.id, c);
  }
  async getChannel(id: string) {
    return this.channels.get(id) ?? null;
  }
  async listChannels(storeId: string) {
    return [...this.channels.values()].filter((c) => c.storeId === storeId);
  }
  async updateChannel(c: ChannelRecord, events: readonly CrawlEvent[]) {
    this.channels.set(c.id, c);
    this.outbox.push(...events);
  }
  async latestSnapshot(targetId: string, skuRef: string) {
    const all = this.snapshots.filter((s) => s.targetId === targetId && s.skuRef === skuRef);
    return all.sort((a, b) => b.fetchedAtMs - a.fetchedAtMs)[0] ?? null;
  }
  async snapshotsSince(targetId: string, skuRef: string, sinceMs: number) {
    return this.snapshots.filter((s) => s.targetId === targetId && s.skuRef === skuRef && s.fetchedAtMs >= sinceMs);
  }
  async insertSnapshot(s: SnapshotRecord, events: readonly CrawlEvent[]) {
    this.snapshots.push(s);
    this.outbox.push(...events);
  }
  async upsertMatch(m: MatchRecord, events: readonly CrawlEvent[]) {
    for (const [k, x] of this.matches) if (x.skuId === m.skuId && x.targetId === m.targetId && x.externalRef === m.externalRef) this.matches.delete(k);
    this.matches.set(m.id, m);
    this.outbox.push(...events);
  }
  async matchesForSkus(skuIds: readonly string[], gate: EvidenceGate) {
    const set = new Set(skuIds);
    return [...this.matches.values()].filter((m) => set.has(m.skuId) && m.gate === gate);
  }
  async matchesForStore(storeId: string, limit: number) {
    return [...this.matches.values()].filter((m) => m.storeId === storeId).sort((a, b) => b.scoredAtMs - a.scoredAtMs).slice(0, limit);
  }
  async getConfig() {
    return this.config;
  }
  async applyConfigChange(c: ConfigChange, events: readonly CrawlEvent[]) {
    if (c.proposedBy === c.approvedBy) throw new Error("dual approval requires two distinct approvers");
    this.configChanges.push(c);
    this.config = { tauBp: c.newTauBp, shadowOnly: c.newShadow, version: this.config.version + 1 };
    this.outbox.push(...events);
    return this.config;
  }
  async labelStats() {
    return this.labels;
  }
  async addIncident(i: IncidentRecord, events: readonly CrawlEvent[]) {
    this.incidents.push({ ...i, createdAtMs: i.createdAtMs ?? Date.now() });
    this.outbox.push(...events);
  }
  async listIncidents(q: IncidentQuery): Promise<readonly IncidentRow[]> {
    return this.incidents
      .filter((i) => (q.storeId === null || i.storeId === q.storeId) && (q.kind === null || i.kind === q.kind))
      .filter((i) => q.after === null || i.createdAtMs < q.after.atMs || (i.createdAtMs === q.after.atMs && i.id < q.after.id))
      .sort((a, b) => b.createdAtMs - a.createdAtMs || (a.id < b.id ? 1 : -1))
      .slice(0, q.limit);
  }
}

export class StaticCrawlFlags implements CrawlFlagsPort {
  constructor(public enabled = true) {}
  async crawlingEnabled() {
    return this.enabled;
  }
}

export class FakeHttpFetch implements HttpFetchPort {
  readonly responses = new Map<string, FetchResponse>();
  readonly calls: FetchRequest[] = [];
  failWith: Error | null = null;
  async get(req: FetchRequest): Promise<FetchResponse> {
    this.calls.push(req);
    if (this.failWith !== null) throw this.failWith;
    const r = this.responses.get(req.url);
    if (r === undefined) return { status: 404, headers: {}, body: "", connectedAddress: req.pinnedAddress, truncated: false };
    return r;
  }
}

export class FakeDns implements DnsResolverPort {
  readonly answers = new Map<string, string[][]>();
  private readonly seen = new Map<string, number>();
  /** Several answers per host model DNS rebinding: each resolve returns the next one. */
  set(host: string, ...answers: string[][]): void {
    this.answers.set(host, answers);
  }
  async resolve(host: string): Promise<readonly string[]> {
    const list = this.answers.get(host) ?? [];
    const n = this.seen.get(host) ?? 0;
    this.seen.set(host, n + 1);
    return list[Math.min(n, list.length - 1)] ?? [];
  }
}

const OfferJson = z.object({ price: z.string().regex(/^\d{1,12}$/), available: z.boolean(), dom: z.string().min(8) }).strict();
/** Parses `{"price":"<piastres>","available":true,"dom":"<hash>"}`; the real parser is a seller-site adapter. */
export class JsonOfferParser implements OfferParserPort {
  parse(body: string): ParsedOffer | null {
    try {
      const r = OfferJson.safeParse(JSON.parse(body));
      return r.success ? { priceAmount: BigInt(r.data.price), available: r.data.available, domHash: r.data.dom } : null;
    } catch {
      return null;
    }
  }
}

export class FakeDomainVerifier implements DomainVerifierPort {
  readonly tokens = new Map<string, string>();
  async findToken(domain: string, method: VerificationMethod) {
    return this.tokens.get(`${method}:${domain}`) ?? null;
  }
}

export class FakeTokenVault implements TokenVaultPort {
  readonly refs = new Set<string>();
  readonly revoked = new Set<string>();
  async exists(tokenRef: string) {
    return this.refs.has(tokenRef);
  }
  async refresh(tokenRef: string) {
    if (this.revoked.has(tokenRef)) return { kind: "revoked" as const };
    return { kind: "refreshed" as const, tokenRef: `${tokenRef}.r` };
  }
}

export class FakeEmbeddingIndex implements EmbeddingIndexPort {
  candidates: EmbeddingCandidate[] = [];
  async nearest(_e: readonly number[], k: number) {
    return this.candidates.slice(0, k);
  }
}

export class FakeAttributeCheck implements AttributeCheckPort {
  verdict: AttributeVerdict | null = { brand: "match", colour: "match", material: "match", sizeRun: "overlap" };
  calls = 0;
  async check(_a: ProductFingerprintFacts, _b: ProductFingerprintFacts) {
    this.calls += 1;
    return this.verdict;
  }
}

export class FakeFingerprints implements FingerprintSource {
  readonly skus = new Map<string, { storeId: string; fp: ProductFingerprint; facts: ProductFingerprintFacts }>();
  readonly externals = new Map<string, { fp: ProductFingerprint; facts: ProductFingerprintFacts }>();
  async haulSku(skuId: string) {
    return this.skus.get(skuId) ?? null;
  }
  async externalProduct(targetId: string, externalRef: string) {
    return this.externals.get(`${targetId}:${externalRef}`) ?? null;
  }
}

export class InMemoryCrawlMetrics implements CrawlMetrics {
  readonly counters = new Map<string, number>();
  increment(name: string, labels: Readonly<Record<string, string>> = {}) {
    const k = `${name}${JSON.stringify(labels)}`;
    this.counters.set(k, (this.counters.get(k) ?? 0) + 1);
  }
}
