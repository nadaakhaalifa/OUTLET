import { MIN_SIGNATORY_AGE } from "./types";

/**
 * Country field validators. Patterns marked VERIFY are engineering proposals pending Egyptian counsel and
 * registry documentation (docs/compliance/verify-register.md): they reject obvious garbage and never claim
 * that a number exists in a register.
 */

/** VERIFY: Egyptian commercial register numbers vary by registry office; digits, optionally "/office". */
export const EG_COMMERCIAL_REGISTER_PATTERN = /^[0-9]{3,12}(?:\/[0-9]{1,4})?$/;
/** VERIFY: Egyptian tax registration number, 9 digits, optionally grouped 3-3-3. */
export const EG_TAX_CARD_PATTERN = /^[0-9]{3}-?[0-9]{3}-?[0-9]{3}$/;
export const GENERIC_COMPANY_REG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ./-]{2,39}$/;
export const GENERIC_VAT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 .-]{3,24}$/;
export const E164_PATTERN = /^\+[1-9][0-9]{7,14}$/;
const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const DOMAIN_PATTERN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
/** Egypt governorate codes in the national id (01..35 and 88 for born abroad). */
const EG_ID_GOVERNORATES = new Set([
  "01", "02", "03", "04", "11", "12", "13", "14", "15", "16", "17", "18", "19", "21", "22", "23", "24", "25", "26", "27", "28", "29",
  "31", "32", "33", "34", "35", "88",
]);

export interface ParsedNationalId {
  readonly dob: string;
  readonly governorateCode: string;
}

/** Egyptian 14 digit national id: C YYMMDD GG SSSS X. Structure only; there is no public checksum. */
export function parseEgyptianNationalId(raw: string): ParsedNationalId | null {
  if (!/^[0-9]{14}$/.test(raw)) return null;
  const century = raw[0];
  if (century !== "2" && century !== "3") return null;
  const year = (century === "2" ? 1900 : 2000) + Number(raw.slice(1, 3));
  const month = Number(raw.slice(3, 5));
  const day = Number(raw.slice(5, 7));
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  const gov = raw.slice(7, 9);
  if (!EG_ID_GOVERNORATES.has(gov)) return null;
  return { dob: d.toISOString().slice(0, 10), governorateCode: gov };
}

/** Whole years between an ISO date (YYYY-MM-DD) and now. Null on an invalid date or a date in the future. */
export function ageInYears(dobIso: string, nowMs: number): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dobIso)) return null;
  const dob = new Date(`${dobIso}T00:00:00.000Z`);
  if (Number.isNaN(dob.getTime()) || dob.toISOString().slice(0, 10) !== dobIso) return null;
  const now = new Date(nowMs);
  if (dob.getTime() > nowMs) return null;
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const beforeBirthday =
    now.getUTCMonth() < dob.getUTCMonth() ||
    (now.getUTCMonth() === dob.getUTCMonth() && now.getUTCDate() < dob.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age;
}

export const isSignatoryAdult = (dobIso: string, nowMs: number): boolean => {
  const a = ageInYears(dobIso, nowMs);
  return a !== null && a >= MIN_SIGNATORY_AGE;
};

/** Public suffix-free hostname check. Rejects schemes, paths, ports, IP literals, localhost and internal names. */
export function normaliseDomain(raw: string): string | null {
  const d = raw.trim().toLowerCase().replace(/^www\./, "");
  if (!DOMAIN_PATTERN.test(d)) return null;
  if (/^[0-9.]+$/.test(d)) return null;
  if (/(^|\.)(localhost|local|internal|lan|home|corp|test|invalid|example)$/.test(d)) return null;
  return d;
}

export type FieldFormat =
  | "text"
  | "national_id"
  | "commercial_register_no"
  | "tax_card_no"
  | "company_reg_no"
  | "vat_id"
  | "url"
  | "domain"
  | "handle"
  | "phone"
  | "email"
  | "country"
  | "date";

export type FieldError = "invalid_format" | "invalid_date" | "signatory_under_age";

/** Returns an error code or null. `country` selects the national-id and register rules. */
export function validateFieldValue(format: FieldFormat, value: string, country: string): FieldError | null {
  const v = value.trim();
  switch (format) {
    case "text":
      return v.length >= 1 && v.length <= 500 ? null : "invalid_format";
    case "national_id":
      if (country === "EG") return parseEgyptianNationalId(v) === null ? "invalid_format" : null;
      return /^[A-Za-z0-9 -]{5,30}$/.test(v) ? null : "invalid_format";
    case "commercial_register_no":
      return EG_COMMERCIAL_REGISTER_PATTERN.test(v) ? null : "invalid_format";
    case "tax_card_no":
      return EG_TAX_CARD_PATTERN.test(v) ? null : "invalid_format";
    case "company_reg_no":
      return GENERIC_COMPANY_REG_PATTERN.test(v) ? null : "invalid_format";
    case "vat_id":
      return GENERIC_VAT_PATTERN.test(v) ? null : "invalid_format";
    case "url":
    case "domain":
      return normaliseDomain(v) === null ? "invalid_format" : null;
    case "handle":
      return /^[A-Za-z0-9._]{1,60}$/.test(v) ? null : "invalid_format";
    case "phone":
      return E164_PATTERN.test(v) ? null : "invalid_format";
    case "email":
      return EMAIL_PATTERN.test(v) ? null : "invalid_format";
    case "country":
      return /^[A-Z]{2}$/.test(v) ? null : "invalid_format";
    case "date":
      return ageInYears(v, Number.MAX_SAFE_INTEGER) === null ? "invalid_date" : null;
  }
}

/** Last four characters for masked display; never more. */
export const maskIdentifier = (raw: string): string => `${"*".repeat(Math.max(0, raw.length - 4))}${raw.slice(-4)}`;

/** Folds case, Arabic diacritics and letter variants, and punctuation so "Zara" and "zara!" collide. */
export function normaliseBrandName(raw: string): string {
  return raw
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[ً-ٰٟـ]/g, "")
    .replace(/[آأإ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Magic bytes by declared content type. The confirm step reads the first bytes through the store port. */
export function matchesMagicBytes(contentType: string, head: Uint8Array): boolean {
  const starts = (sig: readonly number[]): boolean => head.length >= sig.length && sig.every((b, i) => head[i] === b);
  switch (contentType) {
    case "application/pdf":
      return starts([0x25, 0x50, 0x44, 0x46, 0x2d]);
    case "image/jpeg":
      return starts([0xff, 0xd8, 0xff]);
    case "image/png":
      return starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    default:
      return false;
  }
}
