import { z } from "zod";
import { uuidv7 } from "../lib/uuid7";

// Same-origin backend-for-frontend. Browser JS never sees an access or refresh token: both live in HttpOnly cookies set here.
export const COOKIE_ACCESS = "ox_at";
export const COOKIE_REFRESH = "ox_rt";
export const COOKIE_INSTALL = "ox_iid";
/** Device id returned by POST /auth/devices; sent as X-Device-Id on every upstream call. */
export const COOKIE_DEVICE = "ox_did";
const INSTALL_MAX_AGE_S = 60 * 60 * 24 * 365;
/** Longest query string the proxy forwards (bytes of the raw `?…`). */
export const MAX_SEARCH_LENGTH = 2048;

export interface CookieOp {
  readonly name: string;
  readonly value: string;
  readonly maxAge: number;
}
export interface BffRequest {
  readonly method: string;
  readonly host: string;
  readonly origin: string | null;
  readonly secFetchSite?: string | null;
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
const UUID = /^[0-9a-f-]{36}$/;
const PROXY_ROOTS = new Set(["cart", "checkout", "order-groups", "me", "geo-areas", "products", "shipping"]);
const PUBLIC_ROOTS = new Set(["geo-areas", "products"]);
const GET_ONLY_ROOTS = new Set(["products", "geo-areas"]);

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
const problem = (status: number, title: string): BffResult => ({ status, body: JSON.stringify({ type: `urn:outlex:problem:${title}`, title, status }), retryAfter: null, cookies: [] });
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

/** Mutations must come from this origin (Origin, or Sec-Fetch-Site: same-origin when Origin is absent) with a JSON body (SameSite=Lax cookies plus an explicit check; ASVS 3.5). */
export function csrfOk(req: BffRequest): boolean {
  if (req.method === "GET" || req.method === "HEAD") return true;
  if (req.origin === null) {
    if (req.secFetchSite !== "same-origin") return false;
  } else {
    try {
      if (new URL(req.origin).host !== req.host) return false;
    } catch {
      return false;
    }
  }
  return req.body === "" || (req.contentType ?? "").toLowerCase().startsWith("application/json");
}

interface Ctx {
  readonly deps: BffDeps;
  readonly base: string;
  readonly iid: string;
  readonly newInstall: boolean;
  did: string;
  newDevice: boolean;
}
function ctxOf(req: BffRequest, deps: BffDeps): Ctx | BffResult {
  if (deps.apiUrl === undefined) return problem(503, "api-unconfigured");
  const existing = req.cookies[COOKIE_INSTALL];
  const valid = existing !== undefined && UUID.test(existing);
  const device = req.cookies[COOKIE_DEVICE];
  const haveDevice = valid && device !== undefined && UUID.test(device);
  return { deps, base: deps.apiUrl.replace(/\/+$/, ""), iid: valid ? existing : crypto.randomUUID(), newInstall: !valid, did: haveDevice ? device : "", newDevice: false };
}
const isResult = (x: Ctx | BffResult): x is BffResult => "status" in x;

const withInstall = (c: Ctx, r: BffResult): BffResult => {
  const extra: CookieOp[] = [];
  if (c.newInstall) extra.push({ name: COOKIE_INSTALL, value: c.iid, maxAge: INSTALL_MAX_AGE_S });
  if (c.newInstall || c.newDevice) extra.push({ name: COOKIE_DEVICE, value: c.did, maxAge: INSTALL_MAX_AGE_S });
  return extra.length === 0 || c.did === "" ? r : { ...r, cookies: [...r.cookies, ...extra] };
};

interface SendOpts {
  readonly bearer?: string | undefined;
  /** Idempotency-Key for this call. Only the client's own proxied mutation may reuse the browser's key; internal calls mint a fresh one. */
  readonly idempotencyKey?: string | null;
  readonly noIdempotency?: boolean;
}
async function send(c: Ctx, req: BffRequest, path: string, method: string, body: unknown, o: SendOpts = {}): Promise<{ res: Response; text: string }> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (req.acceptLanguage !== null) headers["accept-language"] = req.acceptLanguage;
  if (o.bearer !== undefined) headers.authorization = `Bearer ${o.bearer}`;
  if (c.did !== "") headers["x-device-id"] = c.did;
  if (method !== "GET") {
    if (o.noIdempotency !== true) headers["idempotency-key"] = o.idempotencyKey ?? uuidv7(c.deps.now?.());
    if (body !== undefined) headers["content-type"] = "application/json";
  }
  const res = await c.deps.fetch(`${c.base}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), cache: "no-store" });
  return { res, text: await res.text() };
}
const passthrough = (res: Response, text: string, cookies: readonly CookieOp[] = []): BffResult => ({
  status: res.status, body: text === "" || res.status === 204 ? null : text, retryAfter: res.headers.get("retry-after"), cookies,
});

/** First contact: register the install and remember the device id (HttpOnly cookie). Returns an error result when the API refuses. */
async function ensureDevice(c: Ctx, req: BffRequest, market: string): Promise<BffResult | null> {
  if (c.did !== "") return null;
  let out: { res: Response; text: string };
  try {
    out = await send(c, req, `/v1/${market}/auth/devices`, "POST", { install_id: c.iid, platform: "web" }, { noIdempotency: true });
  } catch {
    return problem(502, "bad-upstream");
  }
  if (!out.res.ok) return passthrough(out.res, out.text);
  const parsed = z.object({ device_id: z.string().regex(UUID) }).safeParse(safeJson(out.text));
  if (!parsed.success) return problem(502, "bad-upstream");
  c.did = parsed.data.device_id;
  c.newDevice = true;
  return null;
}

const AUTH_ACTIONS = ["otp-request", "otp-verify", "passkey-options", "passkey-verify", "logout", "session"] as const;
const PHONE = z.string().regex(/^\+[1-9][0-9]{7,14}$/);
const inputs: Readonly<Record<string, z.ZodType>> = {
  "otp-request": z.object({ phone_e164: PHONE, purpose: z.enum(["sign_in", "register"]), channel: z.enum(["sms", "whatsapp"]).default("sms") }).strict(),
  "otp-verify": z.object({ challenge_id: z.string().min(1), phone_e164: PHONE, code: z.string().regex(/^[0-9]{6}$/), dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).strict(),
  "passkey-verify": z.object({ challenge_id: z.string().min(1), credential: z.record(z.string(), z.unknown()) }).strict(),
};

const isRejection = (status: number): boolean => status === 401 || status === 400 || status === 409 || status === 404;

export async function handleAuth(req: BffRequest, market: string, action: string, deps: BffDeps): Promise<BffResult> {
  if (!MARKET.test(market) || !(AUTH_ACTIONS as readonly string[]).includes(action)) return problem(404, "not-found");
  if (action === "session") {
    if (req.method !== "GET") return problem(405, "method-not-allowed");
    return handleSession(req, market, deps);
  }
  if (req.method !== "POST") return problem(405, "method-not-allowed");
  if (!csrfOk(req)) return problem(403, "csrf");
  const c = ctxOf(req, deps);
  if (isResult(c)) return c;
  const prefix = `/v1/${market}`;
  const raw = req.body === "" ? {} : safeJson(req.body);
  if (raw === null) return problem(400, "invalid-json");

  if (action === "logout") return handleLogout(c, req, market);
  const schema = inputs[action];
  let data: Record<string, unknown> = {};
  if (action !== "passkey-options") {
    const parsed = schema?.safeParse(raw);
    if (parsed?.success !== true) return problem(400, "invalid-body");
    data = parsed.data as Record<string, unknown>;
  }
  const failed = await ensureDevice(c, req, market);
  if (failed !== null) return failed;
  try {
    if (action === "passkey-options") {
      const { res, text } = await send(c, req, `${prefix}/auth/passkeys/assert/options`, "POST", { purpose: "sign_in" });
      return withInstall(c, passthrough(res, text));
    }
    if (action === "otp-request") {
      const { res, text } = await send(c, req, `${prefix}/auth/otp/request`, "POST", data, { idempotencyKey: req.idempotencyKey });
      return withInstall(c, passthrough(res, text));
    }
    const path = action === "otp-verify" ? "/auth/otp/verify" : "/auth/passkeys/assert/verify";
    const { res, text } = await send(c, req, `${prefix}${path}`, "POST", data, { idempotencyKey: req.idempotencyKey });
    if (!res.ok) return withInstall(c, passthrough(res, text));
    const pair = tokenPairSchema.safeParse(safeJson(text));
    if (!pair.success) return withInstall(c, problem(502, "bad-upstream"));
    const now = (deps.now ?? Date.now)();
    return withInstall(c, { status: 200, body: JSON.stringify({ user_id: pair.data.user_id, is_new_user: pair.data.is_new_user }), retryAfter: null, cookies: tokenCookies(pair.data, now) });
  } catch {
    return withInstall(c, problem(502, "bad-upstream"));
  }
}

/** Revoke upstream with a valid access token (refreshing first when it is missing or expired). Cookies are always cleared; a failed revocation is a 502, never a silent 204. */
async function handleLogout(c: Ctx, req: BffRequest, market: string): Promise<BffResult> {
  const rt = req.cookies[COOKIE_REFRESH];
  let at = req.cookies[COOKIE_ACCESS];
  const done = (status: number, title: string | null): BffResult => withInstall(c, title === null ? { status, body: null, retryAfter: null, cookies: clear() } : { ...problem(status, title), cookies: clear() });
  if (at === undefined && rt === undefined) return done(204, null);
  const failed = await ensureDevice(c, req, market);
  if (failed !== null) return done(502, "logout-failed");
  const state = { refreshed: false };
  const renew = async (): Promise<"ok" | "dead" | "error"> => {
    if (rt === undefined) return "dead";
    state.refreshed = true;
    const r = await refresh(c, req, market, rt);
    if (r.pair !== null) { at = r.pair.access_token; return "ok"; }
    return isRejection(r.status) ? "dead" : "error";
  };
  try {
    if (at === undefined) {
      const r = await renew();
      if (r === "dead") return done(204, null); // the refresh token is already unusable: nothing left to revoke
      if (r === "error") return done(502, "logout-failed");
    }
    let out = await send(c, req, `/v1/${market}/auth/logout`, "POST", undefined, { bearer: at });
    if (out.res.status === 401 && !state.refreshed) {
      const r = await renew();
      if (r === "dead") return done(204, null);
      if (r === "error") return done(502, "logout-failed");
      out = await send(c, req, `/v1/${market}/auth/logout`, "POST", undefined, { bearer: at });
    }
    return out.res.ok ? done(204, null) : done(502, "logout-failed");
  } catch {
    return done(502, "logout-failed");
  }
}

/** The session is "authenticated" only if the API accepts it (a cheap authenticated read), not because cookies exist. */
async function handleSession(req: BffRequest, market: string, deps: BffDeps): Promise<BffResult> {
  if (req.cookies[COOKIE_ACCESS] === undefined && req.cookies[COOKIE_REFRESH] === undefined) {
    return { status: 200, body: JSON.stringify({ authenticated: false }), retryAfter: null, cookies: [] };
  }
  const r = await handleProxy({ ...req, search: "?limit=1", body: "" }, market, ["me", "sessions"], deps);
  if (r.status === 200) return { ...r, body: JSON.stringify({ authenticated: true }) };
  if (r.status === 401) return { ...r, status: 200, body: JSON.stringify({ authenticated: false }) };
  return { ...r, body: JSON.stringify({ type: "urn:outlex:problem:bad-upstream", title: "bad-upstream", status: r.status }) };
}

// One refresh per refresh token at a time: the API rotates refresh tokens and treats reuse as theft (revokes the family).
const inflight = new Map<string, Promise<{ pair: TokenPair | null; status: number }>>();
async function refresh(c: Ctx, req: BffRequest, market: string, rt: string): Promise<{ pair: TokenPair | null; status: number }> {
  const existing = inflight.get(rt);
  if (existing) return existing;
  const p = (async () => {
    try {
      // Fresh key: the browser's Idempotency-Key belongs to the proxied mutation only.
      const { res, text } = await send(c, req, `/v1/${market}/auth/refresh`, "POST", { refresh_token: rt }, { idempotencyKey: null });
      if (!res.ok) return { pair: null, status: res.status };
      const pair = tokenPairSchema.safeParse(safeJson(text));
      return { pair: pair.success ? pair.data : null, status: res.status };
    } catch {
      return { pair: null, status: 0 };
    }
  })().finally(() => { setTimeout(() => inflight.delete(rt), 5000); });
  inflight.set(rt, p);
  return p;
}

export async function handleProxy(req: BffRequest, market: string, path: readonly string[], deps: BffDeps): Promise<BffResult> {
  const root = path[0];
  if (!MARKET.test(market) || root === undefined || !PROXY_ROOTS.has(root) || path.some((s) => !SEGMENT.test(s))) return problem(404, "not-found");
  if (!["GET", "POST", "PATCH", "DELETE"].includes(req.method)) return problem(405, "method-not-allowed");
  if (GET_ONLY_ROOTS.has(root) && req.method !== "GET") return problem(405, "method-not-allowed");
  if (req.search.length > MAX_SEARCH_LENGTH) return problem(414, "uri-too-long");
  if (req.search !== "" && !req.search.startsWith("?")) return problem(400, "invalid-query");
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
  const registered = await ensureDevice(c, req, market);
  if (registered !== null) return registered;
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
      if (isRejection(r.status)) cookies = clear();
      return false;
    }
    at = r.pair.access_token;
    cookies = tokenCookies(r.pair, now);
    return true;
  };
  const key = { idempotencyKey: req.idempotencyKey };
  try {
    if (at === undefined && !isPublic) await renew();
    if (at === undefined && !isPublic) return withInstall(c, { ...problem(401, "unauthenticated"), cookies });
    let out = await send(c, req, target, req.method, body, { ...key, ...(at === undefined ? {} : { bearer: at }) });
    if (out.res.status === 401 && !isPublic && (await renew())) out = await send(c, req, target, req.method, body, { ...key, ...(at === undefined ? {} : { bearer: at }) });
    if (out.res.status === 401 && !isPublic && cookies.length === 0) cookies = clear();
    return withInstall(c, passthrough(out.res, out.text, cookies));
  } catch {
    return withInstall(c, problem(502, "bad-upstream"));
  }
}
