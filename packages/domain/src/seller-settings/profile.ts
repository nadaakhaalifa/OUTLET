import { SellerSettingsError } from "./errors";

/** Consumer Protection Law 181/2018 minimums (B5). A store may offer more, never less. */
export const LEGAL_MIN_CHANGE_OF_MIND_DAYS = 14;
export const LEGAL_MIN_DEFECT_DAYS = 30;
export const MAX_RETURN_WINDOW_DAYS = 90;

/** 2,000 EGP in piastres (spec 6). */
export const DEFAULT_FREE_DELIVERY_THRESHOLD = 200_000n;
/** Default admin ceiling for a store's free-delivery threshold: 5,000 EGP. Admin-editable through the limits port. */
export const DEFAULT_FREE_DELIVERY_ADMIN_MAX = 500_000n;

export const MAX_VACATION_DAYS = 90;
export const MAX_VACATION_ETA_EXTRA_DAYS = 60;
const DAY_MS = 86_400_000;

const ARABIC_LETTER = /[؀-ۿݐ-ݿ]/u;

export function validateDisplayNameAr(raw: string): string {
  const v = raw.trim().replace(/\s+/g, " ");
  if (v.length < 2 || v.length > 200) throw new SellerSettingsError("name_ar_length");
  if (!ARABIC_LETTER.test(v)) throw new SellerSettingsError("name_ar_must_be_arabic");
  return v;
}

export function validateOptionalText(raw: string | null | undefined, max: number, code: string): string | null {
  if (raw === null || raw === undefined) return null;
  const v = raw.trim();
  if (v.length === 0) return null;
  if (v.length > max) throw new SellerSettingsError(code);
  return v;
}

export const SOCIAL_PLATFORMS = ["instagram", "facebook", "tiktok", "x", "youtube", "website"] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];
export type SocialLinks = Partial<Record<SocialPlatform, string>>;

const SOCIAL_HOSTS: Record<Exclude<SocialPlatform, "website">, readonly string[]> = {
  instagram: ["instagram.com"],
  facebook: ["facebook.com", "fb.com"],
  tiktok: ["tiktok.com"],
  x: ["x.com", "twitter.com"],
  youtube: ["youtube.com", "youtu.be"],
};

const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|\d{1,3}(\.\d{1,3}){3}|\[.*\])$/i;

/** https only, no credentials, no IP or internal hosts (links are rendered to shoppers; nothing is ever fetched). */
export function normalizeSocialUrl(platform: SocialPlatform, raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new SellerSettingsError("social_link_invalid");
  }
  if (u.protocol !== "https:" || u.username !== "" || u.password !== "" || raw.length > 300) {
    throw new SellerSettingsError("social_link_invalid");
  }
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (PRIVATE_HOST.test(host) || !host.includes(".")) throw new SellerSettingsError("social_link_invalid");
  if (platform !== "website") {
    const ok = SOCIAL_HOSTS[platform].some((h) => host === h || host.endsWith(`.${h}`));
    if (!ok) throw new SellerSettingsError("social_link_wrong_host");
  }
  u.hash = "";
  return u.toString();
}

export function validateSocialLinks(input: Readonly<Record<string, string | undefined>>): SocialLinks {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined || v.trim() === "") continue;
    if (!(SOCIAL_PLATFORMS as readonly string[]).includes(k)) throw new SellerSettingsError("social_platform_unknown");
    out[k] = normalizeSocialUrl(k as SocialPlatform, v);
  }
  return out;
}

export interface ReturnPolicyInput {
  readonly changeOfMindDays: number;
  readonly defectDays: number;
  readonly textAr?: string | null | undefined;
  readonly textEn?: string | null | undefined;
}
export interface ReturnPolicy {
  readonly changeOfMindDays: number;
  readonly defectDays: number;
  readonly textAr: string | null;
  readonly textEn: string | null;
}

export const DEFAULT_RETURN_POLICY: ReturnPolicy = {
  changeOfMindDays: LEGAL_MIN_CHANGE_OF_MIND_DAYS,
  defectDays: LEGAL_MIN_DEFECT_DAYS,
  textAr: null,
  textEn: null,
};

/** The store cannot configure LESS than the statutory minimum (B5); Arabic text is mandatory when any text is given. */
export function validateReturnPolicy(input: ReturnPolicyInput): ReturnPolicy {
  if (!Number.isInteger(input.changeOfMindDays) || !Number.isInteger(input.defectDays)) {
    throw new SellerSettingsError("return_window_invalid");
  }
  if (input.changeOfMindDays < LEGAL_MIN_CHANGE_OF_MIND_DAYS) {
    throw new SellerSettingsError("return_window_below_statutory_minimum");
  }
  if (input.defectDays < LEGAL_MIN_DEFECT_DAYS) throw new SellerSettingsError("defect_window_below_statutory_minimum");
  if (input.changeOfMindDays > MAX_RETURN_WINDOW_DAYS || input.defectDays > MAX_RETURN_WINDOW_DAYS) {
    throw new SellerSettingsError("return_window_invalid");
  }
  const textAr = validateOptionalText(input.textAr, 2000, "return_policy_text_too_long");
  const textEn = validateOptionalText(input.textEn, 2000, "return_policy_text_too_long");
  if (textEn !== null && textAr === null) throw new SellerSettingsError("return_policy_arabic_required");
  if (textAr !== null && !ARABIC_LETTER.test(textAr)) throw new SellerSettingsError("return_policy_arabic_required");
  return { changeOfMindDays: input.changeOfMindDays, defectDays: input.defectDays, textAr, textEn };
}

export function validateFreeDeliveryThreshold(amount: bigint, adminMax: bigint): bigint {
  if (amount < 0n) throw new SellerSettingsError("threshold_negative");
  if (amount > adminMax) throw new SellerSettingsError("threshold_above_admin_max");
  return amount;
}

export interface Vacation {
  readonly enabled: boolean;
  readonly untilMs: number | null;
  readonly etaExtraDays: number;
}
export const NO_VACATION: Vacation = { enabled: false, untilMs: null, etaExtraDays: 0 };

export function validateVacation(input: Vacation, nowMs: number): Vacation {
  if (!input.enabled) return NO_VACATION;
  if (input.untilMs === null || input.untilMs <= nowMs) throw new SellerSettingsError("vacation_until_required");
  if (input.untilMs > nowMs + MAX_VACATION_DAYS * DAY_MS) throw new SellerSettingsError("vacation_too_long");
  if (!Number.isInteger(input.etaExtraDays) || input.etaExtraDays < 0 || input.etaExtraDays > MAX_VACATION_ETA_EXTRA_DAYS) {
    throw new SellerSettingsError("vacation_eta_invalid");
  }
  return input;
}

/** Vacation lapses on its own at `untilMs`; no job is needed to resume orders. */
export function isOnVacation(v: Vacation, nowMs: number): boolean {
  return v.enabled && v.untilMs !== null && nowMs < v.untilMs;
}
export function acceptsNewOrders(v: Vacation, nowMs: number): boolean {
  return !isOnVacation(v, nowMs);
}
/** Extra delivery days shoppers see while the store is on vacation (ETA adjusted). */
export function etaExtraDaysFor(v: Vacation, nowMs: number): number {
  return isOnVacation(v, nowMs) ? v.etaExtraDays : 0;
}
