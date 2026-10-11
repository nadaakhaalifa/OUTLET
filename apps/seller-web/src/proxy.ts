import { NextResponse, type NextRequest } from "next/server";
import { readApiBaseUrl } from "./api/config";
import { apiOriginOf, buildCsp, newNonce, SECURITY_HEADERS } from "./csp";

const SESSION_COOKIE = "sc_session";



/** Next 16 "proxy" (formerly middleware): per-request CSP nonce, security headers, optimistic sign-in redirect. */
export function proxy(request: NextRequest): NextResponse {
  const nonce = newNonce((n) => crypto.getRandomValues(new Uint8Array(n)));
  const csp = buildCsp({
    nonce,
    isDev: process.env.NODE_ENV === "development",
    apiOrigin: apiOriginOf(readApiBaseUrl(process.env)),
  });

  const path = request.nextUrl.pathname;
  const signedIn = request.cookies.has(SESSION_COOKIE);
  if (!signedIn && path !== "/login") {
    const res = NextResponse.redirect(new URL("/login", request.url));
    res.headers.set("Content-Security-Policy", csp);
    return res;
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set("Content-Security-Policy", csp);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
  return res;
}

export const config = {
  matcher: [{ source: "/((?!_next/static|_next/image|favicon.ico).*)", missing: [{ type: "header", key: "next-router-prefetch" }] }],
};
