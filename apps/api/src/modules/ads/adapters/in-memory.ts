import { createHmac } from "node:crypto";
import { cairoDayKey, type AdsConfig, type Campaign, type CampaignStatus, type TargetingContext } from "../domain/bridge";
import type {
  AdsFlagsPort,
  AdsStore,
  AttributionPort,
  BidRecord,
  BillClick,
  ClickRecheck,
  ClickSignalsQuery,
  ClickSignalsResult,
  BotScorePort,
  ChargeIntentPort,
  ClickRecord,
  EnforcementPort,
  ImpressionRecord,
  LedgerPostingPort,
  OutboxDraft,
  ProductAdFacts,
  ProductEligibilityPort,
  SecretPort,
  ServableBid,
  TopUpRecord,
} from "../domain/ports";

export class InMemoryAdsStore implements AdsStore {
  config: AdsConfig | null = null;
  readonly campaigns = new Map<string, Campaign>();
  readonly bids = new Map<string, BidRecord[]>();
  readonly balances = new Map<string, bigint>();
  readonly topUps = new Map<string, TopUpRecord>();
  readonly dailySpend = new Map<string, bigint>();
  readonly impressions = new Map<string, ImpressionRecord>();
  readonly clicks = new Map<string, ClickRecord>();
  readonly outbox: OutboxDraft[] = [];

  async getConfig() {
    return this.config;
  }
  async putConfig(cfg: AdsConfig, _actorId?: string) {
    void _actorId;
    this.config = cfg;
  }

  async insertCampaign(c: Campaign, bids: readonly BidRecord[]) {
    this.campaigns.set(c.id, c);
    this.bids.set(c.id, [...bids]);
  }
  async getCampaign(id: string) {
    return this.campaigns.get(id) ?? null;
  }
  async listCampaigns(storeId: string, limit: number) {
    return [...this.campaigns.values()]
      .filter((c) => c.storeId === storeId)
      .sort((a, b) => b.createdAtMs - a.createdAtMs || (a.id < b.id ? 1 : -1))
      .slice(0, limit);
  }
  async listBids(campaignId: string) {
    return [...(this.bids.get(campaignId) ?? [])].sort((a, b) => (a.productId < b.productId ? -1 : 1));
  }
  async updateCampaign(
    id: string,
    patch: Partial<Pick<Campaign, "name" | "dailyBudget" | "maxCpc" | "keywords" | "categories" | "endsAtMs">>,
    bids: readonly BidRecord[] | null,
    nowMs: number,
  ) {
    const c = this.campaigns.get(id);
    if (c === undefined) return null;
    const n: Campaign = { ...c, ...patch, updatedAtMs: nowMs };
    this.campaigns.set(id, n);
    if (bids !== null) this.bids.set(id, [...bids]);
    return n;
  }
  async setStatus(id: string, from: CampaignStatus, to: CampaignStatus, nowMs: number, events: readonly OutboxDraft[]) {
    const c = this.campaigns.get(id);
    if (c === undefined || c.status !== from) return null;
    const n: Campaign = { ...c, status: to, updatedAtMs: nowMs };
    this.campaigns.set(id, n);
    this.outbox.push(...events);
    return n;
  }
  async listByStatus(status: CampaignStatus, limit: number) {
    return [...this.campaigns.values()].filter((c) => c.status === status).slice(0, limit);
  }
  async listStoreCampaignsInStatus(storeId: string, status: CampaignStatus) {
    return [...this.campaigns.values()].filter((c) => c.storeId === storeId && c.status === status);
  }

  async getBalance(storeId: string) {
    return this.balances.get(storeId) ?? 0n;
  }
  async insertTopUp(t: TopUpRecord) {
    for (const x of this.topUps.values()) {
      if (x.storeId === t.storeId && x.idempotencyKey === t.idempotencyKey) return { kind: "duplicate" as const, topUp: x };
    }
    this.topUps.set(t.id, t);
    return { kind: "created" as const, topUp: t };
  }
  async getTopUp(id: string) {
    return this.topUps.get(id) ?? null;
  }
  async setTopUpIntent(id: string, intentRef: string) {
    const t = this.topUps.get(id);
    if (t !== undefined) this.topUps.set(id, { ...t, intentRef });
  }
  async creditTopUp(id: string, nowMs: number, events: readonly OutboxDraft[]) {
    const t = this.topUps.get(id);
    if (t === undefined) return { kind: "not_found" as const, topUp: null, balance: 0n };
    if (t.status !== "PENDING_PAYMENT") return { kind: "replayed" as const, topUp: t, balance: await this.getBalance(t.storeId) };
    const n: TopUpRecord = { ...t, status: "CREDITED", creditedAtMs: nowMs };
    this.topUps.set(id, n);
    const balance = (await this.getBalance(t.storeId)) + t.net;
    this.balances.set(t.storeId, balance);
    this.outbox.push(...events);
    return { kind: "credited" as const, topUp: n, balance };
  }
  async failTopUp(id: string) {
    const t = this.topUps.get(id);
    if (t !== undefined && t.status === "PENDING_PAYMENT") this.topUps.set(id, { ...t, status: "FAILED" });
  }
  async listTopUps(storeId: string, limit: number) {
    return [...this.topUps.values()].filter((t) => t.storeId === storeId).sort((a, b) => b.createdAtMs - a.createdAtMs).slice(0, limit);
  }

  async listServable(nowMs: number, dayKey: string): Promise<readonly ServableBid[]> {
    const out: ServableBid[] = [];
    for (const c of this.campaigns.values()) {
      if (c.status !== "ACTIVE" || nowMs < c.startsAtMs || (c.endsAtMs !== null && nowMs >= c.endsAtMs)) continue;
      for (const b of this.bids.get(c.id) ?? []) {
        out.push({
          campaign: c,
          productId: b.productId,
          bid: b.bid,
          bidAtMs: b.createdAtMs,
          spentToday: this.dailySpend.get(`${c.id}|${dayKey}`) ?? 0n,
          balance: this.balances.get(c.storeId) ?? 0n,
        });
      }
    }
    return out;
  }

  async recordImpressions(rows: readonly ImpressionRecord[]) {
    for (const r of rows) this.impressions.set(r.id, r);
  }
  async getImpression(id: string) {
    return this.impressions.get(id) ?? null;
  }
  async impressionsTodayBySession(sessionHash: string, campaignId: string, sinceMs: number) {
    return [...this.impressions.values()].filter((i) => i.sessionHash === sessionHash && i.campaignId === campaignId && i.atMs >= sinceMs).length;
  }

  async billClick(click: ClickRecord, caps: { readonly dailyBudget: bigint }, events: readonly OutboxDraft[], recheck?: ClickRecheck): Promise<BillClick> {
    for (const c of this.clicks.values()) if (c.tokenJti === click.tokenJti) return { kind: "duplicate", click: c };
    if (!click.valid || click.cost === 0n) {
      this.clicks.set(click.id, { ...click, cost: 0n });
      return { kind: "rejected", click: this.clicks.get(click.id) as ClickRecord };
    }
    const key = `${click.campaignId}|${click.dayKey}`;
    if (recheck !== undefined) {
      const why = recheck.verdict(this.signals(recheck.query));
      if (why !== null) {
        const rej: ClickRecord = { ...click, valid: false, invalidReason: why as ClickRecord["invalidReason"], cost: 0n };
        this.clicks.set(click.id, rej);
        return { kind: "rejected", click: rej };
      }
    }
    const spent = this.dailySpend.get(key) ?? 0n;
    const balance = this.balances.get(click.storeId) ?? 0n;
    const reason = spent + click.cost > caps.dailyBudget ? "budget_exhausted" : balance < click.cost ? "no_balance" : null;
    if (reason !== null) {
      const rej: ClickRecord = { ...click, valid: false, invalidReason: reason, cost: 0n };
      this.clicks.set(click.id, rej);
      return { kind: "rejected", click: rej };
    }
    this.dailySpend.set(key, spent + click.cost);
    this.balances.set(click.storeId, balance - click.cost);
    this.clicks.set(click.id, click);
    this.outbox.push(...events);
    return { kind: "billed", click };
  }
  private signals(i: ClickSignalsQuery): ClickSignalsResult {
    const mine = [...this.clicks.values()].filter((c) => c.sessionHash === i.sessionHash);
    return {
      validInWindow: mine.filter((c) => c.valid && c.campaignId === i.campaignId && c.productId === i.productId && c.atMs >= i.windowSinceMs).length,
      clicksLastMinute: mine.filter((c) => c.atMs >= i.minuteSinceMs).length,
      campaignClicksToday: mine.filter((c) => c.valid && c.campaignId === i.campaignId && c.dayKey === i.dayKey).length,
    };
  }
  async clickSignals(i: ClickSignalsQuery): Promise<ClickSignalsResult> {
    return this.signals(i);
  }
  async creditBack(clickId: string) {
    const c = this.clicks.get(clickId);
    if (c === undefined) return { kind: "not_found" as const, click: null };
    if (!c.valid || c.cost === 0n || c.creditedBack > 0n) return { kind: "replayed" as const, click: c };
    const n: ClickRecord = { ...c, creditedBack: c.cost };
    this.clicks.set(clickId, n);
    this.balances.set(c.storeId, (this.balances.get(c.storeId) ?? 0n) + c.cost);
    const key = `${c.campaignId}|${c.dayKey}`;
    this.dailySpend.set(key, (this.dailySpend.get(key) ?? 0n) - c.cost);
    return { kind: "credited" as const, click: n };
  }
  async listUnposted(limit: number) {
    return [...this.clicks.values()].filter((c) => c.valid && c.cost > 0n && c.postedEntryId === null && c.creditedBack === 0n).slice(0, limit);
  }
  async markPosted(clickId: string, entryId: string) {
    const c = this.clicks.get(clickId);
    if (c !== undefined) this.clicks.set(clickId, { ...c, postedEntryId: entryId });
  }
  async getClick(id: string) {
    return this.clicks.get(id) ?? null;
  }

  async stats(i: { storeId: string; campaignId: string | null; fromMs: number; toMs: number }) {
    const inRange = (ms: number): boolean => ms >= i.fromMs && ms < i.toMs;
    const imps = [...this.impressions.values()].filter((x) => x.storeId === i.storeId && (i.campaignId === null || x.campaignId === i.campaignId) && inRange(x.atMs));
    const clicks = [...this.clicks.values()].filter((x) => x.storeId === i.storeId && x.valid && (i.campaignId === null || x.campaignId === i.campaignId) && inRange(x.atMs));
    return {
      impressions: imps.length,
      clicks: clicks.length,
      spend: clicks.reduce((s, c) => s + c.cost - c.creditedBack, 0n),
    };
  }
  async productIdsFor(storeId: string, campaignId: string | null) {
    const ids = new Set<string>();
    for (const c of this.campaigns.values()) {
      if (c.storeId !== storeId || (campaignId !== null && c.id !== campaignId)) continue;
      for (const b of this.bids.get(c.id) ?? []) ids.add(b.productId);
    }
    return [...ids];
  }
}

// ---- fakes for ports owned by other modules ---------------------------------------------------

/** Default OFF, as shipped (spec 10: admin kill switch `sponsored_products`). */
export class FakeAdsFlags implements AdsFlagsPort {
  enabled = false;
  async sponsoredEnabled() {
    return this.enabled;
  }
}

export class FakeEnforcement implements EnforcementPort {
  readonly blocked = new Set<string>();
  async blockedStores(storeIds: readonly string[]) {
    return new Set(storeIds.filter((s) => this.blocked.has(s)));
  }
}

export class FakeEligibility implements ProductEligibilityPort {
  readonly byProduct = new Map<string, ProductAdFacts>();
  seed(f: Partial<ProductAdFacts> & { productId: string; storeId: string }): void {
    this.byProduct.set(f.productId, {
      categoryIds: [],
      purchasable: true,
      relevanceBp: 9_000,
      sellerHealthBp: 9_000,
      priceTrustBp: 9_000,
      ...f,
    });
  }
  async facts(productIds: readonly string[], _ctx: TargetingContext) {
    void _ctx;
    return productIds.flatMap((id) => {
      const f = this.byProduct.get(id);
      return f === undefined ? [] : [f];
    });
  }
}

export class FakeChargeIntents implements ChargeIntentPort {
  readonly intents: { topUpId: string; gross: bigint; net: bigint; vat: bigint; key: string }[] = [];
  failing = false;
  async create(i: Parameters<ChargeIntentPort["create"]>[0]) {
    if (this.failing) throw new Error("psp unavailable");
    if (!this.intents.some((x) => x.key === i.idempotencyKey)) {
      this.intents.push({ topUpId: i.topUpId, gross: i.gross, net: i.net, vat: i.vat, key: i.idempotencyKey });
    }
    return { intentRef: `pi_ad_${i.topUpId.slice(-6)}`, clientAction: "redirect" as const };
  }
}

export class FakeLedger implements LedgerPostingPort {
  readonly entries: { entryKey: string; kind: string; refId: string; postings: readonly { account: string; amount: bigint }[]; entryId: string }[] = [];
  failing = false;
  async post(i: Parameters<LedgerPostingPort["post"]>[0]) {
    if (this.failing) throw new Error("ledger unavailable");
    const sum = i.postings.reduce((s, p) => s + p.amount, 0n);
    if (sum !== 0n) throw new Error("unbalanced entry");
    const prior = this.entries.find((e) => e.entryKey === i.entryKey);
    if (prior !== undefined) return { entryId: prior.entryId };
    const entryId = `entry-${this.entries.length + 1}`;
    this.entries.push({ ...i, postings: i.postings, entryId });
    return { entryId };
  }
}

export class FakeBotScore implements BotScorePort {
  readonly scores = new Map<string, number>();
  async score(sessionHash: string) {
    return this.scores.get(sessionHash) ?? null;
  }
}

export class FakeAttribution implements AttributionPort {
  revenue = 0n;
  async attributedRevenue() {
    return this.revenue;
  }
}

export class FakeSecret implements SecretPort {
  async hmac(data: string) {
    return createHmac("sha256", "fake-ads-hmac-key-000000000000000").update(data).digest("hex");
  }
}

export { cairoDayKey };
