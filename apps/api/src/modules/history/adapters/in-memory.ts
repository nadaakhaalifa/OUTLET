import { forbiddenFeatureKeys, upsertRecentlyViewed as upsertRv, type HistoryEvent, type HistoryEventType, type RecentlyViewed } from "../domain/bridge";
import {
  DEFAULT_SETTINGS,
  type ClearCounts,
  type ClearRequest,
  type EventPosition,
  type FlagPort,
  type HistoryOutboxEvent,
  type HistorySettings,
  type HistoryStore,
  type PersonalizationConsentPort,
  type ProductLookupPort,
  type ProductSnapshot,
  type StoredFeatures,
} from "../domain/ports";

const byRecent = (a: HistoryEvent, b: HistoryEvent): number =>
  b.atMs - a.atMs || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

export class InMemoryHistoryStore implements HistoryStore {
  readonly events: HistoryEvent[] = [];
  readonly outbox: HistoryOutboxEvent[] = [];
  private readonly settings = new Map<string, HistorySettings>();
  private readonly features = new Map<string, StoredFeatures>();
  private readonly recent = new Map<string, RecentlyViewed[]>();
  private readonly clears: ClearRequest[] = [];

  async appendEvent(e: HistoryEvent): Promise<"recorded" | "duplicate"> {
    if (this.events.some((x) => x.id === e.id)) return "duplicate";
    this.events.push(e);
    return "recorded";
  }

  async listEvents(userId: string, type: HistoryEventType | null, after: EventPosition | null, limit: number) {
    return this.events
      .filter((e) => e.userId === userId && (type === null || e.type === type))
      .sort(byRecent)
      .filter((e) => after === null || e.atMs < after.atMs || (e.atMs === after.atMs && e.id < after.id))
      .slice(0, limit);
  }

  async eventsSince(userId: string, sinceMs: number, limit: number) {
    return this.events
      .filter((e) => e.userId === userId && e.atMs >= sinceMs)
      .sort(byRecent)
      .slice(0, limit);
  }

  async getSettings(userId: string): Promise<HistorySettings> {
    return this.settings.get(userId) ?? DEFAULT_SETTINGS;
  }

  async setPersonalization(userId: string, on: boolean, _nowMs: number, events: readonly HistoryOutboxEvent[]) {
    const s = { ...(await this.getSettings(userId)), personalization: on };
    this.settings.set(userId, s);
    this.outbox.push(...events);
    return s;
  }

  async setPaused(userId: string, paused: boolean, _nowMs: number, events: readonly HistoryOutboxEvent[]) {
    const s = { ...(await this.getSettings(userId)), historyPaused: paused };
    this.settings.set(userId, s);
    this.outbox.push(...events);
    return s;
  }

  async getFeatures(userId: string): Promise<StoredFeatures | null> {
    return this.features.get(userId) ?? null;
  }
  async putFeatures(userId: string, f: StoredFeatures): Promise<void> {
    if (forbiddenFeatureKeys(f.features).length > 0) throw new Error("user_features must not carry budget or measurement keys");
    this.features.set(userId, f);
  }
  async deleteFeatures(userId: string): Promise<boolean> {
    return this.features.delete(userId);
  }

  async upsertRecentlyViewed(userId: string, entry: RecentlyViewed, cap: number): Promise<void> {
    this.recent.set(userId, [...upsertRv(this.recent.get(userId) ?? [], entry, cap)]);
  }
  async listRecentlyViewed(userId: string, limit: number) {
    return (this.recent.get(userId) ?? []).slice(0, limit);
  }

  async clearAll(input: {
    requestId: string;
    userId: string;
    nowMs: number;
    deadlineMs: number;
    events: readonly HistoryOutboxEvent[];
  }): Promise<{ request: ClearRequest; counts: ClearCounts }> {
    const before = this.events.length;
    for (let i = this.events.length - 1; i >= 0; i--) if (this.events[i]?.userId === input.userId) this.events.splice(i, 1);
    const counts: ClearCounts = {
      events: before - this.events.length,
      features: this.features.delete(input.userId) ? 1 : 0,
      recentlyViewed: (this.recent.get(input.userId) ?? []).length,
    };
    this.recent.delete(input.userId);
    const request: ClearRequest = {
      id: input.requestId,
      userId: input.userId,
      requestedAtMs: input.nowMs,
      deadlineMs: input.deadlineMs,
      completedAtMs: null,
    };
    this.clears.push(request);
    this.outbox.push(...input.events);
    return { request, counts };
  }

  async pendingClearForUser(userId: string) {
    return this.clears.filter((c) => c.userId === userId && c.completedAtMs === null);
  }
  async pendingClearRequests(limit: number) {
    return this.clears.filter((c) => c.completedAtMs === null).slice(0, limit);
  }

  async completeClear(requestId: string, nowMs: number): Promise<ClearCounts | null> {
    const i = this.clears.findIndex((c) => c.id === requestId && c.completedAtMs === null);
    const req = this.clears[i];
    if (req === undefined) return null;
    let events = 0;
    for (let k = this.events.length - 1; k >= 0; k--) {
      const e = this.events[k];
      if (e !== undefined && e.userId === req.userId && e.atMs <= req.requestedAtMs) {
        this.events.splice(k, 1);
        events++;
      }
    }
    const f = this.features.get(req.userId);
    let features = 0;
    if (f !== undefined && f.features.builtAtMs <= req.requestedAtMs) {
      this.features.delete(req.userId);
      features = 1;
    }
    const rv = this.recent.get(req.userId) ?? [];
    const keep = rv.filter((r) => r.viewedAtMs > req.requestedAtMs);
    this.recent.set(req.userId, keep);
    this.clears[i] = { ...req, completedAtMs: nowMs };
    return { events, features, recentlyViewed: rv.length - keep.length };
  }

  async purgeEventsBefore(cutoffMs: number, limit: number): Promise<number> {
    let n = 0;
    for (let i = this.events.length - 1; i >= 0 && n < limit; i--) {
      const e = this.events[i];
      if (e !== undefined && e.atMs < cutoffMs) {
        this.events.splice(i, 1);
        n++;
      }
    }
    return n;
  }

  async usersWithRecentEvents(sinceMs: number, limit: number) {
    const users = new Set<string>();
    for (const e of this.events) {
      if (e.atMs >= sinceMs && (this.settings.get(e.userId) ?? DEFAULT_SETTINGS).personalization) users.add(e.userId);
    }
    return [...users].sort().slice(0, limit);
  }
}

export class FakeConsent implements PersonalizationConsentPort {
  private readonly granted = new Set<string>();
  grant(userId: string): void {
    this.granted.add(userId);
  }
  withdraw(userId: string): void {
    this.granted.delete(userId);
  }
  async isGranted(userId: string): Promise<boolean> {
    return this.granted.has(userId);
  }
}

export class FakeProductLookup implements ProductLookupPort {
  private readonly products = new Map<string, ProductSnapshot>();
  set(p: ProductSnapshot): void {
    this.products.set(p.productId, p);
  }
  async snapshot(productId: string): Promise<ProductSnapshot | null> {
    return this.products.get(productId) ?? null;
  }
}

export class FakeFlags implements FlagPort {
  constructor(public mlRanking = true) {}
  async mlRankingAllowed(): Promise<boolean> {
    return this.mlRanking;
  }
}
