/**
 * Strict CSP with a per-request nonce (PCI SAQ A / FAQ 1588 techniques, master prompt B8, T5).
 * Pure so it is unit-tested. No inline scripts are authored in this app; Next's own inline bootstrap scripts
 * receive the nonce from the request header. `strict-dynamic` lets nonce'd scripts load their chunks.
 */
export interface CspOptions {
  readonly nonce: string;
  readonly isDev: boolean;
  /** Origin of the Seller API (scheme://host[:port]) or null when not configured. */
  readonly apiOrigin: string | null;
  readonly reportUri?: string;
}

export function buildCsp(o: CspOptions): string {
  const script = ["'self'", `'nonce-${o.nonce}'`, "'strict-dynamic'", ...(o.isDev ? ["'unsafe-eval'"] : [])];
  const connect = ["'self'", ...(o.apiOrigin === null ? [] : [o.apiOrigin])];
  const directives: [string, readonly string[]][] = [
    ["default-src", ["'self'"]],
    ["script-src", script],
    // Styles are static files from the build (CSS modules / global CSS); no inline style attributes are authored.
    ["style-src", ["'self'", `'nonce-${o.nonce}'`]],
    ["img-src", ["'self'", "blob:", "data:"]],
    ["font-src", ["'self'"]],
    ["connect-src", connect],
    ["object-src", ["'none'"]],
    ["base-uri", ["'self'"]],
    ["form-action", ["'self'"]],
    ["frame-ancestors", ["'none'"]],
    ["worker-src", ["'self'"]],
    ["manifest-src", ["'self'"]],
  ];
  const parts = directives.map(([k, v]) => `${k} ${v.join(" ")}`);
  if (o.reportUri !== undefined) parts.push(`report-uri ${o.reportUri}`);
  if (!o.isDev) parts.push("upgrade-insecure-requests");
  return parts.join("; ");
}

export function newNonce(randomBytes: (n: number) => Uint8Array): string {
  const bytes = randomBytes(16);
  let bin = "";
  bytes.forEach((b) => {
    bin += String.fromCharCode(b);
  });
  return btoa(bin);
}

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), publickey-credentials-get=(self)",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
};

export function apiOriginOf(baseUrl: string | null): string | null {
  if (baseUrl === null) return null;
  try {
    return new URL(baseUrl).origin;
  } catch {
    return null;
  }
}
