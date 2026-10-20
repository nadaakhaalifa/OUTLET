import { useCallback, useEffect, useRef } from "react";
import { getImpressionTracker } from "./registry";
import { DEFAULT_IMPRESSION_CONFIG, type ImpressionItem } from "./impressions";
import type { IngestSurface } from "./schema";

interface ViewToken<T> {
  readonly item: T | undefined;
  readonly index: number | null;
  readonly isViewable: boolean;
}

/**
 * Props for a FlashList: viewability (>= 50 % visible) feeds the tracker, which applies the dwell,
 * dedupe and per-minute cap. Inert while ingest is not configured, consent is missing or the kill
 * switch is blocked (the emitter refuses). `toItem` returns null for rows with no product.
 */
export function useImpressionTracking<T>(surface: IngestSurface, toItem: (item: T, index: number) => ImpressionItem | null) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toItemRef = useRef(toItem);
  toItemRef.current = toItem;
  const surfaceRef = useRef(surface);
  surfaceRef.current = surface;

  const arm = useCallback((wait: number | null) => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    if (wait === null) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      const t = getImpressionTracker();
      if (t !== null) arm(t.settle(surfaceRef.current, Date.now()));
    }, wait + 5);
  }, []);

  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current); }, []);

  const onViewableItemsChanged = useCallback(
    ({ viewableItems }: { viewableItems: readonly ViewToken<T>[] }) => {
      const t = getImpressionTracker();
      if (t === null) return;
      const items: ImpressionItem[] = [];
      for (const v of viewableItems) {
        if (!v.isViewable || v.item === undefined || v.index === null) continue;
        const mapped = toItemRef.current(v.item, v.index);
        if (mapped !== null) items.push(mapped);
      }
      arm(t.observe(surfaceRef.current, items, Date.now()));
    },
    [arm],
  );

  return {
    viewabilityConfig: { itemVisiblePercentThreshold: DEFAULT_IMPRESSION_CONFIG.minVisibleFraction * 100, minimumViewTime: 0 },
    onViewableItemsChanged,
  } as const;
}
