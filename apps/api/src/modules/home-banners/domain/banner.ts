/**
 * Home banners: pure domain (no framework, no IO). Visibility is decided by SERVER time only: every
 * function that needs a clock takes `nowMs` as an argument and the API passes its own clock, never a
 * client value. No targeting input exists here; budget, affordability and any per-user financial
 * signal must never be added (spec 12 and 17). Money is integer piastres (bigint).
 */

export const MAX_SLIDES = 8;
/** At most 1 sponsored slide in any window of 3 consecutive slides. */
export const SPONSORED_WINDOW = 3;
export const MAX_WINDOW_DAYS = 90;
export const MAX_PRICE_PIASTRES = 100_000_000n;
export const LIMITS = { title: 60, subtitle: 120, query: 80, sponsorRef: 80, priority: 1000 } as const;

export const CTA_KINDS = ["drop", "store", "category", "search", "voucher"] as const;
export type CtaKind = (typeof CTA_KINDS)[number];
export const ART_VARIANTS = ["warm", "cool", "neutral", "festive"] as const;
export type ArtVariant = (typeof ART_VARIANTS)[number];
export const BANNER_STATUSES = ["draft", "scheduled", "paused"] as const;
export type BannerStatus = (typeof BANNER_STATUSES)[number];
export type BannerLifecycle = "draft" | "scheduled" | "live" | "expired" | "paused";

/** CTA: typed, never a URL. Ids are opaque tokens, queries are short plain text, bounds are piastres. */
export type BannerCta =
  | { readonly kind: "drop" | "store" | "voucher"; readonly targetId: string }
  | { readonly kind: "category"; readonly targetId: string; readonly priceMin: bigint | null; readonly priceMax: bigint | null }
  | { readonly kind: "search"; readonly query: string; readonly priceMin: bigint | null; readonly priceMax: bigint | null };

export interface HomeBanner {
  readonly id: string;
  readonly status: BannerStatus;
  readonly titleAr: string;
  readonly titleEn: string | null;
  readonly subtitleAr: string | null;
  readonly subtitleEn: string | null;
  /** Object-store key (no scheme, no host). The wire layer signs or resolves it; never a URL here. */
  readonly imageKey: string | null;
  readonly artVariant: ArtVariant | null;
  readonly priority: number;
  readonly startsAtMs: number;
  readonly endsAtMs: number;
  readonly sponsored: boolean;
  /** Ads or finance reference. Present if and only if `sponsored`. */
  readonly sponsorRef: string | null;
  readonly cta: BannerCta;
  readonly createdBy: string;
  readonly updatedBy: string;
  readonly version: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

/** What an editor supplies. Identity, version and timestamps are assigned by the application. */
export type BannerDraft = Omit<HomeBanner, "id" | "status" | "createdBy" | "updatedBy" | "version" | "createdAtMs" | "updatedAtMs">;

export interface Problem {
  readonly pointer: string;
  readonly code: string;
}

const ID_TOKEN = /^[A-Za-z0-9_-]{1,64}$/;
const SPONSOR_REF = /^[A-Za-z0-9._:-]{3,80}$/;
/** Object-store key shape: path segments of [A-Za-z0-9_-]; no scheme, no host, no dot, no traversal. */
const IMAGE_KEY = /^[a-z0-9][a-z0-9_-]*(\/[A-Za-z0-9_-]+)+$/;
const URLISH = /(:\/\/|^www\.|^[a-z][a-z0-9+.-]*:)/i;

const within = (s: string, max: number): boolean => s.length >= 1 && s.length <= max;

export function validateCta(cta: BannerCta): Problem[] {
  const p: Problem[] = [];
  const bound = (v: bigint | null, at: string) => {
    if (v !== null && (v < 0n || v > MAX_PRICE_PIASTRES)) p.push({ pointer: `/cta/${at}`, code: "out_of_range" });
  };
  switch (cta.kind) {
    case "drop":
    case "store":
    case "voucher":
      if (!ID_TOKEN.test(cta.targetId)) p.push({ pointer: "/cta/target_id", code: "invalid" });
      break;
    case "category":
      if (!ID_TOKEN.test(cta.targetId)) p.push({ pointer: "/cta/target_id", code: "invalid" });
      bound(cta.priceMin, "price_min");
      bound(cta.priceMax, "price_max");
      if (cta.priceMin !== null && cta.priceMax !== null && cta.priceMin > cta.priceMax) p.push({ pointer: "/cta/price_min", code: "exceeds_max" });
      break;
    case "search":
      if (!within(cta.query, LIMITS.query) || cta.query.trim() !== cta.query) p.push({ pointer: "/cta/query", code: "invalid" });
      else if (URLISH.test(cta.query)) p.push({ pointer: "/cta/query", code: "url_not_allowed" });
      bound(cta.priceMin, "price_min");
      bound(cta.priceMax, "price_max");
      if (cta.priceMin !== null && cta.priceMax !== null && cta.priceMin > cta.priceMax) p.push({ pointer: "/cta/price_min", code: "exceeds_max" });
      break;
  }
  return p;
}

export function validateWindow(startsAtMs: number, endsAtMs: number): Problem[] {
  if (!Number.isFinite(startsAtMs) || !Number.isFinite(endsAtMs)) return [{ pointer: "/starts_at", code: "invalid" }];
  if (startsAtMs >= endsAtMs) return [{ pointer: "/ends_at", code: "must_follow_starts_at" }];
  if (endsAtMs - startsAtMs > MAX_WINDOW_DAYS * 86_400_000) return [{ pointer: "/ends_at", code: "window_too_long" }];
  return [];
}

/** Full draft validation. The same rules are repeated as CHECK constraints in migration 0084. */
export function validateDraft(d: BannerDraft): Problem[] {
  const p: Problem[] = [];
  if (!within(d.titleAr.trim(), LIMITS.title) || d.titleAr.length > LIMITS.title) p.push({ pointer: "/title/ar", code: "invalid" });
  if (d.titleEn !== null && !within(d.titleEn, LIMITS.title)) p.push({ pointer: "/title/en", code: "invalid" });
  if (d.subtitleAr !== null && !within(d.subtitleAr, LIMITS.subtitle)) p.push({ pointer: "/subtitle/ar", code: "invalid" });
  if (d.subtitleEn !== null && !within(d.subtitleEn, LIMITS.subtitle)) p.push({ pointer: "/subtitle/en", code: "invalid" });
  if (d.subtitleEn !== null && d.subtitleAr === null) p.push({ pointer: "/subtitle/ar", code: "required_with_en" });
  if (d.imageKey !== null && (d.imageKey.length < 10 || d.imageKey.length > 200 || !IMAGE_KEY.test(d.imageKey))) p.push({ pointer: "/image_key", code: "invalid" });
  if (d.artVariant !== null && !(ART_VARIANTS as readonly string[]).includes(d.artVariant)) p.push({ pointer: "/art_variant", code: "invalid" });
  if (!Number.isInteger(d.priority) || d.priority < 0 || d.priority > LIMITS.priority) p.push({ pointer: "/priority", code: "out_of_range" });
  p.push(...validateWindow(d.startsAtMs, d.endsAtMs));
  if (d.sponsored && d.sponsorRef === null) p.push({ pointer: "/sponsor_ref", code: "required_when_sponsored" });
  if (!d.sponsored && d.sponsorRef !== null) p.push({ pointer: "/sponsor_ref", code: "only_when_sponsored" });
  if (d.sponsorRef !== null && !SPONSOR_REF.test(d.sponsorRef)) p.push({ pointer: "/sponsor_ref", code: "invalid" });
  p.push(...validateCta(d.cta));
  return p;
}

// ---- schedule (server time) -------------------------------------------------------------------------

/** Live iff scheduled and starts_at <= now < ends_at. The caller supplies the SERVER clock. */
export const isLive = (b: Pick<HomeBanner, "status" | "startsAtMs" | "endsAtMs">, nowMs: number): boolean =>
  b.status === "scheduled" && b.startsAtMs <= nowMs && nowMs < b.endsAtMs;

export function lifecycleOf(b: Pick<HomeBanner, "status" | "startsAtMs" | "endsAtMs">, nowMs: number): BannerLifecycle {
  if (b.status === "draft") return "draft";
  if (b.status === "paused") return "paused";
  if (nowMs >= b.endsAtMs) return "expired";
  return nowMs >= b.startsAtMs ? "live" : "scheduled";
}

export type TransitionAction = "schedule" | "pause" | "resume";
const NEXT: Readonly<Record<TransitionAction, { readonly from: BannerStatus; readonly to: BannerStatus }>> = {
  schedule: { from: "draft", to: "scheduled" },
  pause: { from: "scheduled", to: "paused" },
  resume: { from: "paused", to: "scheduled" },
};

export type TransitionResult =
  | { readonly kind: "ok"; readonly status: BannerStatus }
  | { readonly kind: "invalid_state"; readonly status: BannerStatus }
  | { readonly kind: "window_elapsed" };

/** Scheduling or resuming a banner whose window already ended is refused: it could never show. */
export function transition(b: Pick<HomeBanner, "status" | "endsAtMs">, action: TransitionAction, nowMs: number): TransitionResult {
  const rule = NEXT[action];
  if (b.status !== rule.from) return { kind: "invalid_state", status: b.status };
  if (rule.to === "scheduled" && nowMs >= b.endsAtMs) return { kind: "window_elapsed" };
  return { kind: "ok", status: rule.to };
}

// ---- ordering and composition -----------------------------------------------------------------------

/** Priority descending, then earlier start first, then id (total, deterministic order). */
export function compareForDisplay(a: HomeBanner, b: HomeBanner): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  if (a.startsAtMs !== b.startsAtMs) return a.startsAtMs - b.startsAtMs;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Builds the carousel. Live banners only, in display order, at most `max` (8) slides, and no
 * SPONSORED_WINDOW (3) consecutive slides hold more than one sponsored banner. A sponsored banner that
 * would break the rule is deferred until enough organic slides sit before it; if none arrive it is
 * dropped (never reordered ahead of its priority peers otherwise).
 */
export function composeSlides(candidates: readonly HomeBanner[], nowMs: number, max: number = MAX_SLIDES): HomeBanner[] {
  const pending = candidates.filter((b) => isLive(b, nowMs)).sort(compareForDisplay);
  const out: HomeBanner[] = [];
  const cap = Math.min(max, MAX_SLIDES);
  while (out.length < cap) {
    const lastSponsored = out.map((s) => s.sponsored).lastIndexOf(true);
    const gapOk = lastSponsored === -1 || out.length - lastSponsored >= SPONSORED_WINDOW;
    const i = pending.findIndex((b) => !b.sponsored || gapOk);
    if (i === -1) break;
    const [next] = pending.splice(i, 1);
    if (next !== undefined) out.push(next);
  }
  return out;
}

/** Sponsored slides must always show this label; the shopper app renders it from `sponsored: true`. */
export const SPONSORED_LABEL = { ar: "إعلان", en: "Sponsored" } as const;
export const sponsoredLabel = (b: Pick<HomeBanner, "sponsored">): typeof SPONSORED_LABEL | null => (b.sponsored ? SPONSORED_LABEL : null);
