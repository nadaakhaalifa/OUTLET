import type { IngestEmitter } from "./emitter";
import { MAX_IMPRESSION_ITEMS, type IngestSurface } from "./schema";

export interface ImpressionItem {
  readonly productId: string;
  readonly storeId: string;
  readonly position: number;
}

export interface ImpressionConfig {
  /** Minimum visible fraction, used by the list's viewabilityConfig (itemVisiblePercentThreshold). */
  readonly minVisibleFraction: number;
  readonly dwellMs: number;
  /** Plausibility limit per surface per minute (server rejects above 30). */
  readonly maxPerSurfacePerMinute: number;
}
export const DEFAULT_IMPRESSION_CONFIG: ImpressionConfig = { minVisibleFraction: 0.5, dwellMs: 1_000, maxPerSurfacePerMinute: 30 };

const WINDOW_MS = 60_000;

/**
 * Viewability bookkeeping, pure and clock-injected. The list reports the currently viewable items
 * (already filtered by the list to the minimum visible fraction); an item becomes an impression
 * only after it stayed viewable for `dwellMs`, once per (product, surface) per session, and never
 * more than `maxPerSurfacePerMinute` per surface per sliding minute.
 */
export class ImpressionTracker {
  private readonly cfg: ImpressionConfig;
  private readonly seen = new Set<string>();
  private readonly since = new Map<string, Map<string, ImpressionItem & { at: number }>>();
  private readonly emittedAt = new Map<IngestSurface, number[]>();

  constructor(private readonly emitter: Pick<IngestEmitter, "enqueue">, config?: Partial<ImpressionConfig>) {
    this.cfg = { ...DEFAULT_IMPRESSION_CONFIG, ...config };
    this.cfg = { ...this.cfg, maxPerSurfacePerMinute: Math.min(this.cfg.maxPerSurfacePerMinute, 30) };
  }

  get config(): ImpressionConfig {
    return this.cfg;
  }

  /** Replace the viewable set of one surface. Returns ms until the next dwell expiry, or null. */
  observe(surface: IngestSurface, viewable: readonly ImpressionItem[], nowMs: number): number | null {
    const prev = this.since.get(surface) ?? new Map();
    const next = new Map<string, ImpressionItem & { at: number }>();
    for (const item of viewable) {
      if (this.seen.has(this.key(surface, item.productId))) continue;
      next.set(item.productId, prev.get(item.productId) ?? { ...item, at: nowMs });
    }
    this.since.set(surface, next);
    return this.settle(surface, nowMs);
  }

  /** Emits items whose dwell has elapsed. Returns ms until the next expiry, or null. */
  settle(surface: IngestSurface, nowMs: number): number | null {
    const pending = this.since.get(surface);
    if (pending === undefined || pending.size === 0) return null;
    const due: (ImpressionItem & { at: number })[] = [];
    let nextWait: number | null = null;
    for (const entry of pending.values()) {
      const wait = entry.at + this.cfg.dwellMs - nowMs;
      if (wait <= 0) due.push(entry);
      else nextWait = nextWait === null ? wait : Math.min(nextWait, wait);
    }
    if (due.length > 0) {
      due.sort((a, b) => a.at - b.at || a.position - b.position);
      const sent = this.emit(surface, due, nowMs);
      for (const e of sent) pending.delete(e.productId);
      if (sent.length < due.length) nextWait = nextWait === null ? WINDOW_MS : Math.min(nextWait, WINDOW_MS);
    }
    return nextWait;
  }

  /** New session: dedupe memory, viewability state and caps are forgotten. */
  reset(): void {
    this.seen.clear();
    this.since.clear();
    this.emittedAt.clear();
  }

  private emit(surface: IngestSurface, due: readonly (ImpressionItem & { at: number })[], nowMs: number): ImpressionItem[] {
    const log = (this.emittedAt.get(surface) ?? []).filter((t) => nowMs - t < WINDOW_MS);
    const room = Math.max(0, this.cfg.maxPerSurfacePerMinute - log.length);
    const unique: (ImpressionItem & { at: number })[] = [];
    const positions = new Set<number>();
    for (const d of due) {
      if (unique.length >= Math.min(room, MAX_IMPRESSION_ITEMS)) break;
      if (positions.has(d.position)) continue;
      positions.add(d.position);
      unique.push(d);
    }
    this.emittedAt.set(surface, log);
    if (unique.length === 0) return [];
    const queued = this.emitter.enqueue({
      name: "product_impressions",
      properties: { surface, items: unique.map((u) => ({ product_id: u.productId, store_id: u.storeId, position: u.position })) },
    });
    if (!queued) return unique; // consent or gate refused: forget them, never accumulate
    for (const u of unique) {
      this.seen.add(this.key(surface, u.productId));
      log.push(nowMs);
    }
    return unique;
  }

  private key(surface: IngestSurface, productId: string): string {
    return `${surface}\u0000${productId}`;
  }
}
