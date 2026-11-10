import { NextResponse, type NextRequest } from "next/server";
import { COOKIE_ACCESS, COOKIE_DEVICE, COOKIE_INSTALL, COOKIE_REFRESH, type BffDeps, type BffRequest, type BffResult } from "./bff";
import { readEnv } from "./env";

/** Adapts a Next route request to the framework-free BFF handlers and back (cookies are HttpOnly, SameSite=Lax, Secure in production). */
export async function toBffRequest(req: NextRequest): Promise<BffRequest> {
  const cookies: Record<string, string | undefined> = {};
  for (const name of [COOKIE_ACCESS, COOKIE_REFRESH, COOKIE_INSTALL, COOKIE_DEVICE]) cookies[name] = req.cookies.get(name)?.value;
  return {
    method: req.method, host: req.nextUrl.host, origin: req.headers.get("origin"), secFetchSite: req.headers.get("sec-fetch-site"), contentType: req.headers.get("content-type"),
    acceptLanguage: req.headers.get("accept-language"), idempotencyKey: req.headers.get("idempotency-key"), userAgent: req.headers.get("user-agent"),
    cookies, search: req.nextUrl.search, body: req.method === "GET" || req.method === "HEAD" ? "" : await req.text(),
  };
}
export const liveDeps = (): BffDeps => ({ apiUrl: readEnv().API_URL, fetch: (url, init) => fetch(url, init) });

export function toNextResponse(r: BffResult): NextResponse {
  const res = new NextResponse(r.body, { status: r.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  if (r.retryAfter !== null) res.headers.set("retry-after", r.retryAfter);
  for (const c of r.cookies) {
    res.cookies.set({ name: c.name, value: c.value, maxAge: c.maxAge, httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/api" });
  }
  return res;
}
