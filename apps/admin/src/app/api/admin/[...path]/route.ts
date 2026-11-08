import { cookies, headers as nextHeaders } from "next/headers";
import type { NextRequest } from "next/server";
import { passResponse, planProxy, problemResponse, TOKEN_HEADER } from "../../../../server/bff";
import { PROFILE_COOKIE, readEnv, SESSION_COOKIE } from "../../../../server/env";
import { AdminSessionBody, profileFromSession, serializeProfile } from "../../../../server/session";

export const dynamic = "force-dynamic";

const cookieBase = { httpOnly: true, sameSite: "lax", path: "/", secure: process.env.NODE_ENV === "production" } as const;

async function handle(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const { path } = await ctx.params;
  const body = req.method === "GET" ? null : await req.arrayBuffer();
  const jar = await cookies();
  const plan = planProxy({ method: req.method, segments: path, search: req.nextUrl.search, headers: await nextHeaders(), cookies: jar, body, apiUrl: readEnv().API_URL });
  if (plan.kind === "reject") return problemResponse(plan.status, plan.code);
  let upstream: Response;
  try {
    upstream = await fetch(plan.url, { ...plan.init, signal: AbortSignal.timeout(15_000), cache: "no-store" });
  } catch {
    return problemResponse(503, "api-unavailable");
  }
  if (plan.path === "auth/passkey/verify" && upstream.ok) {
    const token = upstream.headers.get(TOKEN_HEADER);
    const session = AdminSessionBody.safeParse(await upstream.clone().json().catch(() => null));
    if (token === null || !session.success) return problemResponse(502, "bad-session-response");
    const profile = profileFromSession(session.data);
    const maxAge = Math.max(1, Math.floor((Date.parse(profile.expiresAt) - Date.now()) / 1000));
    jar.set(SESSION_COOKIE, token, { ...cookieBase, maxAge });
    jar.set(PROFILE_COOKIE, serializeProfile(profile), { ...cookieBase, maxAge });
  }
  if (plan.path === "auth/logout") {
    jar.delete(SESSION_COOKIE);
    jar.delete(PROFILE_COOKIE);
  }
  return passResponse(upstream);
}

export { handle as GET, handle as POST };
