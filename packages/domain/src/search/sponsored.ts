export const SPONSORED_WINDOW = 10;
export const SPONSORED_MAX_IN_WINDOW = 2;

export interface Sponsorable {
  readonly sponsored: boolean;
}

/**
 * Enforces "at most 2 sponsored in the top 10" (spec 4). Fills the window in order, deferring
 * sponsored items beyond the cap; deferred items follow the window in their original order, then
 * everything else. Organic items are never dropped and keep their relative order. A deferred
 * sponsored item that would still land inside the window (too few organic results to push it
 * below position `window`) is omitted, because the cap is a hard rule.
 */
export function capSponsored<T extends Sponsorable>(
  items: readonly T[],
  window: number = SPONSORED_WINDOW,
  maxSponsored: number = SPONSORED_MAX_IN_WINDOW,
): T[] {
  const head: T[] = [];
  const taken = new Set<number>();
  let sponsored = 0;
  for (let i = 0; i < items.length && head.length < window; i += 1) {
    const it = items[i];
    if (it === undefined) continue;
    if (it.sponsored) {
      if (sponsored >= maxSponsored) continue;
      sponsored += 1;
    }
    head.push(it);
    taken.add(i);
  }
  const out: T[] = [...head];
  items.forEach((it, i) => {
    if (taken.has(i)) return;
    if (it.sponsored && out.length < window) return;
    out.push(it);
  });
  return out;
}

export const sponsoredInTop = <T extends Sponsorable>(items: readonly T[], window: number = SPONSORED_WINDOW): number =>
  items.slice(0, window).filter((i) => i.sponsored).length;

export interface SponsoredRankState {
  /** Items emitted so far across all pages (global rank = emitted + 1 for the next item). */
  readonly emitted: number;
  /** Sponsored items among the emitted ones within the first `window` ranks. */
  readonly sponsoredTop: number;
}

/** Upper bound on carried deferred items, so a page cursor stays small. Excess is dropped (never promoted). */
export const SPONSORED_MAX_DEFERRED = 8;

/**
 * Streaming form of the cap, applied on the global ranked position and stable across pages.
 * Feed ranked items one by one through `offer`; ask `nextDeferred` for demoted sponsored items,
 * which become available only once the window (first 10 ranks) is full. The state is
 * `{ emitted, sponsoredTop }` plus the deferred items, so a cursor can resume exactly.
 */
export class SponsoredRanker<T extends Sponsorable> {
  private emitted: number;
  private sponsoredTop: number;
  private readonly deferredItems: T[];

  constructor(
    state: SponsoredRankState = { emitted: 0, sponsoredTop: 0 },
    deferred: readonly T[] = [],
    private readonly window: number = SPONSORED_WINDOW,
    private readonly maxSponsored: number = SPONSORED_MAX_IN_WINDOW,
    private readonly maxDeferred: number = SPONSORED_MAX_DEFERRED,
  ) {
    this.emitted = state.emitted;
    this.sponsoredTop = state.sponsoredTop;
    this.deferredItems = [...deferred];
  }

  get state(): SponsoredRankState {
    return { emitted: this.emitted, sponsoredTop: this.sponsoredTop };
  }

  get deferred(): readonly T[] {
    return this.deferredItems;
  }

  /** True when a deferred item can be emitted right now. */
  get hasReadyDeferred(): boolean {
    return this.emitted >= this.window && this.deferredItems.length > 0;
  }

  /** Emits the next deferred item if the window is full, else null. */
  nextDeferred(): T | null {
    if (!this.hasReadyDeferred) return null;
    const it = this.deferredItems.shift();
    if (it === undefined) return null;
    this.emitted += 1;
    return it;
  }

  /** Returns the item when it is emitted at the next rank, or null when it was demoted/dropped. */
  offer(item: T): T | null {
    if (item.sponsored && this.emitted < this.window) {
      if (this.sponsoredTop >= this.maxSponsored) {
        if (this.deferredItems.length < this.maxDeferred) this.deferredItems.push(item);
        return null;
      }
      this.sponsoredTop += 1;
    }
    this.emitted += 1;
    return item;
  }
}
