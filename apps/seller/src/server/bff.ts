import { z } from "zod";
import { STORE_COOKIE, SESSION_COOKIE } from "./env";

/** The BFF forwards only what the API contract needs; the browser never sees the bearer token (HttpOnly cookie). */

const MARKET = /^[a-z]{2}$/;
const UUID = z.uuid();
const ALLOWED_PATH = /^(products(\/[0-9a-f-]{36}(\/(readiness|media|defect-cards|publish))?)?|categories|attribute-sets\/[0-9a-f-]{36}|orders(\/[0-9a-f-]{36}(\/(accept|reject|pack))?)?|shipments|inventory(\/adjustments)?)$/;
const FORWARD_REQUEST = ["content-type", "idempotency-key", "if-match", "accept-language", "accept"] as const;
const FORWARD_RESPONSE = ["content-type", "etag", "retry-after", "idempotent-replayed", "www-authenticate"] as const;

export interface BffInput {
  readonly method: string;
  readonly segments: readonly string[];
  readonly search: string;
  readonly headers: Headers;
  readonly cookies: { get(name: string): { value: string } | undefined };
  readonly body: ArrayBuffer | null;
  readonly apiUrl: string | undefined;
}

export type BffPlan = { readonly kind: "forward"; readonly url: string; readonly init: { method: string; headers: Headers; body?: ArrayBuffer } } | { readonly kind: "reject"; readonly status: number; readonly code: string };

const reject = (status: number, code: string): BffPlan => ({ kind: "reject", status, code });

/** Same-origin check for state-changing calls (the cookie is SameSite=Lax, this closes the remaining CSRF gap). */
export const sameOrigin = (headers: Headers): boolean => {
  const site = headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return false;
  const origin = headers.get("origin");
  const host = headers.get("host");
  if (origin === null) return site === "same-origin";
  try {
    return host !== null && new URL(origin).host === host;
  } catch {
    return false;
  }
};

export function planProxy(i: BffInput): BffPlan {
  const [market, ...rest] = i.segments;
  if (market === undefined || !MARKET.test(market)) return reject(404, "unknown-market");
  const path = rest.join("/");
  if (!ALLOWED_PATH.test(path)) return reject(404, "not-found");
  const isWrite = i.method !== "GET";
  if (!["GET", "POST", "PATCH"].includes(i.method)) return reject(405, "method-not-allowed");
  if (isWrite && !sameOrigin(i.headers)) return reject(403, "cross-origin");
  if (i.apiUrl === undefined) return reject(503, "api-unconfigured");
  const token = i.cookies.get(SESSION_COOKIE)?.value;
  if (token === undefined || token === "") return reject(401, "unauthenticated");
  const store = i.cookies.get(STORE_COOKIE)?.value;
  if (store === undefined || !UUID.safeParse(store).success) return reject(400, "store-scope-required");

  const headers = new Headers();
  for (const name of FORWARD_REQUEST) {
    const v = i.headers.get(name);
    if (v !== null) headers.set(name, v);
  }
  headers.set("authorization", `Bearer ${token}`);
  headers.set("x-store-id", store);
  const url = `${i.apiUrl.replace(/\/+$/, "")}/v1/${market}/seller/${path}${i.method === "GET" ? i.search : ""}`;
  return { kind: "forward", url, init: { method: i.method, headers, ...(isWrite && i.body !== null ? { body: i.body } : {}) } };
}

export const problemResponse = (status: number, code: string): Response =>
  new Response(JSON.stringify({ type: `urn:outlex:problem:${code}`, title: code, status, code }), { status, headers: { "content-type": "application/problem+json", "cache-control": "no-store" } });

export const passResponse = async (upstream: Response): Promise<Response> => {
  const headers = new Headers({ "cache-control": "no-store" });
  for (const name of FORWARD_RESPONSE) {
    const v = upstream.headers.get(name);
    if (v !== null) headers.set(name, v);
  }
  return new Response(upstream.status === 204 || upstream.status === 304 ? null : await upstream.arrayBuffer(), { status: upstream.status, headers });
};
