import { NextResponse, type NextRequest } from "next/server";
import { buildCsp, imageOriginsOf, newNonce, SECURITY_HEADERS } from "./csp";
import { readSiteUrl } from "./api/config";
import { isLocale, pickLocale } from "./i18n";

/** Next 16 "proxy": locale-prefix redirect, per-request CSP nonce and security headers. */
export function proxy(request: NextRequest): NextResponse {
  const nonce = newNonce((n) => crypto.getRandomValues(new Uint8Array(n)));
  const csp = buildCsp({
    nonce,
    upgradeInsecure: readSiteUrl(process.env).startsWith("https:"),
    isDev: process.env.NODE_ENV === "development",
    imageOrigins: imageOriginsOf(process.env.SHOPPER_IMAGE_ORIGINS),
  });
  const { pathname } = request.nextUrl;
  const first = pathname.split("/")[1];
  let res: NextResponse;
  if (isLocale(first)) {
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set("x-nonce", nonce);
    requestHeaders.set("Content-Security-Policy", csp);
    res = NextResponse.next({ request: { headers: requestHeaders } });
  } else {
    const to = request.nextUrl.clone();
    to.pathname = `/${pickLocale(request.headers.get("accept-language"))}${pathname === "/" ? "" : pathname}`;
    res = NextResponse.redirect(to, 308);
    res.headers.set("Vary", "Accept-Language");
  }
  res.headers.set("Content-Security-Policy", csp);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
  return res;
}

export const config = {
  matcher: [
    { source: "/((?!_next/static|_next/image|favicon.ico|fonts/|api/|tokens.css|robots.txt|sitemap|og-default.png).*)", missing: [{ type: "header", key: "next-router-prefetch" }] },
  ],
};
