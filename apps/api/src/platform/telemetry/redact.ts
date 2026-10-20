import { createHash } from "node:crypto";

/** Keys whose values are never logged or attached to spans (case-insensitive substring match). */
const SENSITIVE_KEY = /(phone|email|token|authorization|password|passwd|secret|cookie|otp|dob|birth|iban|address|card|cvv|measure|national|body|signature|key)/i;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const E164 = /(?<![\w])\+?\d[\d\s-]{8,}\d(?![\w])/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;
const REDACTED = "[REDACTED]";
const MAX_DEPTH = 6;

/** Keys that look sensitive by name but are safe structural ids (exact match, lower case). */
const SAFE_KEYS: ReadonlySet<string> = new Set(["trace_id", "span_id", "request_id", "idempotency_key_hash", "user_hash"]);

export function redactString(s: string): string {
  return s.replace(BEARER, REDACTED).replace(JWT, REDACTED).replace(EMAIL, REDACTED).replace(E164, REDACTED);
}

export function redactValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value === "number" || typeof value === "boolean" || value === undefined) return value;
  if (typeof value === "bigint") return value.toString();
  if (depth >= MAX_DEPTH) return REDACTED;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (typeof value === "object") return redactRecord(value as Record<string, unknown>, depth + 1);
  return REDACTED;
}

/** Deep, key-name and value-pattern redaction applied by the logger. Never throws. */
export function redactRecord(record: Readonly<Record<string, unknown>>, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    out[k] = SENSITIVE_KEY.test(k) && !SAFE_KEYS.has(k.toLowerCase()) ? REDACTED : redactValue(v, depth);
  }
  return out;
}

/** Stable pseudonym for an id (user ids on spans). 16 hex chars of a salted SHA-256. */
export function hashId(id: string, salt = process.env["TELEMETRY_HASH_SALT"] ?? "outlet-telemetry"): string {
  return createHash("sha256").update(salt).update("\0").update(id).digest("hex").slice(0, 16);
}

/**
 * SQL statement fingerprint: literals and parameters are stripped, so neither values nor PII can leak
 * into telemetry. Returns a short normalised text and a stable hash.
 */
export function fingerprintSql(sql: string): { readonly text: string; readonly hash: string } {
  const text = sql
    .replace(/'(?:[^']|'')*'/g, "?")
    .replace(/\$\d+/g, "?")
    .replace(/\b\d+(?:\.\d+)?\b/g, "?")
    .replace(/\(\s*\?(?:\s*,\s*\?)+\s*\)/g, "(?)")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return { text, hash: createHash("sha256").update(text).digest("hex").slice(0, 12) };
}
