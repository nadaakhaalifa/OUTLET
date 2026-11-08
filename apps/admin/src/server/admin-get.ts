import { cookies } from "next/headers";
import { REASON_HEADER } from "./bff";
import { PROFILE_COOKIE, readEnv, SESSION_COOKIE } from "./env";
import { parseProfile, type Profile } from "./session";

export type ServerResult<T> = { readonly ok: true; readonly data: T } | { readonly ok: false; readonly status: number; readonly code: string };

/** The signed-in staff profile from the cookie, or null when absent or expired. */
export async function currentProfile(): Promise<Profile | null> {
  const jar = await cookies();
  return parseProfile(jar.get(PROFILE_COOKIE)?.value, new Date());
}

/** Server-component GET against the admin API with the cookie token. Never throws; never fabricates data. */
export async function adminGet(market: string, path: string, query: Readonly<Record<string, string | undefined>> = {}, reason?: string): Promise<ServerResult<unknown>> {
  const apiUrl = readEnv().API_URL;
  if (apiUrl === undefined) return { ok: false, status: 503, code: "api-unconfigured" };
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token === undefined || token === "") return { ok: false, status: 401, code: "unauthenticated" };
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") qs.set(k, v);
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: "application/json" };
  if (reason !== undefined && REASON_HEADER.test(reason)) headers["x-reason-code"] = reason;
  try {
    const res = await fetch(`${apiUrl.replace(/\/+$/, "")}/v1/${market}/admin/${path}${qs.size > 0 ? `?${qs.toString()}` : ""}`, { headers, signal: AbortSignal.timeout(10_000), cache: "no-store" });
    const text = await res.text();
    if (res.ok) return { ok: true, data: JSON.parse(text) as unknown };
    let code = "unknown";
    try {
      const p = JSON.parse(text) as { code?: unknown };
      if (typeof p.code === "string") code = p.code;
    } catch {
      // not JSON
    }
    return { ok: false, status: res.status, code };
  } catch {
    return { ok: false, status: 503, code: "api-unavailable" };
  }
}
