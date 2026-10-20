import { NextResponse, type NextRequest } from "next/server";
import { readApiBaseUrl, readDocumentOrigin } from "./api/config";
import { createFetchTransport } from "./api/transport";
import { buildCsp, mintNonce, SECURITY_HEADERS } from "./security/csp";
import { INSTALL_COOKIE, parseInstallToken } from "./session/install-token";
import { decodeSessionCookie, encodeSessionCookie, refreshIfNeeded, SESSION_COOKIE } from "./session/refresh";

const SESSION_COOKIE_OPTIONS = { httpOnly: true, secure: true, sameSite: "strict", path: "/", maxAge: 60 * 60 * 12 } as const;

/**
 * Next 16 "proxy" (formerly middleware). Mints a per-request nonce, forwards it to the render through the
 * x-nonce request header, sets CSP and the security headers, and rotates the session tokens BEFORE render
 * (the only place a cookie can be rotated safely). A rejected refresh clears the cookie.
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const nonce = mintNonce();
  const base = readApiBaseUrl(process.env);
  const csp = buildCsp({
    nonce,
    apiOrigin: base === null ? null : new URL(base).origin,
    development: process.env.NODE_ENV === "development",
    documentOrigin: readDocumentOrigin(process.env),
  });

  let rotated: string | null = null;
  let cleared = false;
  const current = decodeSessionCookie(request.cookies.get(SESSION_COOKIE)?.value);
  if (current !== null && base !== null) {
    const out = await refreshIfNeeded(current, Date.now(), {
      transport: createFetchTransport({ baseUrl: base }),
      installToken: parseInstallToken(request.cookies.get(INSTALL_COOKIE)?.value),
    });
    if (out.kind === "refreshed") rotated = encodeSessionCookie(out.state);
    if (out.kind === "signed_out") cleared = true;
  }

  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("x-pathname", request.nextUrl.pathname);
  headers.set("x-search", request.nextUrl.search);
  headers.set("content-security-policy", csp);
  if (rotated !== null || cleared) {
    const rest = (request.headers.get("cookie") ?? "").split(/;\s*/).filter((c) => c !== "" && !c.startsWith(`${SESSION_COOKIE}=`));
    if (rotated !== null) rest.push(`${SESSION_COOKIE}=${rotated}`);
    headers.set("cookie", rest.join("; "));
  }
  const response = NextResponse.next({ request: { headers } });
  if (rotated !== null) response.cookies.set(SESSION_COOKIE, rotated, SESSION_COOKIE_OPTIONS);
  if (cleared) {
    response.cookies.delete(SESSION_COOKIE);
    // A refresh the API rejected (mismatch, reuse, revoked device) ends the install binding too.
    response.cookies.delete(INSTALL_COOKIE);
  }
  response.headers.set("content-security-policy", csp);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) response.headers.set(k, v);
  return response;
}

export const config = {
  matcher: [{ source: "/((?!_next/static|_next/image|favicon.ico|fonts/).*)" }],
};
