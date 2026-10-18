/**
 * Content Security Policy for the public shopper site (master prompt B8, T5; spec P3-06).
 *
 * Per-request nonce + 'strict-dynamic' (same baseline as seller-web and admin-web), no inline script authoring and no
 * 'unsafe-inline' in production. Build-time SRI hashes (next.config.ts) are emitted on top. Finding (verified in
 * e2e): Next's inline bootstrap/RSC scripts are blocked under a nonce-less 'self' policy, so statically cached ISR
 * HTML cannot be combined with a strict CSP; pages are rendered per request and use the Next data cache
 * (revalidate 60 s, tag public-catalog) for API reads. See docs/specs/phase-3/shopper-web-seo.md status notes.
 */
export interface CspOptions {
  readonly nonce: string;
  readonly isDev: boolean;
  /** https origins that product, store and drop images are served from (CDN). */
  readonly imageOrigins: readonly string[];
  readonly reportUri?: string;
  /** Emit upgrade-insecure-requests. Off for plain-http loopback (local e2e), on for the https site. */
  readonly upgradeInsecure?: boolean;
}

export function buildCsp(o: CspOptions): string {
  // Dev server needs eval for React refresh and emits inline bootstrap scripts; never in production.
  const script = ["'self'", `'nonce-${o.nonce}'`, "'strict-dynamic'", ...(o.isDev ? ["'unsafe-eval'"] : [])];
  const directives: [string, readonly string[]][] = [
    ["default-src", ["'self'"]],
    ["script-src", script],
    ["style-src", ["'self'", `'nonce-${o.nonce}'`]],
    ["img-src", ["'self'", "data:", ...o.imageOrigins]],
    ["font-src", ["'self'"]],
    // Same-origin only: the browser never talks to the API directly (server-side rendering + /api/server-time).
    ["connect-src", ["'self'"]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'self'"]],
    ["form-action", ["'self'"]],
    ["frame-ancestors", ["'none'"]],
    ["frame-src", ["'none'"]],
    ["worker-src", ["'self'"]],
    ["manifest-src", ["'self'"]],
  ];
  const parts = directives.map(([k, v]) => `${k} ${v.join(" ")}`);
  if (o.reportUri !== undefined) parts.push(`report-uri ${o.reportUri}`);
  if (!o.isDev && o.upgradeInsecure !== false) parts.push("upgrade-insecure-requests");
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
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), publickey-credentials-get=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
};

/** SHOPPER_IMAGE_ORIGINS: comma-separated https origins. Anything else is dropped. */
export function imageOriginsOf(raw: string | undefined): readonly string[] {
  if (raw === undefined) return [];
  const out: string[] = [];
  for (const part of raw.split(",")) {
    try {
      const u = new URL(part.trim());
      if (u.protocol === "https:" && !out.includes(u.origin)) out.push(u.origin);
    } catch {
      // ignore malformed entries
    }
  }
  return out;
}
