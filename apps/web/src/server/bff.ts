import { z } from "zod";
import { uuidv7 } from "../lib/uuid7";

// Same-origin backend-for-frontend. Browser JS never sees an access or refresh token: both live in HttpOnly cookies set here.
export const COOKIE_ACCESS = "ox_at";
export const COOKIE_REFRESH = "ox_rt";
export const COOKIE_INSTALL = "ox_iid";
const INSTALL_MAX_AGE_S = 60 * 60 * 24 * 365;
/** Policy version the age gate attests to (age_policy table v1). */
export const AGE_POLICY_VERSION = 1;

export interface CookieOp {
  readonly name: string;
  readonly value: string;
  readonly maxAge: number;
}
export interface BffRequest {
  readonly method: string;
  readonly host: string;
  readonly origin: string | null;
  readonly contentType: string | null;
  readonly acceptLanguage: string | null;
  readonly idempotencyKey: string | null;
  readonly userAgent: string | null;
  readonly cookies: Readonly<Record<string, string | undefined>>;
  readonly search: string;
  readonly body: string;
}
export interface BffResult {
  readonly status: number;
  readonly body: string | null;
  readonly retryAfter: string | null;
  readonly cookies: readonly CookieOp[];
}
export interface BffDeps {
  readonly apiUrl: string | undefined;
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  readonly now?: () => number;
}

const MARKET = /^[a-z]{2}(-[a-z0-9]{2,3})?$/;
const SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;
const PROXY_ROOTS = new Set(["cart", "checkout", "order-groups", "me", "geo-areas", "products", "shipping"]);
const PUBLIC_ROOTS = new Set(["geo-areas", "products"]);

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
const problem = (status: number, title: string): BffResult => ({ status, body: JSON.stringify({ title, status }), retryAfter: null, cookies: [] });
const clear = (): CookieOp[] => [
  { name: COOKIE_ACCESS, value: "", maxAge: 0 },
  { name: COOKIE_REFRESH, value: "", maxAge: 0 },
];

const tokenPairSchema = z.object({
  access_token: z.string(), access_expires_at: z.string(), refresh_token: z.string(), refresh_expires_at: z.string(), user_id: z.string(), is_new_user: z.boolean(),
});
type TokenPair = z.infer<typeof tokenPairSchema>;

function secondsUntil(iso: string, now: number): number {
  const s = Math.floor((Date.parse(iso) - now) / 1000);
  return Number.isFinite(s) ? Math.max(1, s) : 600;
}
function tokenCookies(t: TokenPair, now: number): CookieOp[] {
  return [
    { name: COOKIE_ACCESS, value: t.access_token, maxAge: secondsUntil(t.access_expires_at, now) },
    { name: COOKIE_REFRESH, value: t.refresh_token, maxAge: secondsUntil(t.refresh_expires_at, now) },
  ];
}

/** Mutations must come from this origin with a JSON body (SameSite=Lax cookies plus an explicit check; ASVS 3.5). */
export function csrfOk(req: BffRequest): boolean {
  if (req.method === "GET" || req.method === "HEAD") return true;
  if (req.origin === null) return false;
  try {
    if (new URL(req.origin).host !== req.host) return false;
  } catch {
    return false;
  }
  return req.body === "" || (req.contentType ?? "").toLowerCase().startsWith("application/json");
}

interface Ctx {
  readonly deps: BffDeps;
  readonly base: string;
  readonly iid: string;
  readonly newInstall: boolean;
}
function ctxOf(req: BffRequest, deps: BffDeps): Ctx | BffResult {
  if (deps.apiUrl === undefined) return problem(503, "api-unconfigured");
  const existing = req.cookies[COOKIE_INSTALL];
  const valid = existing !== undefined && /^[0-9a-f-]{36}$/.test(existing);
  return { deps, base: deps.apiUrl.replace(/\/+$/, ""), iid: valid ? existing : crypto.randomUUID(), newInstall: !valid };
}
const isResult = (x: Ctx | BffResult): x is BffResult => "status" in x;

const device = (c: Ctx, req: BffRequest) => ({ install_id: c.iid, platform: "web", ua_family: req.userAgent === null ? null : req.userAgent.slice(0, 200) });
const withInstall = (c: Ctx, r: BffResult): BffResult => (c.newInstall ? { ...r, cookies: [...r.cookies, { name: COOKIE_INSTALL, value: c.iid, maxAge: INSTALL_MAX_AGE_S }] } : r);

async function send(c: Ctx, req: BffRequest, path: string, method: string, body: unknown, bearer?: string): Promise<{ res: Response; text: string }> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (req.acceptLanguage !== null) headers["accept-language"] = req.acceptLanguage;
  if (bearer !== undefined) headers.authorization = `Bearer ${bearer}`;
  if (method !== "GET") {
    headers["idempotency-key"] = req.idempotencyKey ?? uuidv7(c.deps.now?.());
    if (body !== undefined) headers["content-type"] = "application/json";
  }
  const res = await c.deps.fetch(`${c.base}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), cache: "no-store" });
  return { res, text: await res.text() };
}
const passthrough = (res: Response, text: string, cookies: readonly CookieOp[] = []): BffResult => ({
  status: res.status, body: text === "" || res.status === 204 ? null : text, retryAfter: res.headers.get("retry-after"), cookies,
});

const AUTH_ACTIONS = ["otp-request", "age-gate", "otp-verify", "passkey-options", "passkey-verify", "logout", "session"] as const;
const inputs: Readonly<Record<string, z.ZodType>> = {
  "otp-request": z.object({ phone_e164: z.string().regex(/^\+[1-9][0-9]{7,14}$/), purpose: z.enum(["sign_in", "register"]), channel: z.enum(["sms", "whatsapp"]).default("sms") }).strict(),
  "age-gate": z.object({ dob: z.iso.date(), attested_18: z.boolean() }).strict(),
  "otp-verify": z.object({ challenge_id: z.string().min(1), code: z.string().regex(/^[0-9]{6}$/), age_gate_token: z.string().max(500).optional() }).strict(),
  "passkey-verify": z.object({ challenge_id: z.string().min(1), credential: z.record(z.string(), z.unknown()) }).strict(),
};

export async function handleAuth(req: BffRequest, market: string, action: string, deps: BffDeps): Promise<BffResult> {
  if (!MARKET.test(market) || !(AUTH_ACTIONS as readonly string[]).includes(action)) return problem(404, "not-found");
  if (action === "session") return { status: 200, body: JSON.stringify({ authenticated: req.cookies[COOKIE_REFRESH] !== undefined || req.cookies[COOKIE_ACCESS] !== undefined }), retryAfter: null, cookies: [] };
  if (req.method !== "POST") return problem(405, "method-not-allowed");
  if (!csrfOk(req)) return problem(403, "csrf");
  const c = ctxOf(req, deps);
  if (isResult(c)) return c;
  const prefix = `/v1/${market}`;
  const raw = req.body === "" ? {} : safeJson(req.body);
  if (raw === null) return problem(400, "invalid-json");

  if (action === "logout") {
    const at = req.cookies[COOKIE_ACCESS];
    if (at !== undefined) await send(c, req, `${prefix}/auth/logout`, "POST", undefined, at).catch(() => null);
    return { status: 204, body: null, retryAfter: null, cookies: clear() };
  }
  if (action === "passkey-options") {
    const { res, text } = await send(c, req, `${prefix}/auth/passkeys/assert/options`, "POST", { purpose: "sign_in", device: device(c, req) });
    return withInstall(c, passthrough(res, text));
  }
  const schema = inputs[action];
  const parsed = schema?.safeParse(raw);
  if (parsed?.success !== true) return problem(400, "invalid-body");
  const data = parsed.data as Record<string, unknown>;
  if (action === "otp-request") {
    const { res, text } = await send(c, req, `${prefix}/auth/otp/request`, "POST", { ...data, device: device(c, req) });
    return withInstall(c, passthrough(res, text));
  }
  if (action === "age-gate") {
    const { res, text } = await send(c, req, `${prefix}/auth/age-gate`, "POST", { dob: data.dob, attested_18: data.attested_18, policy_version: AGE_POLICY_VERSION, device: device(c, req) });
    return withInstall(c, passthrough(res, text));
  }
  const path = action === "otp-verify" ? "/auth/otp/verify" : "/auth/passkeys/assert/verify";
  const { res, text } = await send(c, req, `${prefix}${path}`, "POST", { ...data, device: device(c, req) });
  if (!res.ok) return withInstall(c, passthrough(res, text));
  const pair = tokenPairSchema.safeParse(safeJson(text));
  if (!pair.success) return problem(502, "bad-upstream");
  const now = (deps.now ?? Date.now)();
  return withInstall(c, { status: 200, body: JSON.stringify({ user_id: pair.data.user_id, is_new_user: pair.data.is_new_user }), retryAfter: null, cookies: tokenCookies(pair.data, now) });
}

// One refresh per refresh token at a time: the API rotates refresh tokens and treats reuse as theft (revokes the family).
const inflight = new Map<string, Promise<{ pair: TokenPair | null; status: number }>>();
async function refresh(c: Ctx, req: BffRequest, market: string, rt: string): Promise<{ pair: TokenPair | null; status: number }> {
  const existing = inflight.get(rt);
  if (existing) return existing;
  const p = (async () => {
    const { res, text } = await send(c, req, `/v1/${market}/auth/refresh`, "POST", { refresh_token: rt, device: device(c, req) });
    if (!res.ok) return { pair: null, status: res.status };
    const pair = tokenPairSchema.safeParse(safeJson(text));
    return { pair: pair.success ? pair.data : null, status: res.status };
  })().finally(() => { setTimeout(() => inflight.delete(rt), 5000); });
  inflight.set(rt, p);
  return p;
}

export async function handleProxy(req: BffRequest, market: string, path: readonly string[], deps: BffDeps): Promise<BffResult> {
  const root = path[0];
  if (!MARKET.test(market) || root === undefined || !PROXY_ROOTS.has(root) || path.some((s) => !SEGMENT.test(s))) return problem(404, "not-found");
  if (!["GET", "POST", "PATCH", "DELETE"].includes(req.method)) return problem(405, "method-not-allowed");
  if (root === "products" && req.method !== "GET") return problem(405, "method-not-allowed");
  if (!csrfOk(req)) return problem(403, "csrf");
  const c = ctxOf(req, deps);
  if (isResult(c)) return c;
  let body: unknown;
  if (req.body !== "") {
    try {
      body = JSON.parse(req.body) as unknown;
    } catch {
      return problem(400, "invalid-json");
    }
  }
  const target = `/v1/${market}/${path.join("/")}${req.search}`;
  const isPublic = PUBLIC_ROOTS.has(root);
  const now = (deps.now ?? Date.now)();
  let at = req.cookies[COOKIE_ACCESS];
  const rt = req.cookies[COOKIE_REFRESH];
  let cookies: readonly CookieOp[] = [];
  const renew = async (): Promise<boolean> => {
    if (rt === undefined) return false;
    const r = await refresh(c, req, market, rt);
    if (r.pair === null) {
      if (r.status === 401 || r.status === 400 || r.status === 409 || r.status === 404) cookies = clear();
      return false;
    }
    at = r.pair.access_token;
    cookies = tokenCookies(r.pair, now);
    return true;
  };
  if (at === undefined && !isPublic) await renew();
  if (at === undefined && !isPublic) return withInstall(c, { ...problem(401, "unauthenticated"), cookies });
  let out = await send(c, req, target, req.method, body, at);
  if (out.res.status === 401 && !isPublic && (await renew())) out = await send(c, req, target, req.method, body, at);
  if (out.res.status === 401 && !isPublic && cookies.length === 0) cookies = clear();
  return withInstall(c, passthrough(out.res, out.text, cookies));
}
