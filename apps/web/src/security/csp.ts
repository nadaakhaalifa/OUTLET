/** Same-origin violation sink (src/app/api/csp-report) and the Reporting API group name that points at it. */
export const CSP_REPORT_PATH = "/api/csp-report";
export const CSP_REPORT_GROUP = "csp";

export interface CspOptions {
  /** Adds `require-trusted-types-for 'script'`. Off by default until every dependency is Trusted Types clean. */
  readonly trustedTypes?: boolean;
  /** Dev only: React needs eval for stack reconstruction. Never set in production. */
  readonly dev?: boolean;
}

/** Cryptographically random, base64 nonce for one response (16 bytes). Works in the edge runtime. */
export function generateNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Strict, nonce-based CSP. No 'unsafe-inline'; 'strict-dynamic' lets nonced scripts load their chunks. */
export function buildCsp(nonce: string, opts: CspOptions = {}): string {
  const scriptSrc = ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'", ...(opts.dev === true ? ["'unsafe-eval'"] : [])];
  const directives: string[] = [
    "default-src 'self'",
    `script-src ${scriptSrc.join(" ")}`,
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' data: https:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    `report-uri ${CSP_REPORT_PATH}`,
    `report-to ${CSP_REPORT_GROUP}`,
  ];
  if (opts.dev !== true) directives.push("upgrade-insecure-requests");
  if (opts.trustedTypes === true) directives.push("require-trusted-types-for 'script'");
  return directives.join("; ");
}
