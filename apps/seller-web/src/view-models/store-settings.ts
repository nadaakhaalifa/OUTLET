import { sellerSettings as ss } from "@outlet/domain";
import type { EtaEnrolment, NotificationPrefsWire, PayoutAccount, SellerRole, SellerTeam, StoreProfile } from "../api/schemas-onboarding";
import type { Locale, MessageKey } from "../i18n";
import { normalizePhone, toAsciiDigits } from "./auth-flow";

/** Pure rules for the store settings pages. The server re-checks every rule; these give early, accessible errors. */

export type Errs = Readonly<Record<string, MessageKey>>;
const ARABIC_LETTER = /[؀-ۿݐ-ݿ]/u;

/* ---------------- money ---------------- */
/** "2,000", "2000.5", "٢٠٠٠" -> piastres as a digit string; integer math, max 2 decimals. Null when not a valid amount. */
export function parseEgpToPiastres(raw: string): string | null {
  const s = toAsciiDigits(raw).replace(/[,،٬]/g, "").replace(/٫/g, ".");
  const m = /^([0-9]{1,9})(?:\.([0-9]{1,2}))?$/.exec(s);
  if (m === null) return null;
  const whole = m[1] ?? "0";
  const frac = (m[2] ?? "").padEnd(2, "0");
  return (BigInt(whole) * 100n + BigInt(frac)).toString();
}

export function piastresToEgpInput(amount: string): string {
  if (!/^[0-9]+$/.test(amount)) return "";
  const v = BigInt(amount);
  const whole = v / 100n;
  const frac = v % 100n;
  return frac === 0n ? whole.toString() : `${whole}.${frac.toString().padStart(2, "0")}`;
}

/* ---------------- profile ---------------- */
export interface ProfileValues {
  readonly nameAr: string;
  readonly nameEn: string;
  readonly descriptionAr: string;
  readonly descriptionEn: string;
  readonly changeOfMindDays: string;
  readonly defectDays: string;
  readonly policyAr: string;
  readonly policyEn: string;
  readonly threshold: string;
}

export const profileValues = (p: StoreProfile): ProfileValues => ({
  nameAr: p.name_ar,
  nameEn: p.name_en ?? "",
  descriptionAr: p.description_ar ?? "",
  descriptionEn: p.description_en ?? "",
  changeOfMindDays: String(p.return_policy.change_of_mind_days),
  defectDays: String(p.return_policy.defect_days),
  policyAr: p.return_policy.text_ar ?? "",
  policyEn: p.return_policy.text_en ?? "",
  threshold: piastresToEgpInput(p.free_delivery_threshold.amount),
});

const wholeNumber = (raw: string): number | null => {
  const d = toAsciiDigits(raw);
  return /^[0-9]{1,4}$/.test(d) ? Number(d) : null;
};

/** Statutory minimums (B5) are enforced here exactly as in the domain: never below 14 / 30 days, never above 90. */
export function validateReturnPolicy(
  v: Pick<ProfileValues, "changeOfMindDays" | "defectDays" | "policyAr" | "policyEn">,
  min: { readonly change_of_mind_days: number; readonly defect_days: number } = {
    change_of_mind_days: ss.LEGAL_MIN_CHANGE_OF_MIND_DAYS, defect_days: ss.LEGAL_MIN_DEFECT_DAYS,
  },
): Errs {
  const e: Record<string, MessageKey> = {};
  const c = wholeNumber(v.changeOfMindDays);
  const d = wholeNumber(v.defectDays);
  if (c === null) e.changeOfMindDays = "ob.set.err.number";
  else if (c < min.change_of_mind_days) e.changeOfMindDays = "ob.set.err.policy_min";
  else if (c > ss.MAX_RETURN_WINDOW_DAYS) e.changeOfMindDays = "ob.set.err.policy_max";
  if (d === null) e.defectDays = "ob.set.err.number";
  else if (d < min.defect_days) e.defectDays = "ob.set.err.policy_min";
  else if (d > ss.MAX_RETURN_WINDOW_DAYS) e.defectDays = "ob.set.err.policy_max";
  if (v.policyEn.trim() !== "" && v.policyAr.trim() === "") e.policyAr = "ob.set.err.ar_first";
  if (v.policyAr.length > 4000) e.policyAr = "ob.set.err.long";
  if (v.policyEn.length > 4000) e.policyEn = "ob.set.err.long";
  return e;
}

export function validateProfile(v: ProfileValues, min?: { change_of_mind_days: number; defect_days: number }): Errs {
  const e: Record<string, MessageKey> = { ...validateReturnPolicy(v, min) };
  const n = v.nameAr.trim();
  if (n.length < 2 || n.length > 200) e.nameAr = "ob.set.err.name_length";
  else if (!ARABIC_LETTER.test(n)) e.nameAr = "ob.set.err.name_arabic";
  if (v.nameEn.trim().length > 200) e.nameEn = "ob.set.err.long";
  if (v.descriptionAr.length > 4000) e.descriptionAr = "ob.set.err.long";
  if (v.descriptionEn.trim() !== "" && v.descriptionAr.trim() === "") e.descriptionEn = "ob.set.err.ar_first";
  if (v.descriptionEn.length > 4000) e.descriptionEn = "ob.set.err.long";
  const t = parseEgpToPiastres(v.threshold);
  if (t === null) e.threshold = "ob.set.err.amount";
  return e;
}

export function profileBody(v: ProfileValues, socialLinks: Readonly<Record<string, string>>) {
  const opt = (s: string): string | null => (s.trim() === "" ? null : s.trim());
  return {
    name_ar: v.nameAr.trim(),
    name_en: opt(v.nameEn),
    description_ar: opt(v.descriptionAr),
    description_en: opt(v.descriptionEn),
    social_links: { ...socialLinks },
    return_policy: {
      change_of_mind_days: Number(toAsciiDigits(v.changeOfMindDays)),
      defect_days: Number(toAsciiDigits(v.defectDays)),
      text_ar: opt(v.policyAr),
      text_en: opt(v.policyEn),
    },
    free_delivery_threshold: { amount: parseEgpToPiastres(v.threshold) ?? "0", currency: "EGP" as const },
  };
}

/** Optimistic lock: the form was loaded at `loaded`; if the server is ahead, do not overwrite. */
export const hasVersionConflict = (loaded: number, current: number): boolean => loaded !== current;

/* ---------------- vacation ---------------- */
export function validateVacation(
  v: { readonly enabled: boolean; readonly until: string; readonly etaExtraDays: string },
  nowMs: number,
): Errs {
  const e: Record<string, MessageKey> = {};
  const extra = wholeNumber(v.etaExtraDays);
  if (extra === null || extra > ss.MAX_VACATION_ETA_EXTRA_DAYS) e.etaExtraDays = "ob.set.err.eta_extra";
  if (!v.enabled) return e;
  const t = Date.parse(v.until);
  if (v.until === "" || Number.isNaN(t)) e.until = "ob.set.err.vacation_until";
  else if (t <= nowMs) e.until = "ob.set.err.vacation_past";
  else if (t > nowMs + ss.MAX_VACATION_DAYS * 86_400_000) e.until = "ob.set.err.vacation_max";
  return e;
}

/** `datetime-local` value in Cairo time to an ISO instant (Egypt: UTC+2, UTC+3 in DST; resolved through Intl). */
export function cairoLocalToIso(local: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (m === null) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Africa/Cairo", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(guess)).map((p) => [p.type, p.value]));
  const asCairo = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
  const offset = asCairo - guess;
  const t = new Date(guess - offset);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

/* ---------------- shipping ---------------- */
export const GOVERNORATES: readonly { readonly code: string; readonly ar: string; readonly en: string }[] = [
  { code: "EG-C", ar: "القاهرة", en: "Cairo" }, { code: "EG-GZ", ar: "الجيزة", en: "Giza" }, { code: "EG-ALX", ar: "الإسكندرية", en: "Alexandria" },
  { code: "EG-KB", ar: "القليوبية", en: "Qalyubia" }, { code: "EG-SHR", ar: "الشرقية", en: "Sharqia" }, { code: "EG-DK", ar: "الدقهلية", en: "Dakahlia" },
  { code: "EG-GH", ar: "الغربية", en: "Gharbia" }, { code: "EG-MNF", ar: "المنوفية", en: "Monufia" }, { code: "EG-BH", ar: "البحيرة", en: "Beheira" },
  { code: "EG-KFS", ar: "كفر الشيخ", en: "Kafr el-Sheikh" }, { code: "EG-DT", ar: "دمياط", en: "Damietta" }, { code: "EG-PTS", ar: "بورسعيد", en: "Port Said" },
  { code: "EG-IS", ar: "الإسماعيلية", en: "Ismailia" }, { code: "EG-SUZ", ar: "السويس", en: "Suez" }, { code: "EG-FYM", ar: "الفيوم", en: "Faiyum" },
  { code: "EG-BNS", ar: "بني سويف", en: "Beni Suef" }, { code: "EG-MN", ar: "المنيا", en: "Minya" }, { code: "EG-AST", ar: "أسيوط", en: "Asyut" },
  { code: "EG-SHG", ar: "سوهاج", en: "Sohag" }, { code: "EG-KN", ar: "قنا", en: "Qena" }, { code: "EG-LX", ar: "الأقصر", en: "Luxor" },
  { code: "EG-ASN", ar: "أسوان", en: "Aswan" }, { code: "EG-BA", ar: "البحر الأحمر", en: "Red Sea" }, { code: "EG-WAD", ar: "الوادي الجديد", en: "New Valley" },
  { code: "EG-MT", ar: "مطروح", en: "Matrouh" }, { code: "EG-SIN", ar: "شمال سيناء", en: "North Sinai" }, { code: "EG-JS", ar: "جنوب سيناء", en: "South Sinai" },
];

export const governorateLabel = (code: string, locale: Locale): string => {
  const g = GOVERNORATES.find((x) => x.code === code);
  return g === undefined ? code : locale === "ar" ? g.ar : g.en;
};

export interface ShippingValues {
  readonly governorate: string;
  readonly city: string;
  readonly street: string;
  readonly building: string;
  readonly landmark: string;
  readonly contactName: string;
  readonly contactPhone: string;
  readonly lat: string;
  readonly lng: string;
  readonly handlingHours: string;
  readonly packaging: readonly string[];
}

export function validateShipping(v: ShippingValues, phoneAlreadyStored: boolean): Errs {
  const e: Record<string, MessageKey> = {};
  if (!GOVERNORATES.some((g) => g.code === v.governorate)) e.governorate = "ob.set.err.governorate";
  if (!/^[a-z0-9-]{2,60}$/.test(v.city.trim().toLowerCase())) e.city = "ob.set.err.city";
  const street = v.street.trim();
  if (street.length < 3 || street.length > 200) e.street = "ob.set.err.street";
  const lm = v.landmark.trim();
  if (lm.length < 2 || lm.length > 120) e.landmark = "ob.set.err.landmark";
  const cn = v.contactName.trim();
  if (cn.length < 2 || cn.length > 80) e.contactName = "ob.set.err.contact_name";
  if (!(phoneAlreadyStored && v.contactPhone.trim() === "") && normalizePhone(v.contactPhone) === null) e.contactPhone = "ob.auth.err.phone";
  const h = wholeNumber(v.handlingHours);
  if (h === null || h < 12 || h > 168) e.handlingHours = "ob.set.err.handling";
  const hasPin = v.lat.trim() !== "" || v.lng.trim() !== "";
  if (hasPin) {
    const lat = Number(toAsciiDigits(v.lat));
    const lng = Number(toAsciiDigits(v.lng));
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !(lat >= 22 && lat <= 31.7 && lng >= 24.7 && lng <= 36.9)) e.pin = "ob.set.err.pin";
  }
  if (v.packaging.length < 1 || v.packaging.length > 10) e.packaging = "ob.set.err.packaging";
  return e;
}

/* ---------------- payout ---------------- */
export const NAME_MATCH_MIN = ss.NAME_MATCH_MIN_SCORE;
export const PAYOUT_HOLD_HOURS = 48;

export interface PayoutVM {
  readonly configured: boolean;
  readonly masked: string | null;
  readonly nameMatch: "match" | "mismatch" | null;
  readonly score: number | null;
  readonly held: boolean;
  readonly holdHoursLeft: number | null;
  readonly activatesAt: string | null;
}

export function payoutVM(a: PayoutAccount, nowMs: number): PayoutVM {
  if (!a.configured) return { configured: false, masked: null, nameMatch: null, score: null, held: false, holdHoursLeft: null, activatesAt: null };
  const until = a.held_until === null ? null : Date.parse(a.held_until);
  const held = a.payouts_held && until !== null && until > nowMs;
  return {
    configured: true,
    masked: a.iban_masked,
    nameMatch: a.name_match_score >= NAME_MATCH_MIN ? "match" : "mismatch",
    score: a.name_match_score,
    held,
    holdHoursLeft: held && until !== null ? Math.ceil((until - nowMs) / 3_600_000) : null,
    activatesAt: a.activates_at,
  };
}

/** Problem codes that mean "re-verify with your passkey or authenticator code, then retry". */
export const isStepUpRequired = (code: string | undefined): boolean => code === "strong_factor_required";

/* ---------------- team ---------------- */
export const INVITABLE_ROLES: readonly Exclude<SellerRole, "owner">[] = ["manager", "catalog", "warehouse", "finance", "support"];
export const ALL_ROLES: readonly SellerRole[] = ["owner", "manager", "catalog", "warehouse", "finance", "support"];

export interface TeamRowVM {
  readonly userId: string;
  readonly role: SellerRole;
  readonly phoneMasked: string | null;
  readonly isSelf: boolean;
  readonly canChangeRole: boolean;
  readonly canRemove: boolean;
  readonly protectedReason: "last_owner" | null;
}

export function teamRows(team: SellerTeam, selfUserId: string | null, viewerRole: SellerRole | null): readonly TeamRowVM[] {
  const owners = team.members.filter((m) => m.role === "owner").length;
  const viewerIsOwner = viewerRole === "owner";
  return team.members.map((m) => {
    const lastOwner = m.role === "owner" && owners <= 1;
    return {
      userId: m.user_id,
      role: m.role,
      phoneMasked: m.phone_masked,
      isSelf: m.user_id === selfUserId,
      canChangeRole: viewerIsOwner && !lastOwner,
      canRemove: viewerIsOwner && !lastOwner,
      protectedReason: lastOwner ? "last_owner" : null,
    };
  });
}

export function validateInvite(phone: string, role: string): Errs {
  const e: Record<string, MessageKey> = {};
  if (normalizePhone(phone) === null) e.phone = "ob.auth.err.phone";
  if (!(INVITABLE_ROLES as readonly string[]).includes(role)) e.role = "ob.form.err.required";
  return e;
}

/* ---------------- notifications ---------------- */
export const NOTIFICATION_EVENTS = ss.SELLER_NOTIFICATION_EVENTS;
export const NOTIFICATION_CHANNELS = ss.SELLER_CHANNELS;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export interface PrefCell {
  readonly event: NotificationEvent;
  readonly channel: NotificationChannel;
  readonly on: boolean;
  /** Transactional events keep in-app delivery; account_security also keeps email. */
  readonly locked: boolean;
}

export function prefCells(p: NotificationPrefsWire): readonly PrefCell[] {
  const transactional = new Set(p.transactional_events);
  const out: PrefCell[] = [];
  for (const event of NOTIFICATION_EVENTS) {
    for (const channel of NOTIFICATION_CHANNELS) {
      const locked = transactional.has(event) && (channel === "in_app" || (event === "account_security" && channel === "email"));
      out.push({ event, channel, on: locked ? true : p.preferences[event]?.[channel] === true, locked });
    }
  }
  return out;
}

/** Only changed, unlocked cells are sent (PATCH-like PUT body). */
export function prefsChanges(before: readonly PrefCell[], wanted: ReadonlySet<string>): Record<string, Record<string, boolean>> {
  const out: Record<string, Record<string, boolean>> = {};
  for (const c of before) {
    if (c.locked) continue;
    const now = wanted.has(`${c.event}:${c.channel}`);
    if (now === c.on) continue;
    out[c.event] = { ...(out[c.event] ?? {}), [c.channel]: now };
  }
  return out;
}

/* ---------------- ETA ---------------- */
export const etaStatusKey = (e: EtaEnrolment): MessageKey => {
  switch (e.status) {
    case "verified": return "ob.eta.status.verified";
    case "pending": return "ob.eta.status.pending";
    case "failed": return "ob.eta.status.failed";
    case "revoked": return "ob.eta.status.revoked";
    default: return "ob.eta.status.not_enrolled";
  }
};
