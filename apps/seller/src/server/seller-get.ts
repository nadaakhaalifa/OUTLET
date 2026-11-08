import { cookies } from "next/headers";
import { readEnv, SESSION_COOKIE, STORE_COOKIE } from "./env";

export type ServerResult<T> = { readonly ok: true; readonly data: T } | { readonly ok: false; readonly status: number; readonly code: string };

/** Server-component GET against the API with the cookie token and active store. Never throws. */
export async function sellerGet(market: string, path: string): Promise<ServerResult<unknown>> {
  const apiUrl = readEnv().API_URL;
  if (apiUrl === undefined) return { ok: false, status: 503, code: "api-unconfigured" };
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  const store = jar.get(STORE_COOKIE)?.value;
  if (token === undefined || token === "") return { ok: false, status: 401, code: "unauthenticated" };
  if (store === undefined || store === "") return { ok: false, status: 400, code: "store-scope-required" };
  try {
    const res = await fetch(`${apiUrl.replace(/\/+$/, "")}/v1/${market}/seller/${path}`, {
      headers: { authorization: `Bearer ${token}`, "x-store-id": store, accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
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
