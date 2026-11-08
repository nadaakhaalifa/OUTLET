import { NextResponse, type NextRequest } from "next/server";
import { buildCsp, generateNonce } from "./security/csp";
import { sanitizeRequestHeaders } from "./security/request-headers";
import { DEFAULT_SEGMENT } from "./lib/segment";

/**
 * Per-request: strip x-middleware-* from the inbound request, mint the CSP nonce, redirect "/" to a locale segment.
 * Authorization is NOT decided here (route handlers and server loaders check access themselves).
 */
export function proxy(request: NextRequest): NextResponse {
  if (request.nextUrl.pathname === "/") {
    const accept = request.headers.get("accept-language") ?? "";
    const segment = /^\s*en\b/i.test(accept) ? "eg-en" : DEFAULT_SEGMENT;
    return NextResponse.redirect(new URL(`/${segment}`, request.url), 307);
  }

  const nonce = generateNonce();
  const csp = buildCsp(nonce, { trustedTypes: process.env.CSP_TRUSTED_TYPES === "on", dev: process.env.NODE_ENV !== "production" });
  const headers = sanitizeRequestHeaders(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("content-security-policy", csp);

  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [{ source: "/((?!api|_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)" }],
};
