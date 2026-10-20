/**
 * Website ownership proof (ADR-0031, spec 'Domain', SSRF guard API7). Pure: hashing is injected so
 * this package keeps no node:crypto import; the API module supplies HMAC-SHA256.
 */

/** HMAC(secret, message) as lowercase hex. Supplied by the adapter layer. */
export type HmacHex = (secret: string, message: string) => string;

export const TXT_RECORD_PREFIX = "_zoutlet-verify";
export const TXT_VALUE_PREFIX = "zoutlet-site-verification=";
export const DNS_CHALLENGE_TTL_MS = 7 * 86_400_000;
export const EMAIL_CHALLENGE_TTL_MS = 24 * 3_600_000;
export const EMAIL_MAX_ATTEMPTS = 5;
export const EMAIL_LOCAL_PARTS = ["admin", "info", "webmaster", "hostmaster"] as const;
export type EmailLocalPart = (typeof EMAIL_LOCAL_PARTS)[number];

export const FREE_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "icloud.com", "me.com",
  "aol.com", "proton.me", "protonmail.com", "gmx.com", "mail.com", "zoho.com", "yandex.com", "yandex.ru", "mail.ru", "qq.com", "163.com",
  "rocketmail.com", "hotmail.co.uk", "yahoo.co.uk", "yahoo.com.eg",
]);

/** Social, marketplace and builder hosts: a brand cannot prove a brand website with these (spec edge cases). */
export const SHARED_PLATFORM_DOMAINS: ReadonlySet<string> = new Set([
  "instagram.com", "facebook.com", "fb.com", "tiktok.com", "x.com", "twitter.com", "youtube.com", "linkedin.com", "linktr.ee", "wa.me",
  "myshopify.com", "wixsite.com", "blogspot.com", "wordpress.com", "github.io", "vercel.app", "netlify.app", "carrd.co", "amazon.com", "noon.com",
]);

const INTERNAL_TLDS: ReadonlySet<string> = new Set([
  "localhost", "local", "internal", "lan", "home", "corp", "intranet", "private", "test", "example", "invalid", "onion", "arpa",
  "localdomain", "home.arpa", "svc", "cluster", "consul", "kubernetes",
]);

/**
 * Multi-label public suffixes we recognise. HAND-AUTHORED SUBSET of the Public Suffix List, enough for
 * the launch markets. VERIFY BEFORE LAUNCH: vendor the full PSL snapshot and refresh it monthly.
 */
const MULTI_LABEL_SUFFIXES: ReadonlySet<string> = new Set([
  "com.eg", "org.eg", "net.eg", "edu.eg", "gov.eg", "sci.eg", "eun.eg", "name.eg", "tv.eg",
  "co.uk", "org.uk", "me.uk", "ltd.uk", "plc.uk", "com.au", "net.au", "org.au", "co.nz", "co.za", "org.za",
  "com.sa", "net.sa", "org.sa", "com.ae", "co.ae", "net.ae", "com.kw", "com.qa", "com.bh", "com.om", "com.jo", "com.lb",
  "com.tr", "com.br", "com.mx", "com.ar", "com.cn", "co.jp", "co.in", "co.kr", "com.sg", "com.hk", "com.my", "com.pk", "com.ng", "co.ke",
]);

export type DomainRejection =
  | "empty"
  | "too_long"
  | "not_a_hostname"
  | "ip_literal"
  | "internal_tld"
  | "single_label"
  | "invalid_label"
  | "invalid_tld"
  | "public_suffix"
  | "free_mail"
  | "shared_platform";

export type DomainCheck =
  | { readonly ok: true; readonly host: string; readonly domain: string }
  | { readonly ok: false; readonly reason: DomainRejection };

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const IPV4_LIKE = /^(0x[0-9a-f]+|\d+)(\.(0x[0-9a-f]+|\d+)){0,3}$/i;

/**
 * Validates a user-supplied website host and returns the registrable domain to verify.
 * Accepts only bare hosts (optionally with a leading www.). URLs, ports, paths, credentials and
 * Unicode hosts are refused: the caller never fetches a user-supplied URL, only resolves
 * `_zoutlet-verify.<domain>` TXT.
 */
export function validateBrandDomain(raw: string): DomainCheck {
  let host = raw.trim().toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host === "") return { ok: false, reason: "empty" };
  if (host.length > 253) return { ok: false, reason: "too_long" };
  if (host.includes("://")) return { ok: false, reason: "not_a_hostname" };
  if (/[\s/\\:@?#%[\]()<>"'`,;|*_]/.test(host)) {
    // ':' covers IPv6 literals and ports; '[' IPv6 brackets.
    return { ok: false, reason: host.includes(":") || host.includes("[") ? "ip_literal" : "not_a_hostname" };
  }
  if (IPV4_LIKE.test(host)) return { ok: false, reason: "ip_literal" };
  if (host.startsWith("www.")) host = host.slice(4);
  const labels = host.split(".");
  if (labels.length < 2) return { ok: false, reason: "single_label" };
  if (labels.some((l) => !LABEL.test(l))) return { ok: false, reason: "invalid_label" };
  const tld = labels[labels.length - 1] as string;
  if (INTERNAL_TLDS.has(tld) || INTERNAL_TLDS.has(labels.slice(-2).join("."))) return { ok: false, reason: "internal_tld" };
  if (!/^([a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(tld)) return { ok: false, reason: "invalid_tld" };
  if (/^\d+$/.test(labels[0] as string) && labels.every((l) => /^\d+$/.test(l))) return { ok: false, reason: "ip_literal" };
  const last2 = labels.slice(-2).join(".");
  if (MULTI_LABEL_SUFFIXES.has(host)) return { ok: false, reason: "public_suffix" };
  const registrable = MULTI_LABEL_SUFFIXES.has(last2) ? labels.slice(-3).join(".") : last2;
  if (registrable.split(".").length < 2) return { ok: false, reason: "public_suffix" };
  if (FREE_MAIL_DOMAINS.has(registrable)) return { ok: false, reason: "free_mail" };
  for (const shared of SHARED_PLATFORM_DOMAINS) {
    if (host === shared || host.endsWith(`.${shared}`)) return { ok: false, reason: "shared_platform" };
  }
  return { ok: true, host, domain: registrable };
}

export const txtRecordName = (domain: string): string => `${TXT_RECORD_PREFIX}.${domain}`;

/** token = HMAC(secret, application_id|domain|nonce). The nonce makes each challenge single-purpose. */
export function dnsChallengeToken(hmac: HmacHex, secret: string, applicationId: string, domain: string, nonce: string): string {
  return hmac(secret, `${applicationId}|${domain}|${nonce}`);
}
export const txtRecordValue = (token: string): string => `${TXT_VALUE_PREFIX}${token}`;

/** TXT answers arrive quoted and chunked by resolvers; tolerate surrounding quotes and whitespace. */
const cleanTxt = (v: string): string => v.trim().replace(/^"+|"+$/g, "").replace(/"\s+"/g, "").trim();

export function txtContainsValue(answers: readonly string[], expectedValue: string): boolean {
  let found = false;
  for (const a of answers) {
    // No early exit: comparison cost does not depend on which record matched.
    if (constantTimeEqual(cleanTxt(a), expectedValue)) found = true;
  }
  return found;
}

export function constantTimeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i += 1) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export const emailAddressFor = (local: EmailLocalPart, domain: string): string => `${local}@${domain}`;

export function maskEmail(local: string, domain: string): string {
  const first = local.slice(0, 1);
  return `${first}${"*".repeat(Math.max(1, local.length - 1))}@${domain}`;
}

export const isFreeMailDomain = (domain: string): boolean => FREE_MAIL_DOMAINS.has(domain.toLowerCase());

export interface EmailChallengeState {
  readonly status: "pending" | "verified" | "failed" | "expired";
  readonly expiresAtMs: number;
  readonly attempts: number;
}

export type EmailAttemptOutcome =
  | { readonly kind: "verified"; readonly attempts: number }
  | { readonly kind: "wrong_code"; readonly attempts: number; readonly attemptsRemaining: number }
  | { readonly kind: "locked"; readonly attempts: number }
  | { readonly kind: "expired" }
  | { readonly kind: "not_pending" };

/** Decides one code submission. `codeMatches` is computed by the caller with a constant-time compare. */
export function evaluateEmailAttempt(state: EmailChallengeState, nowMs: number, codeMatches: boolean): EmailAttemptOutcome {
  if (state.status !== "pending") return state.status === "expired" ? { kind: "expired" } : { kind: "not_pending" };
  if (nowMs >= state.expiresAtMs) return { kind: "expired" };
  if (state.attempts >= EMAIL_MAX_ATTEMPTS) return { kind: "locked", attempts: state.attempts };
  const attempts = state.attempts + 1;
  if (codeMatches) return { kind: "verified", attempts };
  return attempts >= EMAIL_MAX_ATTEMPTS
    ? { kind: "locked", attempts }
    : { kind: "wrong_code", attempts, attemptsRemaining: EMAIL_MAX_ATTEMPTS - attempts };
}

/** The mailbox must live on the verified brand domain itself or a subdomain of it. */
export function emailDomainMatches(email: string, brandDomain: string): boolean {
  const at = email.lastIndexOf("@");
  if (at < 1) return false;
  const d = email.slice(at + 1).toLowerCase();
  return d === brandDomain || d.endsWith(`.${brandDomain}`);
}
