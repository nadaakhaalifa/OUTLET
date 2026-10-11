import { FORBIDDEN_NAME_TOKENS, isValidPropertyName } from "./naming";

/** PII classes from spec §A3. Analytics properties may only ever be P0 or P1. */
export type PiiClass = "P0" | "P1" | "P2" | "P3";
export type AnalyticsSafeClass = "P0" | "P1";

export const MAX_STRING_LENGTH = 128;
export const MAX_ARRAY_LENGTH = 50;
export const MAX_PROPERTY_COUNT = 32;

export type PiiViolationCode =
  | "not_an_object"
  | "too_many_properties"
  | "invalid_property_name"
  | "forbidden_property_name"
  | "unsupported_value_type"
  | "nested_value"
  | "string_too_long"
  | "array_too_long"
  | "email_like_value"
  | "phone_like_value"
  | "ip_like_value"
  | "coordinate_like_value"
  | "token_like_value";

export interface PiiViolation {
  readonly path: string;
  readonly code: PiiViolationCode;
}

/** Egyptian users type Arabic-Indic digits; normalise before any digit pattern is tested. */
function normaliseDigits(value: string): string {
  return value.replace(/[٠-٩۰-۹]/g, (ch) => {
    const code = ch.charCodeAt(0);
    return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
  });
}

const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const IPV4_RE = /\b\d{1,3}(?:\.\d{1,3}){3}\b/;
const COORD_RE = /-?\d{1,3}\.\d{3,}\s*[,;]\s*-?\d{1,3}\.\d{3,}/;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\./;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const BEARER_RE = /\bbearer\s+\S+/i;

function inspectString(value: string, path: string, out: PiiViolation[]): void {
  if (value.length > MAX_STRING_LENGTH) {
    out.push({ path, code: "string_too_long" });
    return;
  }
  const v = normaliseDigits(value);
  if (EMAIL_RE.test(v)) out.push({ path, code: "email_like_value" });
  if (IPV4_RE.test(v)) out.push({ path, code: "ip_like_value" });
  if (COORD_RE.test(v)) out.push({ path, code: "coordinate_like_value" });
  if (JWT_RE.test(v) || BEARER_RE.test(v)) out.push({ path, code: "token_like_value" });
  // A run of 10+ digits (separators between digits removed) looks like a phone, national ID or card
  // number. UUIDs and ULIDs are exempt: their digit runs are not personal data.
  if (!UUID_RE.test(v) && !ULID_RE.test(v)) {
    const squeezed = v.replace(/(?<=\d)[\s\-().]+(?=\d)/g, "");
    if (/\d{10,}/.test(squeezed)) out.push({ path, code: "phone_like_value" });
  }
}

function inspectScalar(value: unknown, path: string, out: PiiViolation[]): void {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) out.push({ path, code: "unsupported_value_type" });
    else if (Number.isInteger(value) && Math.abs(value) >= 1_000_000_000) out.push({ path, code: "phone_like_value" });
    return;
  }
  if (typeof value === "string") {
    inspectString(value, path, out);
    return;
  }
  out.push({ path, code: "unsupported_value_type" });
}

/**
 * Defence in depth on top of the catalog's strict Zod schemas: inspects a property bag for PII-like
 * keys and values. Flat objects of scalars (and arrays of scalars) only. Returns every violation;
 * an empty array means the bag passed. It cannot prove absence of PII, only reject the obvious.
 */
export function inspectProperties(properties: unknown): PiiViolation[] {
  const out: PiiViolation[] = [];
  if (typeof properties !== "object" || properties === null || Array.isArray(properties)) {
    return [{ path: "", code: "not_an_object" }];
  }
  const entries = Object.entries(properties);
  if (entries.length > MAX_PROPERTY_COUNT) out.push({ path: "", code: "too_many_properties" });

  for (const [key, value] of entries) {
    if (!/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(key) || key.length > 40) {
      out.push({ path: key, code: "invalid_property_name" });
    } else if (!isValidPropertyName(key) || key.split("_").some((t) => FORBIDDEN_NAME_TOKENS.has(t))) {
      out.push({ path: key, code: "forbidden_property_name" });
    }
    if (Array.isArray(value)) {
      if (value.length > MAX_ARRAY_LENGTH) out.push({ path: key, code: "array_too_long" });
      value.forEach((item: unknown, i) => {
        if (typeof item === "object" && item !== null) out.push({ path: `${key}[${i}]`, code: "nested_value" });
        else inspectScalar(item, `${key}[${i}]`, out);
      });
    } else if (typeof value === "object" && value !== null) {
      out.push({ path: key, code: "nested_value" });
    } else {
      inspectScalar(value, key, out);
    }
  }
  return out;
}

export function isPiiSafe(properties: unknown): boolean {
  return inspectProperties(properties).length === 0;
}
