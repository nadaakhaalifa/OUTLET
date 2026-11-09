import { SESSION_COOKIE } from "./env";

/** The BFF forwards only what the API contract needs; the browser never sees the bearer token (HttpOnly cookie). */

const MARKET = /^[a-z]{2}$/;
const ID = "[0-9a-f-]{36}";
export const REASON_HEADER = /^[a-z_]{3,40}(:[A-Za-z0-9-]{1,40})?$/;

interface Route {
  readonly pattern: RegExp;
  readonly methods: readonly string[];
  /** Anonymous routes need no session cookie (the passkey ceremony itself). */
  readonly anonymous?: true;
}

const routes: readonly Route[] = [
  { pattern: /^auth\/passkey\/(options|verify)$/, methods: ["POST"], anonymous: true },
  { pattern: /^auth\/logout$/, methods: ["POST"] },
  { pattern: /^dashboard$/, methods: ["GET"] },
  { pattern: /^attention$/, methods: ["GET"] },
  { pattern: new RegExp(`^attention/${ID}/(ack|resolve)$`), methods: ["POST"] },
  { pattern: /^kyc-cases$/, methods: ["GET"] },
  { pattern: new RegExp(`^kyc-cases/${ID}$`), methods: ["GET"] },
  { pattern: new RegExp(`^kyc-cases/${ID}/decision$`), methods: ["POST"] },
  { pattern: new RegExp(`^kyc-cases/${ID}/documents/${ID}/url$`), methods: ["GET"] },
  { pattern: /^price-integrity\/(findings|enforcement-actions|reports)$/, methods: ["GET"] },
  { pattern: new RegExp(`^price-integrity/stores/${ID}/trust$`), methods: ["GET"] },
  { pattern: /^reconciliation\/runs$/, methods: ["GET", "POST"] },
  { pattern: new RegExp(`^reconciliation/runs/${ID}/items$`), methods: ["GET"] },
  { pattern: new RegExp(`^reconciliation/items/${ID}/resolve$`), methods: ["POST"] },
  { pattern: /^approval-requests$/, methods: ["GET"] },
  { pattern: new RegExp(`^approval-requests/${ID}/decision$`), methods: ["POST"] },
  { pattern: /^elevations$/, methods: ["POST"] },
  { pattern: /^privacy\/(requests|breaches|transfer-register|consent-stats|pii-access-log)$/, methods: ["GET"] },
  { pattern: /^audit-log$/, methods: ["GET"] },
  { pattern: /^audit-log\/verify$/, methods: ["POST"] },
];

const FORWARD_REQUEST = ["content-type", "idempotency-key", "accept-language", "accept"] as const;
const FORWARD_RESPONSE = ["content-type", "retry-after", "idempotent-replayed", "www-authenticate"] as const;

export interface BffInput {
  readonly method: string;
  readonly segments: readonly string[];
  readonly search: string;
  readonly headers: Headers;
  readonly cookies: { get(name: string): { value: string } | undefined };
  readonly body: ArrayBuffer | null;
  readonly apiUrl: string | undefined;
}

export type BffPlan =
  | { readonly kind: "forward"; readonly url: string; readonly path: string; readonly init: { method: string; headers: Headers; body?: ArrayBuffer } }
  | { readonly kind: "reject"; readonly status: number; readonly code: string };

const reject = (status: number, code: string): BffPlan => ({ kind: "reject", status, code });

/** Same-origin check for state-changing calls (the cookie is SameSite=Lax; this closes the remaining CSRF gap). */
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
  const route = routes.find((r) => r.pattern.test(path));
  if (route === undefined) return reject(404, "not-found");
  if (!route.methods.includes(i.method)) return reject(405, "method-not-allowed");
  if (i.method !== "GET" && !sameOrigin(i.headers)) return reject(403, "cross-origin");
  if (i.apiUrl === undefined) return reject(503, "api-unconfigured");

  const headers = new Headers();
  for (const name of FORWARD_REQUEST) {
    const v = i.headers.get(name);
    if (v !== null) headers.set(name, v);
  }
  const reason = i.headers.get("x-reason-code");
  if (reason !== null) {
    if (!REASON_HEADER.test(reason)) return reject(422, "validation-failed");
    headers.set("x-reason-code", reason);
  }
  if (route.anonymous !== true) {
    const token = i.cookies.get(SESSION_COOKIE)?.value;
    if (token === undefined || token === "") return reject(401, "unauthenticated");
    headers.set("authorization", `Bearer ${token}`);
  }
  const url = `${i.apiUrl.replace(/\/+$/, "")}/v1/${market}/admin/${path}`;
  const isGet = i.method === "GET";
  return { kind: "forward", url: isGet ? `${url}${i.search}` : url, path, init: { method: i.method, headers, ...(!isGet && i.body !== null ? { body: i.body } : {}) } };
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

/** Header the API must send on the verify response with the staff bearer token (the contract does not say how the token is delivered yet). */
export const TOKEN_HEADER = "x-session-token";
