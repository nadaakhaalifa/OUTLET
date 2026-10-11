import {
  LIMITS,
  err,
  ok,
  type CalendarDate,
  type GiftFor,
  type Money,
  type Result,
  type ShareLink,
  type Wishlist,
  type WishlistIntent,
  type WishlistItem,
  type WishlistRuleViolation,
} from "./types";

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/** Validates a calendar date and returns its day number (days since 1970-01-01), or null. */
export function dayNumber(date: CalendarDate): number | null {
  const m = DATE_RE.exec(date);
  if (m === null) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return Math.floor(t / 86_400_000);
}

/** The calendar date in Africa/Cairo at `nowMs`. */
export function cairoDate(nowMs: number): CalendarDate {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Cairo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(nowMs));
}

/** Whole calendar days from `today` to `date` (positive means in the future). Null when invalid. */
export function daysUntil(date: CalendarDate, today: CalendarDate): number | null {
  const a = dayNumber(date);
  const b = dayNumber(today);
  if (a === null || b === null) return null;
  return a - b;
}

export function normaliseText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function validText(value: string, max: number, min = 1): boolean {
  return value.length >= min && value.length <= max && !CONTROL_RE.test(value);
}

export interface NewWishlistInput {
  readonly intent: WishlistIntent;
  readonly title: string;
  readonly targetDate: CalendarDate | null;
  readonly budget: Money | null;
  readonly giftFor: { readonly nickname: string; readonly occasion: string | null; readonly date: CalendarDate | null } | null;
  readonly coolOffEnabled: boolean;
}

export function validateBudget(budget: Money): boolean {
  return budget.currency === "EGP" && budget.amount > 0n && budget.amount <= LIMITS.budgetMaxMinor;
}

function validateTargetDate(date: CalendarDate, today: CalendarDate): WishlistRuleViolation | null {
  const d = daysUntil(date, today);
  if (d === null) return "target_date_invalid";
  if (d < 0) return "target_date_in_past";
  return null;
}

export function createWishlist(
  input: NewWishlistInput,
  ctx: { readonly id: string; readonly userId: string; readonly nowMs: number },
): Result<Wishlist, WishlistRuleViolation> {
  const title = normaliseText(input.title);
  if (!validText(title, LIMITS.titleMax)) return err("title_invalid");
  const today = cairoDate(ctx.nowMs);
  if (input.targetDate !== null) {
    const v = validateTargetDate(input.targetDate, today);
    if (v !== null) return err(v);
  }
  if (input.budget !== null && !validateBudget(input.budget)) return err("budget_invalid");
  if (input.coolOffEnabled && input.intent !== "want") return err("cool_off_requires_want");

  let giftFor: GiftFor | null = null;
  if (input.intent === "gift_for_someone") {
    if (input.giftFor === null) return err("gift_for_required");
    const nickname = normaliseText(input.giftFor.nickname);
    const occasion = input.giftFor.occasion === null ? null : normaliseText(input.giftFor.occasion);
    if (!validText(nickname, LIMITS.nicknameMax)) return err("gift_for_invalid");
    if (occasion !== null && !validText(occasion, LIMITS.occasionMax, 0)) return err("gift_for_invalid");
    if (input.giftFor.date !== null && dayNumber(input.giftFor.date) === null) return err("gift_for_invalid");
    giftFor = { nickname, occasion: occasion === "" ? null : occasion, date: input.giftFor.date };
  } else if (input.giftFor !== null) {
    return err("gift_for_not_allowed");
  }

  return ok({
    id: ctx.id,
    userId: ctx.userId,
    intent: input.intent,
    title,
    targetDate: input.targetDate,
    budget: input.budget,
    giftFor,
    coolOffEnabled: input.coolOffEnabled,
    share: null,
    createdAtMs: ctx.nowMs,
    updatedAtMs: ctx.nowMs,
  });
}

export interface WishlistPatch {
  readonly title?: string;
  readonly targetDate?: CalendarDate;
  readonly budget?: Money;
  readonly coolOffEnabled?: boolean;
}

export interface UpdateOutcome {
  readonly wishlist: Wishlist;
  /** True when cool-off was switched off, so pending item timers must be cleared. */
  readonly clearCoolOffTimers: boolean;
}

export function applyUpdate(list: Wishlist, patch: WishlistPatch, nowMs: number): Result<UpdateOutcome, WishlistRuleViolation> {
  let title = list.title;
  if (patch.title !== undefined) {
    title = normaliseText(patch.title);
    if (!validText(title, LIMITS.titleMax)) return err("title_invalid");
  }
  let targetDate = list.targetDate;
  if (patch.targetDate !== undefined && patch.targetDate !== list.targetDate) {
    const v = validateTargetDate(patch.targetDate, cairoDate(nowMs));
    if (v !== null) return err(v);
    targetDate = patch.targetDate;
  }
  let budget = list.budget;
  if (patch.budget !== undefined) {
    if (!validateBudget(patch.budget)) return err("budget_invalid");
    budget = patch.budget;
  }
  let coolOffEnabled = list.coolOffEnabled;
  let clear = false;
  if (patch.coolOffEnabled !== undefined) {
    if (patch.coolOffEnabled && list.intent !== "want") return err("cool_off_requires_want");
    clear = list.coolOffEnabled && !patch.coolOffEnabled;
    coolOffEnabled = patch.coolOffEnabled;
  }
  return ok({
    wishlist: { ...list, title, targetDate, budget, coolOffEnabled, updatedAtMs: nowMs },
    clearCoolOffTimers: clear,
  });
}

/** Server-computed cool-off end for an item being added. Never a client value. */
export function coolOffUntil(list: Pick<Wishlist, "intent" | "coolOffEnabled">, addedAtMs: number): number | null {
  return list.intent === "want" && list.coolOffEnabled ? addedAtMs + LIMITS.coolOffMs : null;
}

/** What the read model exposes: the timer only while it is still in the future. */
export function activeCoolOff(item: Pick<WishlistItem, "coolOffUntilMs">, nowMs: number): number | null {
  return item.coolOffUntilMs !== null && item.coolOffUntilMs > nowMs ? item.coolOffUntilMs : null;
}

export function validateNote(note: string | undefined): Result<string | null, "note_invalid"> {
  if (note === undefined) return ok(null);
  const n = normaliseText(note);
  if (n === "") return ok(null);
  if (!validText(n, LIMITS.noteMax)) return err("note_invalid");
  return ok(n);
}

export function itemKey(productId: string, skuPref: string | null): string {
  return `${productId}:${skuPref ?? "-"}`;
}

export function isShareActive(share: ShareLink | null, nowMs: number): share is ShareLink {
  if (share === null) return false;
  if (share.revokedAtMs !== null) return false;
  if (share.expiresAtMs !== null && share.expiresAtMs <= nowMs) return false;
  return true;
}

export function newShareLink(
  input: { readonly tokenHash: string; readonly expiresAtMs: number | null; readonly hidePrices: boolean },
  nowMs: number,
): Result<ShareLink, "share_expiry_invalid"> {
  if (input.expiresAtMs !== null) {
    if (input.expiresAtMs <= nowMs) return err("share_expiry_invalid");
    if (input.expiresAtMs - nowMs > LIMITS.shareMaxLifetimeMs) return err("share_expiry_invalid");
  }
  return ok({
    tokenHash: input.tokenHash,
    createdAtMs: nowMs,
    expiresAtMs: input.expiresAtMs,
    revokedAtMs: null,
    hidePrices: input.hidePrices,
  });
}

export function revokeShare(share: ShareLink, nowMs: number): ShareLink {
  return share.revokedAtMs === null ? { ...share, revokedAtMs: nowMs } : share;
}
