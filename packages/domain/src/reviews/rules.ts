import {
  DEFAULT_REVIEW_CONFIG,
  FIT_VALUES,
  REVIEW_LIMITS,
  type DeliveredLine,
  type FitValue,
  type RatingCounts,
  type ReviewRulesConfig,
  type ReviewSummary,
} from "./types";

export interface FieldError {
  readonly field: string;
  readonly code: string;
}

export type Validated<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly errors: readonly FieldError[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

const cpLen = (s: string): number => Array.from(s).length;

/** Trim and Unicode normalise (NFC). Arabic letters and digits are left as typed. */
export function cleanText(s: string): string {
  return s.normalize("NFC").trim();
}

function text(field: string, raw: string, min: number, max: number, errs: FieldError[]): string {
  const v = cleanText(raw);
  const n = cpLen(v);
  if (n < min) errs.push({ field, code: n === 0 ? "required" : "too_short" });
  else if (n > max) errs.push({ field, code: "too_long" });
  else if (CONTROL.test(v)) errs.push({ field, code: "invalid_characters" });
  return v;
}

export interface ReviewDraftInput {
  readonly rating: number;
  readonly title?: string | null;
  readonly body: string;
  readonly fit?: FitValue | null;
  readonly fitArea?: string | null;
  readonly photoIds?: readonly string[];
}

export interface ReviewDraft {
  readonly rating: number;
  readonly title: string | null;
  readonly body: string;
  readonly fit: FitValue | null;
  readonly fitArea: string | null;
  readonly photoIds: readonly string[];
}

export function validateReviewDraft(input: ReviewDraftInput): Validated<ReviewDraft> {
  const errs: FieldError[] = [];
  if (!Number.isInteger(input.rating) || input.rating < REVIEW_LIMITS.ratingMin || input.rating > REVIEW_LIMITS.ratingMax) {
    errs.push({ field: "rating", code: "out_of_range" });
  }
  const body = text("body", input.body, REVIEW_LIMITS.bodyMin, REVIEW_LIMITS.bodyMax, errs);
  let title: string | null = null;
  if (input.title !== undefined && input.title !== null && cleanText(input.title).length > 0) {
    title = text("title", input.title, 1, REVIEW_LIMITS.titleMax, errs);
  }
  const fit = input.fit ?? null;
  if (fit !== null && !FIT_VALUES.includes(fit)) errs.push({ field: "fit", code: "invalid" });
  let fitArea: string | null = null;
  if (input.fitArea !== undefined && input.fitArea !== null && cleanText(input.fitArea).length > 0) {
    if (fit === null) errs.push({ field: "fit_area", code: "requires_fit" });
    fitArea = text("fit_area", input.fitArea, 1, REVIEW_LIMITS.fitAreaMax, errs);
  }
  const photoIds = (input.photoIds ?? []).map((p) => p.toLowerCase());
  if (photoIds.length > REVIEW_LIMITS.photosMax) errs.push({ field: "photo_ids", code: "too_many" });
  if (photoIds.some((p) => !UUID.test(p))) errs.push({ field: "photo_ids", code: "invalid" });
  if (new Set(photoIds).size !== photoIds.length) errs.push({ field: "photo_ids", code: "duplicate" });
  if (errs.length > 0) return { ok: false, errors: errs };
  return { ok: true, value: { rating: input.rating, title, body, fit, fitArea, photoIds } };
}

export function validateShortText(
  field: string,
  raw: string,
  kind: "reply" | "question" | "answer",
): Validated<string> {
  const errs: FieldError[] = [];
  const [min, max] =
    kind === "reply"
      ? [1, REVIEW_LIMITS.replyMax]
      : kind === "question"
        ? [REVIEW_LIMITS.questionMin, REVIEW_LIMITS.questionMax]
        : [REVIEW_LIMITS.answerMin, REVIEW_LIMITS.answerMax];
  const v = text(field, raw, min, max, errs);
  return errs.length > 0 ? { ok: false, errors: errs } : { ok: true, value: v };
}

export type EligibilityResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "not_buyer" | "self_review" | "window_elapsed" };

/**
 * Verified purchase only: the line must be the reviewer's own, delivered, and from a store the
 * reviewer neither owns nor works for. Delivery is established by the caller (the port only
 * returns delivered lines); the window runs from the courier confirmed delivery time.
 */
export function checkReviewEligibility(input: {
  readonly line: DeliveredLine;
  readonly reviewerUserId: string;
  readonly reviewerStoreIds: readonly string[];
  readonly nowMs: number;
  readonly cfg?: ReviewRulesConfig;
}): EligibilityResult {
  const cfg = input.cfg ?? DEFAULT_REVIEW_CONFIG;
  if (input.line.userId !== input.reviewerUserId) return { ok: false, reason: "not_buyer" };
  if (input.reviewerStoreIds.includes(input.line.storeId)) return { ok: false, reason: "self_review" };
  if (input.nowMs - input.line.deliveredAtMs > cfg.reviewWindowMs) return { ok: false, reason: "window_elapsed" };
  return { ok: true };
}

/**
 * Coins are for honest, useful reviews (photos, fit info), never for sentiment (spec 27, 15.5).
 * The signature deliberately has no rating: the intent cannot depend on it.
 */
export interface ReviewRewardIntent {
  readonly kind: "review_coins";
  readonly orderLineId: string;
  readonly hasPhoto: boolean;
  readonly hasFitInfo: boolean;
}

export function reviewRewardIntent(input: {
  readonly orderLineId: string;
  readonly photoCount: number;
  readonly fit: FitValue | null;
}): ReviewRewardIntent {
  return {
    kind: "review_coins",
    orderLineId: input.orderLineId,
    hasPhoto: input.photoCount > 0,
    hasFitInfo: input.fit !== null,
  };
}

/** Aggregate from real published ratings only. Fewer than the minimum shows nothing (null). */
export function summarizeRatings(
  counts: RatingCounts,
  cfg: ReviewRulesConfig = DEFAULT_REVIEW_CONFIG,
): ReviewSummary | null {
  const by = counts.byStar;
  const count = by[0] + by[1] + by[2] + by[3] + by[4];
  if (count < Math.max(1, cfg.minAggregateCount)) return null;
  const sum = by[0] + 2 * by[1] + 3 * by[2] + 4 * by[3] + 5 * by[4];
  const averageTenths = Math.floor((sum * 20 + count) / (2 * count));
  return { count, averageTenths, distribution: by };
}

/** First letter of the first name, upper-cased. Anything else gives null: no initial, no PII. */
export function reviewerInitial(firstName: string | null): string | null {
  if (firstName === null) return null;
  const first = Array.from(firstName.normalize("NFC").trim())[0];
  if (first === undefined || !/^\p{L}$/u.test(first)) return null;
  return first.toUpperCase();
}

const ARABIC_INDIC = "٠١٢٣٤٥٦٧٨٩";
const EXT_ARABIC_INDIC = "۰۱۲۳۴۵۶۷۸۹";

export function toAsciiDigits(s: string): string {
  let out = "";
  for (const ch of s) {
    const a = ARABIC_INDIC.indexOf(ch);
    const b = EXT_ARABIC_INDIC.indexOf(ch);
    out += a >= 0 ? String(a) : b >= 0 ? String(b) : ch;
  }
  return out;
}

/** Phone numbers, links and email addresses in public text are held for a human (PDPL, data minimisation). */
export function containsContactInfo(s: string): boolean {
  const t = toAsciiDigits(s);
  if (/https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|eg|me|io)\b/i.test(t)) return true;
  if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(t)) return true;
  const digitsOnly = t.replace(/[\s\-().+]/g, "");
  return /\d{8,}/.test(digitsOnly);
}

export function qaSlaDueAt(publishedAtMs: number, cfg: ReviewRulesConfig = DEFAULT_REVIEW_CONFIG): number {
  return publishedAtMs + cfg.qaResponseSlaMs;
}

export function isQaOverdue(q: { slaDueAtMs: number | null; answeredAtMs: number | null }, nowMs: number): boolean {
  return q.answeredAtMs === null && q.slaDueAtMs !== null && nowMs >= q.slaDueAtMs;
}

// ---- keyset cursors ---------------------------------------------------------------------

export interface KeysetPosition {
  readonly ms: number;
  readonly id: string;
}

export function encodeCursor(p: KeysetPosition): string {
  return `${p.ms.toString(36)}.${p.id.toLowerCase()}`;
}

export function decodeCursor(raw: string): KeysetPosition | null {
  const m = /^([0-9a-z]{1,12})\.([0-9a-f-]{36})$/.exec(raw);
  if (m === null) return null;
  const [, msPart, idPart] = m;
  if (msPart === undefined || idPart === undefined || !UUID.test(idPart)) return null;
  const ms = parseInt(msPart, 36);
  return Number.isSafeInteger(ms) && ms >= 0 ? { ms, id: idPart } : null;
}
