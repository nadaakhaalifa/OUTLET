/**
 * SAQ A hygiene (spec B8). Card data never enters Z-OUTLET. This module is the defence in depth for
 * the one place untrusted PSP bodies are persisted: raw webhook bodies.
 *
 * Rules:
 *  - a string value that is a Luhn-valid 13 to 19 digit number is a PAN, redact it;
 *  - a value under a card-data key (pan, card_number, cvv, ...) is redacted when it is PAN shaped
 *    (12 or more digits) and always for CVV-like keys. A short `pan` value is a last-4 style mask
 *    that some PSPs send (VERIFY BEFORE LAUNCH, VR-PAY-10) and is kept;
 *  - unquoted JSON numbers are never inspected (epoch milliseconds are 13 digits).
 */
export const CARD_DATA_KEYS = /^(pan|full_?pan|card_?number|card_?no|number|cvv2?|cvc2?|cvn|security_?code|track_?[12]|track_?data|pin_?block)$/i;
const ALWAYS_REDACT_KEYS = /^(cvv2?|cvc2?|cvn|security_?code|track_?[12]|track_?data|pin_?block)$/i;

export const REDACTED = "[REDACTED]";

export function luhnValid(digits: string): boolean {
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

const compact = (s: string): string => s.replace(/[ -]/g, "");
const UUID_RUN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * A PAN candidate: Luhn-valid, 13 to 19 digits, issuer digit 2 to 6 (Visa 4, Mastercard 2 and 5,
 * Amex 3, Discover and UnionPay 6, Meeza 5 or 6 per VR-PAY-10) and not a repeated digit. The issuer
 * rule matters: all-zero strings and 13-digit epoch milliseconds (leading 1) are Luhn-valid by
 * chance and must not be mistaken for card numbers.
 */
function isPanCandidate(digits: string): boolean {
  return luhnValid(digits) && /^[2-6]/.test(digits) && !/^(\d)\1+$/.test(digits);
}

/**
 * Whole string is a PAN, or contains a PAN-shaped run of 13 to 19 digits (separators allowed).
 * UUIDs are removed first: their digit-only groups joined by dashes look like a PAN run.
 */
export function containsPan(value: string): boolean {
  const v = value.replace(UUID_RUN, " ");
  if (isPanCandidate(compact(v))) return true;
  const runs = v.match(/(?:\d[ -]?){13,19}/g);
  if (runs === null) return false;
  return runs.some((r) => isPanCandidate(compact(r).replace(/\D/g, "")));
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

export interface SanitizeResult {
  readonly value: JsonValue;
  /** True when anything was redacted: raise an anomaly, this should not happen under SAQ A. */
  readonly redacted: boolean;
}

export function sanitizeJson(input: JsonValue): SanitizeResult {
  let redacted = false;
  const walk = (v: JsonValue, key: string | null): JsonValue => {
    if (typeof v === "string") {
      if (key !== null && ALWAYS_REDACT_KEYS.test(key) && v.length > 0) {
        redacted = true;
        return REDACTED;
      }
      if (key !== null && CARD_DATA_KEYS.test(key) && compact(v).replace(/\D/g, "").length >= 12) {
        redacted = true;
        return REDACTED;
      }
      if (containsPan(v)) {
        redacted = true;
        return REDACTED;
      }
      return v;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (v !== null && typeof v === "object") {
      const out: { [k: string]: JsonValue } = {};
      for (const [k, x] of Object.entries(v)) out[k] = walk(x, k);
      return out;
    }
    if (typeof v === "number" && key !== null && ALWAYS_REDACT_KEYS.test(key)) {
      redacted = true;
      return REDACTED;
    }
    return v;
  };
  const value = walk(input, null);
  return { value, redacted };
}

/** Keys that must never be declared by any schema, table or payload of this module. */
export const FORBIDDEN_FIELD_NAMES = /^(pan|full_?pan|card_?number|card_?no|number|cvv2?|cvc2?|cvn|security_?code|track_?[12]|track_?data|pin_?block|expiry|card_?holder_?name)$/i;
