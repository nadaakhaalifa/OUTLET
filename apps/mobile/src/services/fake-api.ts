/** Test support: a fake-fetch generated client plus an adapter context (no network, no timers). */
import { createClient, type FetchLike } from "./api-client";
import type { AdapterContext } from "./wire";

export interface FakeReq { method: string; path: string; query: URLSearchParams; headers: Record<string, string>; body: unknown }
export type FakeHandler = (r: FakeReq) => { status?: number; body?: unknown; headers?: Record<string, string> };

export const FIXED_NOW = "2026-10-11T10:00:00Z";

export function fakeApi(routes: Record<string, FakeHandler>, locale: "ar" | "en" = "en") {
  const calls: FakeReq[] = [];
  const fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    const req: FakeReq = {
      method: init?.method ?? "GET",
      path: u.pathname,
      query: u.searchParams,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(req);
    const h = routes[`${req.method} ${req.path}`];
    if (h === undefined) {
      return new Response(JSON.stringify({ type: "/problems/not-found", title: "nf", status: 404 }), { status: 404, headers: { "Content-Type": "application/problem+json" } });
    }
    const r = h(req);
    const status = r.status ?? 200;
    const problem = status >= 400;
    return new Response(status === 204 ? null : JSON.stringify(r.body ?? {}), {
      status,
      headers: { "Content-Type": problem ? "application/problem+json" : "application/json", ...(r.headers ?? {}) },
    });
  };
  const client = createClient({ baseUrl: "https://api.test", fetch, getToken: () => "tok", sleep: async () => undefined, randomBytes: (n) => new Uint8Array(n).fill(3), maxRetries: 0 });
  const ctx: AdapterContext = { client, locale: () => locale, nowMs: () => Date.parse(FIXED_NOW), deviceId: () => "install-device-1" };
  return { ctx, calls };
}

export const problem = (status: number, code: string, extra: Record<string, unknown> = {}) => ({
  status,
  body: { type: `/problems/${code}`, title: code, status, code, ...extra },
});
