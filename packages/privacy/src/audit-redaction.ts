import { z } from 'zod';

/**
 * Redaction gate for `audit_log.diff_redacted` (docs/haul-master-prompt-v3.md A2.9: "PII-redacted").
 * Every audit writer parses its diff through this schema before the INSERT; a violation throws and the
 * audited action fails closed (an unauditable action must not happen).
 *
 * Keys are checked by name. A key is rejected when any of its snake/camel-case tokens is a P3 token, or
 * when its normalized name is a P3 column name from docs/privacy/data_inventory.yaml. The generic names
 * in {@link GENERIC_P3_NAMES_ALLOWED} are P3 only inside one table's context (budget, measurements) and
 * are too common to deny by name; audit-redaction.test.ts fails when a new P3 name appears in the
 * inventory without being denied or listed here, so the decision is always taken explicitly.
 *
 * Values are primitives or short arrays of primitives, bounded in size, and strings that look like an
 * e-mail address, an E.164 phone number or an IBAN are rejected.
 */
export const P3_KEY_TOKENS: ReadonlySet<string> = new Set([
  'phone', 'iban', 'dob', 'ciphertext', 'enc', 'measurement', 'measurements', 'national', 'password', 'secret', 'token', 'email',
  'birth', 'mobile', 'msisdn', 'address', 'nid', 'card', 'pan', 'lat', 'lng', 'lon',
]);

/** P3 column names that are too generic to deny globally. Reviewed per name; do not extend without a reason. */
export const GENERIC_P3_NAMES_ALLOWED: ReadonlySet<string> = new Set([
  'accessibility_mode', 'amount', 'capture_images', 'detail', 'label', 'monthly', 'per_category', 'quick_start',
  'refund_received', 'refunded', 'spent', 'target_amount',
]);

const normalize = (key: string): string[] =>
  key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);

export const isP3AuditKey = (key: string): boolean => {
  const tokens = normalize(key);
  const joined = tokens.join('_');
  if (GENERIC_P3_NAMES_ALLOWED.has(joined)) return false;
  return tokens.some((t) => P3_KEY_TOKENS.has(t));
};

const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
// Unanchored: personal data embedded inside free text is still personal data.
const E164 = /(?<![0-9A-Za-z])\+\d{8,15}(?!\d)/;
const EG_LOCAL_PHONE = /(?<![0-9A-Fa-f])01[0125]\d{8}(?![0-9A-Fa-f])/;
const NATIONAL_ID = /(?<![0-9A-Fa-f])[23]\d{13}(?![0-9A-Fa-f])/;
const IBAN = /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/;
const MAX_KEYS = 32;
const MAX_STRING = 256;
const MAX_JSON_DEPTH = 4;
/** Numeric suffixes that legitimately carry long integers (piastres, epoch ms, basis points). */
const NUMERIC_OK_SUFFIX: ReadonlySet<string> = new Set(['minor', 'ms', 'bps']);

const Scalar = z.union([z.string().max(MAX_STRING), z.number().finite(), z.boolean(), z.null()]);
const Value = z.union([Scalar, z.array(Scalar).max(50)]);

const stringLooksPersonal = (s: string): boolean =>
  EMAIL.test(s) || E164.test(s) || EG_LOCAL_PHONE.test(s) || NATIONAL_ID.test(s) || IBAN.test(s.replace(/\s/g, ''));

const numberLooksPersonal = (n: number, key: string): boolean => {
  const tokens = normalize(key);
  const last = tokens[tokens.length - 1];
  if (last !== undefined && NUMERIC_OK_SUFFIX.has(last)) return false;
  return String(Math.trunc(Math.abs(n))).length >= 8;
};

/** Returns a problem description (never the value) or null. Strings that parse as JSON objects/arrays are scanned too. */
function scanValue(v: unknown, key: string, depth: number): string | null {
  if (typeof v === 'number') return numberLooksPersonal(v, key) ? 'number looks like personal data' : null;
  if (typeof v === 'string') {
    if (stringLooksPersonal(v)) return 'value looks like personal data';
    const t = v.trimStart();
    if (t.startsWith('{') || t.startsWith('[')) {
      if (depth >= MAX_JSON_DEPTH) return 'JSON nesting too deep';
      let parsed: unknown;
      try {
        parsed = JSON.parse(v);
      } catch {
        return null;
      }
      return scanValue(parsed, key, depth + 1);
    }
    return null;
  }
  if (Array.isArray(v)) {
    for (const item of v) {
      const r = scanValue(item, key, depth);
      if (r !== null) return r;
    }
    return null;
  }
  if (typeof v === 'object' && v !== null) {
    if (depth >= MAX_JSON_DEPTH) return 'JSON nesting too deep';
    for (const [k, item] of Object.entries(v)) {
      if (isP3AuditKey(k)) return 'P3 key inside embedded JSON';
      const r = scanValue(item, k, depth + 1);
      if (r !== null) return r;
    }
  }
  return null;
}

export const AuditDiffSchema = z
  .record(z.string().min(1).max(64), Value)
  .superRefine((d, ctx) => {
    const keys = Object.keys(d);
    if (keys.length > MAX_KEYS) ctx.addIssue({ code: 'custom', message: 'too many keys' });
    for (const k of keys) {
      if (isP3AuditKey(k)) ctx.addIssue({ code: 'custom', message: `P3 key not allowed in audit diff: ${k}`, path: [k] });
      const problem = scanValue(d[k], k, 0);
      if (problem !== null) ctx.addIssue({ code: 'custom', message: problem, path: [k] });
    }
  });

export type AuditDiff = z.infer<typeof AuditDiffSchema>;

export class AuditRedactionError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`audit diff rejected: ${issues.join('; ')}`);
    this.name = 'AuditRedactionError';
  }
}

/** Returns the diff unchanged when it is clean; throws AuditRedactionError otherwise (never echoes values). */
export function assertAuditDiff<T extends Record<string, unknown>>(diff: T): T {
  const r = AuditDiffSchema.safeParse(diff);
  if (r.success) return diff;
  throw new AuditRedactionError(r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
}
