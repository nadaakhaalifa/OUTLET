export interface HeaderEntry {
  readonly key: string;
  readonly value: string;
}

/** Headers that do not vary per request. The CSP (needs a nonce) is built in csp.ts and set by the middleware. */
export function staticSecurityHeaders(): HeaderEntry[] {
  return [
    { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()" },
  ];
}
