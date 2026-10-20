/** Pure grid-density model: no React, no storage. Items per row: 1, 2, 3 or 4. */

export type Density = 1 | 2 | 3 | 4;
export const DENSITIES: readonly Density[] = [1, 2, 3, 4];
export const DEFAULT_DENSITY: Density = 2;
/** Storage key (non-sensitive device preference; letters, digits, "." only). */
export const DENSITY_STORAGE_KEY = "grid.density";

/** Pinch-out (scale above this) = bigger cards = fewer per row. */
export const PINCH_SPARSER_THRESHOLD = 1.25;
/** Pinch-in (scale below this) = smaller cards = more per row. */
export const PINCH_DENSER_THRESHOLD = 0.8;

export function isDensity(v: unknown): v is Density {
  return v === 1 || v === 2 || v === 3 || v === 4;
}

export function clamp(value: number, max: Density = 4): Density {
  if (!Number.isFinite(value)) return DEFAULT_DENSITY;
  const n = Math.round(value);
  const capped = Math.min(Math.max(n, 1), max);
  return capped as Density;
}

/** One step toward more items per row (smaller cards). */
export function stepDenser(current: Density, max: Density = 4): Density {
  return clamp(current + 1, max);
}

/** One step toward fewer items per row (bigger cards). */
export function stepSparser(current: Density): Density {
  return clamp(current - 1);
}

/**
 * Maps a pinch scale to a density. Hysteresis band (0.8..1.25) means small jitters do nothing; the caller applies
 * AT MOST ONE step per gesture (see PinchToDensity), so there is no oscillation while fingers stay down.
 */
export function pinchToDensity(current: Density, scale: number, max: Density = 4): Density {
  if (!Number.isFinite(scale) || scale <= 0) return clamp(current, max);
  if (scale > PINCH_SPARSER_THRESHOLD) return stepSparser(clamp(current, max));
  if (scale < PINCH_DENSER_THRESHOLD) return stepDenser(clamp(current, max), max);
  return clamp(current, max);
}

/**
 * Large text needs wide cards: 2 columns from fontScale 1.5, 3 from 1.3 (phone rule, unchanged).
 * `zoomed` (a regular or expanded iPad window) skips the cap: the adaptive grid already grows `minCard` with large text
 * (ui-native `columnsFor`), so the preference itself is not capped a second time.
 */
export function maxDensityForFontScale(fontScale: number, zoomed = false): Density {
  if (zoomed) return 4;
  if (fontScale >= 1.5) return 2;
  if (fontScale >= 1.3) return 3;
  return 4;
}

/** Densities offered at this font scale. 1 is always allowed. */
export function allowedDensities(fontScale: number, zoomed = false): readonly Density[] {
  const max = maxDensityForFontScale(fontScale, zoomed);
  return DENSITIES.filter((d) => d <= max);
}

/** Toggle order: 2 -> 3 -> 4 -> 1 -> 2, skipping values above the cap. */
const CYCLE: readonly Density[] = [2, 3, 4, 1];
export function cycleDensity(current: Density, max: Density = 4): Density {
  const i = CYCLE.indexOf(current);
  for (let step = 1; step <= CYCLE.length; step += 1) {
    const candidate = CYCLE[(i + step) % CYCLE.length];
    if (candidate !== undefined && candidate <= max) return candidate;
  }
  return 1;
}

/** Card width in points for a container: margins on both sides, gutter between columns. */
export function columnWidth(containerWidth: number, density: Density, gutter: number, margin: number): number {
  const usable = containerWidth - margin * 2 - gutter * (density - 1);
  return Math.max(0, Math.floor(usable / density));
}

export type HeartMode = "full" | "small" | "longPress";

export interface CardDetailLevel {
  readonly showStore: boolean;
  readonly showName: boolean;
  readonly nameLines: number;
  readonly showPrice: boolean;
  readonly heart: HeartMode;
  /** Visual heart disc size in points (0 when not drawn). */
  readonly heartSize: number;
  /** Extra hit slop so the heart target is at least 44pt. */
  readonly heartHitSlop: number;
  readonly wholeCardTappable: true;
}

/** What a card may show per density. Density 4 is image + price only; heart is on long press. */
export function cardDetailLevel(density: Density): CardDetailLevel {
  switch (density) {
    case 1:
    case 2:
      return { showStore: true, showName: true, nameLines: 2, showPrice: true, heart: "full", heartSize: 36, heartHitSlop: 4, wholeCardTappable: true };
    case 3:
      return { showStore: false, showName: true, nameLines: 1, showPrice: true, heart: "small", heartSize: 24, heartHitSlop: 10, wholeCardTappable: true };
    case 4:
      return { showStore: false, showName: false, nameLines: 0, showPrice: true, heart: "longPress", heartSize: 0, heartHitSlop: 0, wholeCardTappable: true };
  }
}

/**
 * Detail level for a card of a given EFFECTIVE width (physical width / zoom): the nominal card widths per density are
 * 358 / 175 / 114 / 84, so the boundaries sit at their midpoints. Used on regular and expanded windows, where a card's
 * width no longer follows the density preference; compact windows keep the density itself.
 */
export function detailDensityForWidth(effectiveCardWidth: number): Density {
  if (!Number.isFinite(effectiveCardWidth)) return DEFAULT_DENSITY;
  if (effectiveCardWidth >= 145) return 2;
  if (effectiveCardWidth >= 99) return 3;
  return 4;
}

const NOMINAL_WIDTH: Record<Density, number> = { 1: 358, 2: 175, 3: 114, 4: 84 };
const IMAGE_BUCKET = 64;
/** Largest image request in pixels (rendered width x pixel ratio, capped; raised from 1200 for iPad windows). */
const IMAGE_MAX = 1600;

/** Pixel width to request: column points x pixel ratio, rounded up to a 64px bucket (cache reuse), capped. */
export function imageWidthRequest(density: Density, pixelRatio: number, columnWidthPt?: number): number {
  const pt = columnWidthPt !== undefined && columnWidthPt > 0 ? columnWidthPt : NOMINAL_WIDTH[density];
  const ratio = Number.isFinite(pixelRatio) && pixelRatio > 0 ? Math.min(pixelRatio, 3) : 2;
  const raw = Math.ceil(pt * ratio);
  return Math.min(IMAGE_MAX, Math.ceil(raw / IMAGE_BUCKET) * IMAGE_BUCKET);
}

export function parseDensity(raw: string | null | undefined): Density {
  if (raw === null || raw === undefined) return DEFAULT_DENSITY;
  const n = Number(raw.trim());
  return isDensity(n) ? n : DEFAULT_DENSITY;
}

export function serializeDensity(density: Density): string {
  return String(density);
}

/**
 * Index to scroll back to after the column count changes: the item that was first visible, so the user keeps their
 * place. Unknown or missing id falls back to 0.
 */
export function anchorIndexAfterChange(items: readonly { readonly id: string }[], firstVisibleId: string | null | undefined): number {
  if (firstVisibleId === null || firstVisibleId === undefined) return 0;
  const i = items.findIndex((x) => x.id === firstVisibleId);
  return i < 0 ? 0 : i;
}
