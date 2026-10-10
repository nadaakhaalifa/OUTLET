import type { Channel, Locale, NotificationTemplate, Payload } from "./types";

const PLACEHOLDER = /\{\{([a-z_][a-z0-9_]{0,39})\}\}/g;
const MAX_VALUE_LEN = 200;
// C0/C1 controls, line/paragraph separators and bidi override/isolate characters (spoofing).
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

export function placeholdersOf(text: string): ReadonlySet<string> {
  return new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1] as string));
}

/** All placeholders a template uses across subject and body, both languages. */
export function templatePlaceholders(t: NotificationTemplate): ReadonlySet<string> {
  const out = new Set<string>();
  for (const s of [t.subjectAr, t.subjectEn, t.bodyAr, t.bodyEn]) {
    if (s !== null) for (const p of placeholdersOf(s)) out.add(p);
  }
  return out;
}

export type ActivationFailure =
  | "arabic_body_required"
  | "arabic_subject_required"
  | "english_placeholder_mismatch"
  | "whatsapp_not_approved"
  | "whatsapp_template_id_required";

/** A template may be activated only with a non-empty Arabic body and consistent placeholders. */
export function checkActivation(t: NotificationTemplate): ActivationFailure | null {
  if (t.bodyAr.trim() === "") return "arabic_body_required";
  if ((t.channel === "email" || t.channel === "in_app") && (t.subjectAr === null || t.subjectAr.trim() === "")) {
    return "arabic_subject_required";
  }
  if (t.bodyEn !== null && t.bodyEn.trim() !== "") {
    const ar = placeholdersOf(t.bodyAr);
    const en = placeholdersOf(t.bodyEn);
    if (ar.size !== en.size || [...ar].some((p) => !en.has(p))) return "english_placeholder_mismatch";
  }
  if (t.channel === "whatsapp") {
    if (t.providerTemplateId === null || t.providerTemplateId.trim() === "") return "whatsapp_template_id_required";
    if (t.approval !== "APPROVED") return "whatsapp_not_approved";
  }
  return null;
}

export type PayloadFailure = "missing_placeholder" | "unknown_key" | "invalid_value";

/** Flat, validated payload: every placeholder present, nothing else, scalar values only. */
export function checkPayload(t: NotificationTemplate, payload: Payload): PayloadFailure | null {
  const needed = templatePlaceholders(t);
  for (const [k, v] of Object.entries(payload)) {
    if (!needed.has(k)) return "unknown_key";
    if (typeof v === "string") {
      if (v.length > MAX_VALUE_LEN) return "invalid_value";
    } else if (typeof v !== "number" || !Number.isFinite(v)) {
      return "invalid_value";
    }
  }
  for (const p of needed) if (!(p in payload)) return "missing_placeholder";
  return null;
}

const sanitize = (v: string): string => v.replace(FORBIDDEN_CHARS, "");
const escapeHtml = (v: string): string =>
  v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function fill(text: string, payload: Payload, channel: Channel): string {
  return text.replace(PLACEHOLDER, (_m, name: string) => {
    const raw = payload[name];
    const s = sanitize(String(raw ?? ""));
    return channel === "email" ? escapeHtml(s) : s;
  });
}

export interface RenderedMessage {
  readonly subjectAr: string | null;
  readonly subjectEn: string | null;
  readonly bodyAr: string;
  readonly bodyEn: string | null;
  /** The pair for the recipient's locale (Arabic when English is missing). */
  readonly subject: string | null;
  readonly body: string;
}

export function renderTemplate(t: NotificationTemplate, payload: Payload, locale: Locale): RenderedMessage {
  const subjectAr = t.subjectAr === null ? null : fill(t.subjectAr, payload, t.channel);
  const subjectEn = t.subjectEn === null || t.subjectEn.trim() === "" ? null : fill(t.subjectEn, payload, t.channel);
  const bodyAr = fill(t.bodyAr, payload, t.channel);
  const bodyEn = t.bodyEn === null || t.bodyEn.trim() === "" ? null : fill(t.bodyEn, payload, t.channel);
  const useEn = locale === "en" && bodyEn !== null;
  return {
    subjectAr,
    subjectEn,
    bodyAr,
    bodyEn,
    subject: useEn ? (subjectEn ?? subjectAr) : subjectAr,
    body: useEn ? bodyEn : bodyAr,
  };
}

const DEEP_LINK = /^\/[A-Za-z0-9/_\-.]{0,198}$/;
export const isSafeDeepLink = (s: string): boolean => DEEP_LINK.test(s) && !s.startsWith("//") && !s.includes("..");
