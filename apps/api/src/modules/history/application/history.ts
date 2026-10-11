import {
  HISTORY_EVENT_TYPES,
  RECENTLY_VIEWED_CAP,
  buildFeatures,
  clearDeadline,
  forbiddenFeatureKeys,
  isClearOverdue,
  normalizeDetail,
  recordDecision,
  retentionCutoffMs,
  type HistoryEvent,
  type HistoryEventType,
  type RecentlyViewed,
} from "../domain/bridge";
import type {
  ClearCounts,
  Clock,
  FlagPort,
  HistorySettings,
  HistoryStore,
  IdPort,
  PersonalizationConsentPort,
  ProductLookupPort,
} from "../domain/ports";

export interface HistoryDeps {
  readonly store: HistoryStore;
  readonly clock: Clock;
  readonly ids: IdPort;
}

export const MODEL_VERSION_FEATURES = "feat-v1";
const FEATURE_WINDOW_MS = 90 * 86_400_000;
const FEATURE_EVENT_LIMIT = 2000;

// ---- cursor ---------------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const encodeCursor = (atMs: number, id: string): string =>
  Buffer.from(`${atMs}|${id}`, "utf8").toString("base64url");

export function decodeCursor(c: string): { atMs: number; id: string } | null {
  try {
    const [a, id] = Buffer.from(c, "base64url").toString("utf8").split("|");
    if (a === undefined || id === undefined || !/^\d{1,15}$/.test(a) || !UUID.test(id)) return null;
    return { atMs: Number(a), id };
  } catch {
    return null;
  }
}

// ---- record ---------------------------------------------------------------------------------

export interface RecordEventInput {
  readonly userId: string;
  readonly type: HistoryEventType;
  readonly itemId: string | null;
  readonly storeId?: string | null;
  readonly categoryId?: string | null;
  readonly priceMinor?: bigint | null;
  readonly detail?: string | null;
  readonly atMs?: number;
  /** Source event id for idempotent ingestion from the outbox. */
  readonly eventId?: string;
}

export type RecordResult =
  | { readonly kind: "recorded"; readonly event: HistoryEvent }
  | { readonly kind: "duplicate" }
  | { readonly kind: "paused" }
  | { readonly kind: "invalid"; readonly field: string };

/** Ingestion used by other modules (orders, returns, search, wishlists, stylist) and by view tracking. */
export class RecordHistoryEvent {
  constructor(private readonly d: HistoryDeps) {}

  async execute(i: RecordEventInput): Promise<RecordResult> {
    if (!HISTORY_EVENT_TYPES.includes(i.type)) return { kind: "invalid", field: "type" };
    if (i.type === "searched") {
      if (normalizeDetail(i.detail) === null) return { kind: "invalid", field: "detail" };
    } else if (i.itemId === null || !UUID.test(i.itemId)) {
      return { kind: "invalid", field: "item_id" };
    }
    const settings = await this.d.store.getSettings(i.userId);
    if (recordDecision(settings.historyPaused) === "drop_paused") return { kind: "paused" };
    const event: HistoryEvent = {
      id: i.eventId ?? this.d.ids.uuidV7(),
      userId: i.userId,
      type: i.type,
      itemId: i.type === "searched" ? null : i.itemId,
      storeId: i.storeId ?? null,
      categoryId: i.categoryId ?? null,
      priceMinor: i.priceMinor ?? null,
      detail: normalizeDetail(i.detail),
      atMs: i.atMs ?? this.d.clock.nowMs(),
    };
    return (await this.d.store.appendEvent(event)) === "duplicate" ? { kind: "duplicate" } : { kind: "recorded", event };
  }
}

export class ListHistory {
  constructor(private readonly d: HistoryDeps) {}

  async execute(userId: string, type: HistoryEventType | null, cursor: string | null, limit: number) {
    let after = null;
    if (cursor !== null) {
      after = decodeCursor(cursor);
      if (after === null) return { kind: "invalid_cursor" as const };
    }
    const size = Math.min(Math.max(1, Math.trunc(limit)), 50);
    const rows = await this.d.store.listEvents(userId, type, after, size + 1);
    const items = rows.slice(0, size);
    const last = items[items.length - 1];
    const next = rows.length > size && last !== undefined ? encodeCursor(last.atMs, last.id) : null;
    const settings = await this.d.store.getSettings(userId);
    return { kind: "ok" as const, items, nextCursor: next, settings };
  }
}

// ---- clear / pause / personalization --------------------------------------------------------

export class ClearHistory {
  constructor(private readonly d: HistoryDeps) {}

  async execute(userId: string): Promise<{ requestId: string; deadlineMs: number; counts: ClearCounts }> {
    const now = this.d.clock.nowMs();
    const requestId = this.d.ids.uuidV7();
    const deadlineMs = clearDeadline(now);
    const r = await this.d.store.clearAll({
      requestId,
      userId,
      nowMs: now,
      deadlineMs,
      events: [{ type: "history.cleared", userId, requestId, deadlineMs }],
    });
    return { requestId: r.request.id, deadlineMs: r.request.deadlineMs, counts: r.counts };
  }
}

export class SetHistoryPaused {
  constructor(private readonly d: HistoryDeps) {}
  async execute(userId: string, paused: boolean): Promise<HistorySettings> {
    const cur = await this.d.store.getSettings(userId);
    const events = cur.historyPaused === paused ? [] : ([{ type: "history.paused_changed", userId, paused }] as const);
    return this.d.store.setPaused(userId, paused, this.d.clock.nowMs(), events);
  }
}

/**
 * Turning personalization off also deletes the derived features at once: nothing built from the
 * shopper's behavior may outlive the choice (spec 13, personalization toggle).
 */
export class SetPersonalization {
  constructor(private readonly d: HistoryDeps) {}
  async execute(userId: string, on: boolean): Promise<HistorySettings> {
    const cur = await this.d.store.getSettings(userId);
    const events = cur.personalization === on ? [] : ([{ type: "personalization.changed", userId, personalization: on }] as const);
    const s = await this.d.store.setPersonalization(userId, on, this.d.clock.nowMs(), events);
    if (!on) await this.d.store.deleteFeatures(userId);
    return s;
  }
}

// ---- recently viewed ------------------------------------------------------------------------

export type ViewResult = { readonly kind: "ok"; readonly recorded: boolean } | { readonly kind: "not_found" };

export class RecordProductView {
  constructor(
    private readonly d: HistoryDeps,
    private readonly products: ProductLookupPort,
    private readonly record: RecordHistoryEvent,
  ) {}

  async execute(userId: string, productId: string): Promise<ViewResult> {
    const p = await this.products.snapshot(productId);
    if (p === null || !p.storeActive) return { kind: "not_found" };
    const r = await this.record.execute({
      userId,
      type: "viewed",
      itemId: p.productId,
      storeId: p.storeId,
      categoryId: p.categoryId,
      priceMinor: p.priceMinor,
    });
    if (r.kind !== "recorded") return { kind: "ok", recorded: false };
    await this.d.store.upsertRecentlyViewed(
      userId,
      { productId: p.productId, viewedAtMs: r.event.atMs, priceMinor: p.priceMinor },
      RECENTLY_VIEWED_CAP,
    );
    return { kind: "ok", recorded: true };
  }
}

export class ListRecentlyViewed {
  constructor(
    private readonly d: HistoryDeps,
    private readonly products: ProductLookupPort,
  ) {}

  /** Delisted or suspended-store items are filtered at read time. */
  async execute(userId: string, limit: number): Promise<readonly RecentlyViewed[]> {
    const rows = await this.d.store.listRecentlyViewed(userId, Math.min(Math.max(1, limit), RECENTLY_VIEWED_CAP));
    const out: RecentlyViewed[] = [];
    for (const r of rows) {
      const p = await this.products.snapshot(r.productId);
      if (p !== null && p.storeActive) out.push(r);
    }
    return out;
  }
}

// ---- jobs -----------------------------------------------------------------------------------

export type BuildResult = "built" | "no_consent" | "setting_off" | "kill_switch" | "clear_pending" | "forbidden_keys";

/** Builds derived features for one user. Consent, setting and kill switch all fail closed to delete/skip. */
export class BuildUserFeatures {
  constructor(
    private readonly d: HistoryDeps,
    private readonly consent: PersonalizationConsentPort,
    private readonly flags: FlagPort,
  ) {}

  async execute(userId: string): Promise<BuildResult> {
    const settings = await this.d.store.getSettings(userId);
    if (!settings.personalization) {
      await this.d.store.deleteFeatures(userId);
      return "setting_off";
    }
    if (!(await this.consent.isGranted(userId))) {
      await this.d.store.deleteFeatures(userId);
      return "no_consent";
    }
    if (!(await this.flags.mlRankingAllowed())) return "kill_switch";
    if ((await this.d.store.pendingClearForUser(userId)).length > 0) return "clear_pending";
    const now = this.d.clock.nowMs();
    const events = await this.d.store.eventsSince(userId, now - FEATURE_WINDOW_MS, FEATURE_EVENT_LIMIT);
    const features = buildFeatures(events, now);
    if (forbiddenFeatureKeys(features).length > 0) return "forbidden_keys";
    await this.d.store.putFeatures(userId, { features, modelVersion: MODEL_VERSION_FEATURES });
    return "built";
  }
}

export class RebuildFeaturesBatch {
  constructor(
    private readonly d: HistoryDeps,
    private readonly build: BuildUserFeatures,
  ) {}
  async execute(limit = 500): Promise<Record<BuildResult, number>> {
    const out: Record<BuildResult, number> = {
      built: 0,
      no_consent: 0,
      setting_off: 0,
      kill_switch: 0,
      clear_pending: 0,
      forbidden_keys: 0,
    };
    const since = this.d.clock.nowMs() - 24 * 3_600_000;
    for (const u of await this.d.store.usersWithRecentEvents(since, limit)) out[await this.build.execute(u)]++;
    return out;
  }
}

export interface SweepReport {
  readonly completed: number;
  readonly overdue: number;
  /** privacy_history_clear_overdue_total gauge value for the metric. */
  readonly metric: "privacy_history_clear_overdue_total";
}

/** Completes pending clear requests and reports those that missed the 24h deadline. */
export class SweepClearRequests {
  constructor(private readonly d: HistoryDeps) {}
  async execute(limit = 200): Promise<SweepReport> {
    const now = this.d.clock.nowMs();
    let completed = 0;
    let overdue = 0;
    for (const r of await this.d.store.pendingClearRequests(limit)) {
      if (isClearOverdue(r.deadlineMs, r.completedAtMs, now)) overdue++;
      if ((await this.d.store.completeClear(r.id, now)) !== null) completed++;
    }
    return { completed, overdue, metric: "privacy_history_clear_overdue_total" };
  }
}

/** user_events retention: 25 months, then removed (aggregates are computed upstream). */
export class PurgeExpiredEvents {
  constructor(private readonly d: HistoryDeps) {}
  async execute(limit = 10_000): Promise<number> {
    return this.d.store.purgeEventsBefore(retentionCutoffMs(this.d.clock.nowMs()), limit);
  }
}
