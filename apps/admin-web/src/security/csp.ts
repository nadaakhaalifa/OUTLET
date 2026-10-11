/**
 * Content-Security-Policy for the Admin Console (ASVS V3.4, spec T5, PCI-style script discipline).
 * Pure functions: the Next proxy only wires them to a request. A fresh nonce is minted per request.
 */
export interface CspOptions {
  readonly nonce: string;
  /** API origin for connect-src, or null when unconfigured (then only 'self'). */
  readonly apiOrigin: string | null;
  /** Dev server needs eval for React refresh; never set in production. */
  readonly development: boolean;
  readonly reportUri?: string;
}

const NONCE_RE = /^[A-Za-z0-9+/_-]{22,}={0,2}$/;

export function isValidNonce(nonce: string): boolean {
  return NONCE_RE.test(nonce);
}

/** 128 random bits, base64. `random` is injected so tests are deterministic. */
export function mintNonce(random: (bytes: Uint8Array) => Uint8Array = (b) => crypto.getRandomValues(b)): string {
  const bytes = random(new Uint8Array(16));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function buildCsp(o: CspOptions): string {
  if (!isValidNonce(o.nonce)) throw new Error("invalid_csp_nonce");
  const script = ["'self'", `'nonce-${o.nonce}'`, "'strict-dynamic'", ...(o.development ? ["'unsafe-eval'"] : [])];
  const connect = ["'self'", ...(o.apiOrigin === null ? [] : [o.apiOrigin])];
  const directives: Array<readonly [string, readonly string[]]> = [
    ["default-src", ["'none'"]],
    ["script-src", script],
    ["style-src", ["'self'", `'nonce-${o.nonce}'`]],
    ["img-src", ["'self'", "data:"]],
    ["font-src", ["'self'"]],
    ["connect-src", connect],
    ["form-action", ["'self'"]],
    ["frame-ancestors", ["'none'"]],
    ["base-uri", ["'none'"]],
    ["object-src", ["'none'"]],
    ["manifest-src", ["'self'"]],
  ];
  const parts = directives.map(([k, v]) => `${k} ${v.join(" ")}`);
  if (!o.development) parts.push("upgrade-insecure-requests");
  if (o.reportUri !== undefined) parts.push(`report-uri ${o.reportUri}`);
  return parts.join("; ");
}

/** Headers set on every response besides CSP. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), publickey-credentials-get=(self)",
  "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
  "cache-control": "no-store",
};
