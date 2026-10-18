/**
 * Home offers carousel (owner request: in-app offer banners, swiped every 7 s).
 * Pure model: wire contract, normalisation, time-window selection, auto-advance state machine, index and RTL math,
 * cta -> route mapping. No UI imports. Never opens arbitrary URLs: navigation is by a closed, typed `cta`.
 */
import type { HeroVariant } from "../../art/art-geometry";

export const AUTO_ADVANCE_MS = 10000;
export const MAX_SLIDES = 8;

export type CtaKind = "drop" | "store" | "category" | "search" | "voucher";
export const CTA_KINDS: readonly CtaKind[] = ["drop", "store", "category", "search", "voucher"];
export type ArtVariant = "drop" | "sale" | "plus" | "eid" | "tide" | "atelier";
const ART_VARIANTS: readonly ArtVariant[] = ["drop", "sale", "plus", "eid", "tide", "atelier"];

export type DevImageKey = "hero" | "promo";

export interface LocalizedWire { readonly ar: string; readonly en?: string | undefined }

/** Wire shape of GET /v1/home/banners (operationId listHomeBanners). Money is integer piastres. */
export interface HomeBannerWire {
  readonly id: string;
  readonly title: LocalizedWire;
  readonly subtitle?: LocalizedWire | undefined;
  readonly image_url?: string | undefined;
  /** Optional small tracked line above the title (hero). */
  readonly eyebrow?: LocalizedWire | undefined;
  /** Optional big promo figure, e.g. "70% OFF" (promo card). Null in production unless the API sends it. */
  readonly promo_percent_label?: string | undefined;
  /** DEV fixtures only: key of a bundled fixture photo. Never set by the API adapter. */
  readonly dev_image?: DevImageKey | undefined;
  readonly art_variant?: ArtVariant | undefined;
  readonly sponsored: boolean;
  readonly starts_at: string;
  readonly ends_at: string;
  readonly cta: {
    readonly kind: CtaKind;
    readonly target_id?: string | undefined;
    readonly query?: string | undefined;
    readonly price_min?: number | undefined;
    readonly price_max?: number | undefined;
  };
}
export interface HomeBannersWire { readonly items: readonly HomeBannerWire[]; readonly server_time: string }

export interface BannerCta {
  readonly kind: CtaKind;
  readonly targetId: string | null;
  readonly query: string | null;
  readonly priceMin: number | null;
  readonly priceMax: number | null;
}

export interface HomeBanner {
  readonly id: string;
  readonly title: { readonly ar: string; readonly en: string };
  readonly subtitle: { readonly ar: string; readonly en: string } | null;
  /** https image only; the UI falls back to art when absent or failing to load. */
  readonly imageUrl: string | null;
  readonly eyebrow: { readonly ar: string; readonly en: string } | null;
  readonly promoPercentLabel: string | null;
  readonly devImage: DevImageKey | null;
  readonly art: HeroVariant;
  readonly sponsored: boolean;
  readonly startsAtMs: number;
  readonly endsAtMs: number;
  readonly cta: BannerCta;
}

export interface HomeBannersData {
  readonly serverNowMs: number;
  readonly banners: readonly HomeBanner[];
  /** True only for the in-memory dev fixtures; enables bundled fixture photos in the UI (never set in production). */
  readonly devFixtures?: boolean | undefined;
}

export interface HomeBannersPort { load(): Promise<HomeBannersData> }

/* ---------------- normalisation ---------------- */

const NON_EMPTY = (s: unknown): s is string => typeof s === "string" && s.trim().length > 0;
function localized(t: LocalizedWire | undefined): { ar: string; en: string } | null {
  if (t === undefined || !NON_EMPTY(t.ar)) return null;
  return { ar: t.ar.trim(), en: NON_EMPTY(t.en) ? t.en.trim() : t.ar.trim() };
}
function nonNegInt(n: number | undefined): number | null {
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : null;
}
function safeHttps(u: string | undefined): string | null {
  return typeof u === "string" && /^https:\/\/[^\s]+$/i.test(u) ? u : null;
}
const DEFAULT_ART: Record<CtaKind, ArtVariant> = { drop: "drop", store: "atelier", category: "tide", search: "sale", voucher: "sale" };

/** Returns null when the wire item is unusable (it is then dropped, never repaired or invented). */
export function normaliseBanner(w: HomeBannerWire): HomeBanner | null {
  if (!NON_EMPTY(w.id)) return null;
  const title = localized(w.title);
  if (title === null) return null;
  const startsAtMs = Date.parse(w.starts_at);
  const endsAtMs = Date.parse(w.ends_at);
  if (!Number.isFinite(startsAtMs) || !Number.isFinite(endsAtMs) || endsAtMs <= startsAtMs) return null;
  if (!CTA_KINDS.includes(w.cta.kind)) return null;
  const targetId = NON_EMPTY(w.cta.target_id) ? w.cta.target_id.trim() : null;
  const query = NON_EMPTY(w.cta.query) ? w.cta.query.trim() : null;
  const priceMin = nonNegInt(w.cta.price_min);
  const priceMax = nonNegInt(w.cta.price_max);
  if (priceMin !== null && priceMax !== null && priceMin > priceMax) return null;
  const k = w.cta.kind;
  if ((k === "drop" || k === "store" || k === "category") && targetId === null) return null;
  if (k === "search" && query === null && priceMin === null && priceMax === null) return null;
  const art = w.art_variant !== undefined && ART_VARIANTS.includes(w.art_variant) ? w.art_variant : DEFAULT_ART[k];
  return {
    id: w.id.trim(),
    title,
    subtitle: localized(w.subtitle),
    imageUrl: safeHttps(w.image_url),
    eyebrow: localized(w.eyebrow),
    promoPercentLabel: NON_EMPTY(w.promo_percent_label) ? w.promo_percent_label.trim() : null,
    devImage: w.dev_image === "hero" || w.dev_image === "promo" ? w.dev_image : null,
    art,
    sponsored: w.sponsored === true,
    startsAtMs,
    endsAtMs,
    cta: { kind: k, targetId, query, priceMin, priceMax },
  };
}

export function normaliseBanners(w: HomeBannersWire): HomeBannersData {
  const seen = new Set<string>();
  const banners: HomeBanner[] = [];
  for (const item of w.items) {
    const b = normaliseBanner(item);
    if (b === null || seen.has(b.id)) continue;
    seen.add(b.id);
    banners.push(b);
  }
  const serverNowMs = Date.parse(w.server_time);
  return { serverNowMs: Number.isFinite(serverNowMs) ? serverNowMs : Date.now(), banners };
}

/** Active window by SERVER time: starts_at <= now < ends_at. Server order is kept (the CMS owns ordering and sponsor caps). */
export function selectSlides(banners: readonly HomeBanner[], serverNowMs: number, limit: number = MAX_SLIDES): readonly HomeBanner[] {
  return banners.filter((b) => b.startsAtMs <= serverNowMs && serverNowMs < b.endsAtMs).slice(0, limit);
}

/** Earliest instant the active set changes (an end or a start), so the UI can re-select without polling. Null when stable. */
export function nextBoundaryMs(banners: readonly HomeBanner[], serverNowMs: number): number | null {
  let best: number | null = null;
  for (const b of banners) {
    for (const t of [b.startsAtMs, b.endsAtMs]) if (t > serverNowMs && (best === null || t < best)) best = t;
  }
  return best;
}

/* ---------------- cta -> route ---------------- */

export type BannerRoute =
  | { readonly pathname: "/drops"; readonly params: { readonly id: string } }
  | { readonly pathname: "/shop-all"; readonly params: Readonly<Record<string, string>> }
  | { readonly pathname: "/rewards"; readonly params: Readonly<Record<string, never>> };

/** Wire price bounds are integer piastres; /shop-all reads whole EGP (min rounds down, max rounds up: never hides a match). */
const toEgpFloor = (p: number): string => String(Math.floor(p / 100));
const toEgpCeil = (p: number): string => String(Math.ceil(p / 100));

/**
 * Closed mapping to in-app routes. Everything that lists products goes to /shop-all (it reads
 * store, category, q, min, max); the search route only reads q.
 */
export function routeForCta(cta: BannerCta): BannerRoute {
  switch (cta.kind) {
    case "drop":
      return { pathname: "/drops", params: { id: cta.targetId ?? "" } };
    case "store":
      return { pathname: "/shop-all", params: { store: cta.targetId ?? "" } };
    case "category":
    case "search": {
      const params: Record<string, string> = {};
      if (cta.kind === "category" && cta.targetId !== null) params["category"] = cta.targetId;
      if (cta.query !== null) params["q"] = cta.query;
      if (cta.priceMin !== null) params["min"] = toEgpFloor(cta.priceMin);
      if (cta.priceMax !== null) params["max"] = toEgpCeil(cta.priceMax);
      return { pathname: "/shop-all", params };
    }
    case "voucher":
      // No voucher-detail route exists yet: rewards is the in-app home for vouchers and coins.
      return { pathname: "/rewards", params: {} };
  }
}

/* ---------------- index math ---------------- */

/** Wrap any integer into [0, n). */
export function wrapIndex(i: number, n: number): number {
  if (n <= 0) return 0;
  return ((i % n) + n) % n;
}
export function stepIndex(i: number, step: number, n: number): number {
  return wrapIndex(i + step, n);
}
/** Physical direction multiplier: slot +1 (the next slide) sits to the right in LTR and to the left in RTL. */
export function dirOf(isRTL: boolean): 1 | -1 {
  return isRTL ? -1 : 1;
}
/** Physical x of a slot (-1 previous, 0 current, +1 next) for a drag offset. */
export function slotX(slot: -1 | 0 | 1, width: number, isRTL: boolean, drag: number): number {
  return dirOf(isRTL) * slot * width + drag;
}
/** Physical drag value at which a step of +1 / -1 has fully landed. */
export function dragTarget(step: -1 | 0 | 1, width: number, isRTL: boolean): number {
  return -dirOf(isRTL) * step * width;
}
/** Decide the step from a released drag. Forward = toward the next slide in reading direction. */
export function settleStep(translationX: number, velocityX: number, width: number, isRTL: boolean, n: number): -1 | 0 | 1 {
  if (n < 2 || width <= 0) return 0;
  const d = dirOf(isRTL);
  const moved = -translationX * d;
  const v = -velocityX * d;
  if (moved > width * 0.25 || v > 0.5) return 1;
  if (moved < -width * 0.25 || v < -0.5) return -1;
  return 0;
}

/* ---------------- auto-advance state machine ---------------- */

export type PauseReason = "touch" | "background" | "blurred" | "reduceMotion" | "empty";
export interface AutoState { readonly index: number; readonly count: number; readonly pauses: readonly PauseReason[] }

export function initAuto(count: number): AutoState {
  return { index: 0, count, pauses: [] };
}
/** Number of slides changed (new data): keep the index in range. */
export function withCount(s: AutoState, count: number): AutoState {
  return { ...s, count, index: count === 0 ? 0 : Math.min(s.index, count - 1) };
}
export function pause(s: AutoState, r: PauseReason): AutoState {
  return s.pauses.includes(r) ? s : { ...s, pauses: [...s.pauses, r] };
}
export function resume(s: AutoState, r: PauseReason): AutoState {
  return s.pauses.includes(r) ? { ...s, pauses: s.pauses.filter((x) => x !== r) } : s;
}
/** The 7 s timer exists only with 2+ slides and no pause reason. */
export function timerActive(s: AutoState): boolean {
  return s.count >= 2 && s.pauses.length === 0;
}
/** Timer fired: advance one slide with loop. No-op when the timer should not be running. */
export function tick(s: AutoState): AutoState {
  return timerActive(s) ? { ...s, index: stepIndex(s.index, 1, s.count) } : s;
}
/** User swipe or dot tap. */
export function goTo(s: AutoState, index: number): AutoState {
  return s.count === 0 ? s : { ...s, index: wrapIndex(index, s.count) };
}

/* ---------------- impressions + analytics ---------------- */

export interface BannerAnalyticsEvent {
  readonly bannerId: string;
  readonly position: number;
  readonly kind: CtaKind;
  readonly sponsored: boolean;
}
/** No PII: opaque banner id, slot, cta kind. Consent gating lives in the adapter behind this port. */
export interface BannerAnalyticsPort {
  impression(e: BannerAnalyticsEvent): void;
  click(e: BannerAnalyticsEvent): void;
}
export class NullBannerAnalytics implements BannerAnalyticsPort {
  impression(): void {}
  click(): void {}
}
export class RecordingBannerAnalytics implements BannerAnalyticsPort {
  readonly impressions: BannerAnalyticsEvent[] = [];
  readonly clicks: BannerAnalyticsEvent[] = [];
  impression(e: BannerAnalyticsEvent): void { this.impressions.push(e); }
  click(e: BannerAnalyticsEvent): void { this.clicks.push(e); }
}
/** One impression per banner id per mounted carousel. */
export class ImpressionOnce {
  private readonly seen = new Set<string>();
  take(id: string): boolean {
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    return true;
  }
}

/* ---------------- in-memory fake (dev default) ---------------- */

const HOUR = 3_600_000;
export function fixtureBannersWire(nowMs: number): HomeBannersWire {
  const iso = (ms: number) => new Date(ms).toISOString();
  const window = { starts_at: iso(nowMs - HOUR), ends_at: iso(nowMs + 72 * HOUR) };
  return {
    server_time: iso(nowMs),
    items: [
      { id: "bn-1", title: { ar: "الفخامة بسعر أقل", en: "Luxury for less" }, eyebrow: { ar: "الإصدار الجديد", en: "THE NEW EDIT" }, subtitle: { ar: "ماركات عالمية. أسعار استثنائية.", en: "Iconic brands. Exceptional prices." }, dev_image: "hero", art_variant: "atelier", sponsored: false, ...window, cta: { kind: "search", query: "new" } },
      { id: "bn-2", title: { ar: "قطع تحت ٥٠٠ جنيه", en: "Pieces under 500 EGP" }, subtitle: { ar: "أسعار حقيقية موثقة", en: "Verified real prices" }, dev_image: "hero", art_variant: "sale", sponsored: false, ...window, cta: { kind: "search", price_max: 50_000 } },
      { id: "bn-3", title: { ar: "فساتين الموسم", en: "Dresses of the season" }, dev_image: "hero", art_variant: "tide", sponsored: false, ...window, cta: { kind: "category", target_id: "dresses" } },
      { id: "bn-4", title: { ar: "ماركات وتصاميم مختارة", en: "Selected brands & styles" }, promo_percent_label: "70%", dev_image: "promo", art_variant: "sale", sponsored: true, ...window, cta: { kind: "search", query: "sale" } },
    ],
  };
}
export class InMemoryHomeBannersPort implements HomeBannersPort {
  constructor(private readonly nowMs: () => number = () => Date.now(), private readonly wire?: HomeBannersWire) {}
  async load(): Promise<HomeBannersData> {
    return { ...normaliseBanners(this.wire ?? fixtureBannersWire(this.nowMs())), devFixtures: true };
  }
}
