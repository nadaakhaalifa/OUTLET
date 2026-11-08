const SENSITIVE_KEYS = [
  "phone", "mobile", "email", "dob", "birthdate", "dateofbirth", "address", "iban",
  "nationalid", "measurements", "token", "password", "authorization", "cookie",
  "secret", "cardnumber",
];

export const REDACTED = "[REDACTED]";
const MAX_DEPTH = 20;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const JWT = /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;
const CARD = /\b\d(?:[ -]?\d){15}\b/g;
const PHONE = /\+\d{8,15}\b/g;

function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function isSensitiveKey(key: string): boolean {
  const k = normaliseKey(key);
  return SENSITIVE_KEYS.some((s) => k.includes(s));
}

/** Masks a phone-like value, keeping only the last 2 digits. */
export function maskPhone(value: string): string {
  const ascii = value.replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x660));
  const digits = ascii.replace(/\D/g, "");
  return `***${digits.slice(-2)}`;
}

/** Applies the pattern masks to free text. */
export function redactString(input: string): string {
  return input
    .replace(JWT, REDACTED)
    .replace(EMAIL, REDACTED)
    .replace(CARD, REDACTED)
    .replace(PHONE, (m) => maskPhone(m));
}

function maskByKey(key: string, value: unknown): string {
  const k = normaliseKey(key);
  if ((k.includes("phone") || k.includes("mobile")) && typeof value === "string") {
    return maskPhone(value);
  }
  return REDACTED;
}

/** Deep, cycle-safe, non-throwing redactor. Returns a plain JSON-safe copy. */
export function redact(value: unknown): unknown {
  const seen = new WeakSet();
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === "string") return redactString(v);
    if (typeof v === "bigint") return v.toString();
    if (typeof v === "function" || typeof v === "symbol") return undefined;
    if (v === null || typeof v !== "object") return v;
    if (depth >= MAX_DEPTH) return "[MaxDepth]";
    if (seen.has(v)) return "[Circular]";
    seen.add(v);
    try {
      if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
      if (v instanceof Error) {
        return { name: v.name, message: redactString(v.message), stack: v.stack ? redactString(v.stack) : undefined };
      }
      if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(v)) {
        let child: unknown;
        try {
          child = (v as Record<string, unknown>)[key];
        } catch {
          child = "[Unreadable]";
        }
        out[key] = isSensitiveKey(key) && child !== null && child !== undefined
          ? maskByKey(key, child)
          : walk(child, depth + 1);
      }
      return out;
    } finally {
      seen.delete(v);
    }
  };
  try {
    return walk(value, 0);
  } catch {
    return "[RedactionFailed]";
  }
}
