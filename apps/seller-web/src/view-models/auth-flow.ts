import type { MessageKey } from "../i18n";

/* ---------------- input normalisation ---------------- */
const ARABIC_INDIC = "٠١٢٣٤٥٦٧٨٩";
const EXT_ARABIC_INDIC = "۰۱۲۳۴۵۶۷۸۹";

/** Folds Arabic-Indic and Persian digits to ASCII, keeping every other character. */
export function foldDigits(raw: string): string {
  let out = "";
  for (const ch of raw) {
    const a = ARABIC_INDIC.indexOf(ch);
    const b = EXT_ARABIC_INDIC.indexOf(ch);
    out += a >= 0 ? String(a) : b >= 0 ? String(b) : ch;
  }
  return out;
}

/** Folds Arabic-Indic and Persian digits to ASCII and drops spaces, dashes and bidi marks. */
export function toAsciiDigits(raw: string): string {
  let out = "";
  for (const ch of raw) {
    const a = ARABIC_INDIC.indexOf(ch);
    const b = EXT_ARABIC_INDIC.indexOf(ch);
    if (a >= 0) out += String(a);
    else if (b >= 0) out += String(b);
    else if (!/[\s\-()‎‏‪-‮]/.test(ch)) out += ch;
  }
  return out;
}

const E164 = /^\+[1-9][0-9]{7,14}$/;

/** Egyptian mobile (01xxxxxxxxx, 201..., 00201..., +201...) or any other valid +E.164. Null when it cannot be one. */
export function normalizePhone(raw: string): string | null {
  const d = toAsciiDigits(raw).replace(/\./g, "");
  let candidate: string;
  if (/^01[0125][0-9]{8}$/.test(d)) candidate = `+20${d.slice(1)}`;
  else if (/^0020/.test(d)) candidate = `+${d.slice(2)}`;
  else if (/^201[0125][0-9]{8}$/.test(d)) candidate = `+${d}`;
  else candidate = d.startsWith("+") ? d : `+${d}`;
  if (!E164.test(candidate)) return null;
  if (candidate.startsWith("+20") && !/^\+201[0125][0-9]{8}$/.test(candidate)) return null;
  return candidate;
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
export const isEmail = (raw: string): boolean => raw.length <= 254 && EMAIL.test(raw.trim());

export function normalizeCode(raw: string): string | null {
  const d = toAsciiDigits(raw);
  return /^[0-9]{6}$/.test(d) ? d : null;
}

export interface SignUpErrors {
  phone?: MessageKey;
  email?: MessageKey;
}
export function validateSignUp(phone: string, email: string): { phone: string | null; email: string | null; errors: SignUpErrors } {
  const p = normalizePhone(phone);
  const errors: SignUpErrors = {};
  if (p === null) errors.phone = "ob.auth.err.phone";
  const e = email.trim();
  if (!isEmail(e)) errors.email = "ob.auth.err.email";
  return { phone: p, email: isEmail(e) ? e : null, errors };
}

/* ---------------- flow ---------------- */
export type StrongMethod = "passkey" | "totp";
export type AuthStep = "otp" | "enrol_passkey" | "enrol_totp" | "assert_passkey" | "assert_totp";

/**
 * After the phone OTP: which strong-factor step to show first. WebAuthn needs a secure context and the API;
 * without it we start on TOTP so nobody is stuck. The user can always switch (`canSwitch`).
 */
export function strongFactorStep(
  nextStep: "enrol_strong_factor" | "assert_strong_factor",
  passkeySupported: boolean,
): { readonly step: AuthStep; readonly canSwitch: boolean; readonly unsupportedNotice: boolean } {
  const enrol = nextStep === "enrol_strong_factor";
  if (passkeySupported) return { step: enrol ? "enrol_passkey" : "assert_passkey", canSwitch: true, unsupportedNotice: false };
  return { step: enrol ? "enrol_totp" : "assert_totp", canSwitch: false, unsupportedNotice: true };
}

export function switchMethod(step: AuthStep): AuthStep {
  switch (step) {
    case "enrol_passkey": return "enrol_totp";
    case "enrol_totp": return "enrol_passkey";
    case "assert_passkey": return "assert_totp";
    case "assert_totp": return "assert_passkey";
    case "otp": return "otp";
  }
}

/** Seconds left until a resend is allowed, never negative. */
export const resendRemaining = (resendAfterSec: number, elapsedMs: number): number =>
  Math.max(0, Math.ceil(resendAfterSec - elapsedMs / 1000));

/** Recovery codes are shown once: the user must tick the acknowledgement before continuing. */
export const canLeaveRecoveryCodes = (acknowledged: boolean, codesShown: boolean): boolean => codesShown && acknowledged;

export const formatRecoveryCodes = (codes: readonly string[]): string => codes.map((c, i) => `${String(i + 1).padStart(2, "0")}  ${c}`).join("\n");

/** Only same-origin relative paths may be used as a post-login destination (open-redirect guard). */
export function safeNextPath(next: string | null | undefined, fallback = "/start"): string {
  if (next === null || next === undefined) return fallback;
  if (!next.startsWith("/") || next.startsWith("//") || next.includes("\\") || [...next].some((c) => c.charCodeAt(0) < 32)) return fallback;
  return next;
}

/** TOTP otpauth URI parts for the manual-entry fallback (secret shown in groups of four). */
export function parseOtpauth(uri: string): { readonly secret: string; readonly issuer: string | null; readonly account: string | null } | null {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return null;
  }
  if (u.protocol !== "otpauth:" || u.hostname !== "totp") return null;
  const secret = u.searchParams.get("secret");
  if (secret === null || !/^[A-Za-z2-7]{16,128}$/.test(secret)) return null;
  const label = decodeURIComponent(u.pathname.replace(/^\//, ""));
  const account = label.includes(":") ? label.slice(label.indexOf(":") + 1) : label;
  return { secret: secret.toUpperCase(), issuer: u.searchParams.get("issuer"), account: account === "" ? null : account };
}
export const groupSecret = (s: string): string => s.replace(/(.{4})/g, "$1 ").trim();

/* ---------------- WebAuthn JSON <-> binary (pure) ---------------- */
export function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64url(b: ArrayBuffer | Uint8Array): string {
  const view = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = "";
  view.forEach((x) => {
    s += String.fromCharCode(x);
  });
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

type Json = Readonly<Record<string, unknown>>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

function descriptors(v: unknown): PublicKeyCredentialDescriptor[] {
  if (!Array.isArray(v)) return [];
  const out: PublicKeyCredentialDescriptor[] = [];
  for (const d of v) {
    if (!isObj(d)) continue;
    const id = str(d.id);
    if (id === null) continue;
    const transports = Array.isArray(d.transports) ? d.transports.filter((x): x is AuthenticatorTransport => typeof x === "string") : [];
    out.push({ type: "public-key", id: b64urlToBytes(id), ...(transports.length > 0 ? { transports } : {}) });
  }
  return out;
}

/** WebAuthn creation options from the server's JSON (base64url binary fields). Null when malformed. */
export function toCreationOptions(pk: Json): PublicKeyCredentialCreationOptions | null {
  const challenge = str(pk.challenge);
  const rp = pk.rp;
  const user = pk.user;
  if (challenge === null || !isObj(rp) || !isObj(user) || !Array.isArray(pk.pubKeyCredParams)) return null;
  const userId = str(user.id);
  const rpName = str(rp.name);
  const name = str(user.name);
  if (userId === null || rpName === null || name === null) return null;
  const params: PublicKeyCredentialParameters[] = [];
  for (const p of pk.pubKeyCredParams) {
    if (isObj(p) && typeof p.alg === "number") params.push({ type: "public-key", alg: p.alg });
  }
  if (params.length === 0) return null;
  const rpId = str(rp.id);
  const sel = isObj(pk.authenticatorSelection) ? pk.authenticatorSelection : null;
  const uv = sel !== null && (sel.userVerification === "required" || sel.userVerification === "preferred" || sel.userVerification === "discouraged") ? sel.userVerification : "required";
  const rk = sel !== null && (sel.residentKey === "required" || sel.residentKey === "preferred" || sel.residentKey === "discouraged") ? sel.residentKey : "preferred";
  return {
    challenge: b64urlToBytes(challenge),
    rp: { name: rpName, ...(rpId === null ? {} : { id: rpId }) },
    user: { id: b64urlToBytes(userId), name, displayName: str(user.displayName) ?? name },
    pubKeyCredParams: params,
    excludeCredentials: descriptors(pk.excludeCredentials),
    authenticatorSelection: { userVerification: uv, residentKey: rk },
    attestation: "none",
    timeout: typeof pk.timeout === "number" ? Math.min(pk.timeout, 120_000) : 60_000,
  };
}

export function toRequestOptions(pk: Json): PublicKeyCredentialRequestOptions | null {
  const challenge = str(pk.challenge);
  if (challenge === null) return null;
  const rpId = str(pk.rpId);
  return {
    challenge: b64urlToBytes(challenge),
    ...(rpId === null ? {} : { rpId }),
    allowCredentials: descriptors(pk.allowCredentials),
    userVerification: "required",
    timeout: typeof pk.timeout === "number" ? Math.min(pk.timeout, 120_000) : 60_000,
  };
}

export interface AttestationLike {
  readonly id: string;
  readonly rawId: ArrayBuffer;
  readonly type: string;
  readonly response: { readonly clientDataJSON: ArrayBuffer; readonly attestationObject: ArrayBuffer; readonly transports?: readonly string[] };
}
export interface AssertionLike {
  readonly id: string;
  readonly rawId: ArrayBuffer;
  readonly type: string;
  readonly response: { readonly clientDataJSON: ArrayBuffer; readonly authenticatorData: ArrayBuffer; readonly signature: ArrayBuffer; readonly userHandle: ArrayBuffer | null };
}

export function serializeAttestation(c: AttestationLike): Record<string, unknown> {
  return {
    id: c.id,
    rawId: bytesToB64url(c.rawId),
    type: c.type,
    response: {
      clientDataJSON: bytesToB64url(c.response.clientDataJSON),
      attestationObject: bytesToB64url(c.response.attestationObject),
      ...(c.response.transports === undefined ? {} : { transports: [...c.response.transports] }),
    },
  };
}

export function serializeAssertion(c: AssertionLike): Record<string, unknown> {
  return {
    id: c.id,
    rawId: bytesToB64url(c.rawId),
    type: c.type,
    response: {
      clientDataJSON: bytesToB64url(c.response.clientDataJSON),
      authenticatorData: bytesToB64url(c.response.authenticatorData),
      signature: bytesToB64url(c.response.signature),
      ...(c.response.userHandle === null ? {} : { userHandle: bytesToB64url(c.response.userHandle) }),
    },
  };
}

export type WebauthnFailure = "cancelled" | "unsupported" | "failed";
/** NotAllowedError is how browsers report a dismissed or timed-out prompt. */
export function classifyWebauthnError(name: string | null): WebauthnFailure {
  if (name === "NotAllowedError" || name === "AbortError") return "cancelled";
  if (name === "NotSupportedError" || name === "SecurityError") return "unsupported";
  return "failed";
}
