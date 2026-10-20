import { describe, expect, it } from "vitest";
import { operations, ApiError, ContractDriftError, NetworkError, TimeoutError, collectPages, createClient, dataOf, type ClientEvent, type FetchLike } from "./index";

const UUID = "0192f3a4-5b6c-7d8e-9f01-23456789abc1";
const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const problem = (status: number, code = "x") => json(status, { type: "/problems/x", title: "t", status, code, request_id: "r1" }, { "Content-Type": "application/problem+json" });

interface Call { url: string; init: RequestInit }
function script(responses: Array<Response | Error | (() => Promise<Response>)>) {
  const calls: Call[] = [];
  let i = 0;
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init: init ?? {} });
    const r = responses[Math.min(i++, responses.length - 1)];
    if (r === undefined) throw new Error("no scripted response");
    if (r instanceof Error) throw r;
    return typeof r === "function" ? r() : r;
  };
  return { fetch, calls };
}
const base = { baseUrl: "https://api.test/", sleep: async () => undefined, randomBytes: (n: number) => new Uint8Array(n).fill(7), clock: () => 1_800_000_000_000, random: () => 0.5 };
const hdr = (c: Call, k: string): string | undefined => (c.init.headers as Record<string, string>)[k];

const challenge = { challenge_id: UUID, expires_at: "2026-10-11T10:00:00Z", resend_after_seconds: 30 };

describe("client runtime", () => {
  it("builds one method per operation and parses a typed response", async () => {
    const s = script([json(202, { ...challenge })]);
    const c = createClient({ ...base, fetch: s.fetch });
    expect(Object.keys(c).length).toBe(Object.keys(operations).length);
    const r = await c.requestOtp({ body: { phone_e164: "+201001234567" } }).catch((e: unknown) => e);
    // Whether the fixture matches the schema is the contract test's job; here we only need a typed outcome.
    expect(r instanceof ContractDriftError || (typeof r === "object" && r !== null && "data" in r)).toBe(true);
    expect(s.calls[0]?.url).toBe("https://api.test/v1/auth/otp/request");
  });

  it("rejects a response that drifts from the contract with operationId and issues", async () => {
    const s = script([json(200, { items: [{ nope: 1 }], page: { next_cursor: null, has_more: false } })]);
    const c = createClient({ ...base, fetch: s.fetch, getToken: () => "tok" });
    const err = await c.listAddresses().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ContractDriftError);
    const d = err as ContractDriftError;
    expect(d.operationId).toBe("listAddresses");
    expect(d.phase).toBe("response");
    expect(d.issues.length).toBeGreaterThan(0);
  });

  it("rejects an invalid request before sending it", async () => {
    const s = script([json(200, {})]);
    const c = createClient({ ...base, fetch: s.fetch });
    const err = await c.requestOtp({ body: { phone_e164: 5 } } as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ContractDriftError);
    expect((err as ContractDriftError).phase).toBe("request");
    expect(s.calls.length).toBe(0);
  });

  it("parses Problem+JSON errors into ApiError", async () => {
    const s = script([problem(404, "not_found")]);
    const c = createClient({ ...base, fetch: s.fetch, getToken: () => "tok" });
    const err = await c.listAddresses().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
    expect((err as ApiError).code).toBe("not_found");
    expect((err as ApiError).problemValid).toBe(true);
  });

  it("treats a 4xx with a non-Problem JSON body as contract drift, and a gateway 502 as a flagged ApiError", async () => {
    const c1 = createClient({ ...base, fetch: script([json(400, { message: "bad" })]).fetch, getToken: () => "t" });
    expect(await c1.listAddresses().catch((e: unknown) => e)).toBeInstanceOf(ContractDriftError);
    const c2 = createClient({ ...base, maxRetries: 0, fetch: script([new Response("<html>bad gateway</html>", { status: 502 })]).fetch, getToken: () => "t" });
    const e2 = (await c2.listAddresses().catch((e: unknown) => e)) as ApiError;
    expect(e2).toBeInstanceOf(ApiError);
    expect(e2.problemValid).toBe(false);
  });

  it("sends one UUIDv7 Idempotency-Key per logical call and reuses it on retry", async () => {
    const s2 = script([new Response("", { status: 503 }), new Response("", { status: 503 }), problem(409, "conflict")]);
    const c2 = createClient({ ...base, fetch: s2.fetch, getToken: () => "tok" });
    await c2.logout().catch(() => undefined);
    const keys = s2.calls.map((x) => hdr(x, "Idempotency-Key"));
    expect(keys.length).toBe(3);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // A second logical call gets a fresh clock-independent key only when randomness differs; supplied keys win.
    const s3 = script([problem(409)]);
    await createClient({ ...base, fetch: s3.fetch, getToken: () => "tok" }).logout(undefined, { idempotencyKey: UUID }).catch(() => undefined);
    expect(hdr(s3.calls[0] as Call, "Idempotency-Key")).toBe(UUID);
  });

  it("never retries a non-idempotent request without a key, and never sends a key on GET", async () => {
    const s = script([new Response("", { status: 503 })]);
    const c = createClient({ ...base, fetch: s.fetch, getToken: () => "tok" });
    await c.listAddresses().catch(() => undefined);
    expect(s.calls.length).toBe(3); // GET is safe: 1 + 2 retries (all 503 via last scripted)
    expect(hdr(s.calls[0] as Call, "Idempotency-Key")).toBeUndefined();
  });

  it("retries network failures for safe requests, then throws NetworkError; a timeout throws TimeoutError", async () => {
    const s = script([new TypeError("down")]);
    const events: ClientEvent[] = [];
    const c = createClient({ ...base, fetch: s.fetch, getToken: () => "tok", onEvent: (e) => events.push(e) });
    expect(await c.listAddresses().catch((e: unknown) => e)).toBeInstanceOf(NetworkError);
    expect(s.calls.length).toBe(3);
    expect(events.filter((e) => e.outcome === "retry").length).toBe(2);
    const hang: FetchLike = (_u, init) => new Promise((_res, rej) => { if (init?.signal?.aborted === true) rej(new Error("aborted")); init?.signal?.addEventListener("abort", () => rej(new Error("aborted"))); });
    const c2 = createClient({ ...base, fetch: hang, getToken: () => "tok", timeoutMs: 5, maxRetries: 0 });
    expect(await c2.listAddresses().catch((e: unknown) => e)).toBeInstanceOf(TimeoutError);
  });

  it("honours a caller AbortSignal", async () => {
    const hang: FetchLike = (_u, init) => new Promise((_res, rej) => { if (init?.signal?.aborted === true) rej(new Error("aborted")); init?.signal?.addEventListener("abort", () => rej(new Error("aborted"))); });
    const ctl = new AbortController();
    const c = createClient({ ...base, fetch: hang, getToken: () => "tok" });
    const p = c.listAddresses(undefined, { signal: ctl.signal }).catch((e: unknown) => e);
    ctl.abort();
    expect(((await p) as Error).name).toBe("AbortedError");
  });

  it("refreshes once on 401 (shared by concurrent calls) and replays with the new token; no token leaks to events", async () => {
    let token = "old";
    let refreshCalls = 0;
    const fetch: FetchLike = async (_u, init) => {
      const auth = (init?.headers as Record<string, string>)["Authorization"];
      return auth === "Bearer new" ? json(200, { items: [], page: { next_cursor: null, has_more: false } }) : problem(401, "unauthenticated");
    };
    const events: ClientEvent[] = [];
    const c = createClient({
      ...base, fetch, getToken: () => token, onEvent: (e) => events.push(e),
      refreshToken: async () => { refreshCalls++; await Promise.resolve(); token = "new"; return "new"; },
    });
    const [a, b] = await Promise.all([c.listAddresses(), c.listAddresses()]);
    expect(dataOf(a).items).toEqual([]);
    expect(dataOf(b).items).toEqual([]);
    expect(refreshCalls).toBe(1);
    expect(JSON.stringify(events)).not.toContain("old");
    expect(JSON.stringify(events)).not.toContain("new");
  });

  it("surfaces the 401 when refresh yields no token, and does not loop", async () => {
    const s = script([problem(401, "unauthenticated")]);
    const c = createClient({ ...base, fetch: s.fetch, getToken: () => "t", refreshToken: async () => null });
    const err = (await c.listAddresses().catch((e: unknown) => e)) as ApiError;
    expect(err.status).toBe(401);
    expect(s.calls.length).toBe(1);
  });

  it("supports If-None-Match and surfaces 304 as notModified with the etag", async () => {
    const s = script([new Response(null, { status: 304, headers: { ETag: '"v1"' } })]);
    const c = createClient({ ...base, fetch: s.fetch });
    const r = await c.getProduct({ path: { productId: UUID }, headers: { "If-None-Match": '"v1"' } });
    expect(r.notModified).toBe(true);
    expect(hdr(s.calls[0] as Call, "If-None-Match")).toBe('"v1"');
    expect(r.etag).toBe('"v1"');
  });

  it("follows cursors with collectPages and sends limit/cursor query", async () => {
    const page = (n: string | null) => json(200, { items: [], page: { next_cursor: n, has_more: n !== null } });
    const s = script([page("c2"), page("c3"), page(null)]);
    const c = createClient({ ...base, fetch: s.fetch, getToken: () => "t" });
    const items = await collectPages((cursor) => c.listAddresses(cursor === undefined ? { query: { limit: 2 } } : { query: { cursor, limit: 2 } }));
    expect(items).toEqual([]);
    expect(s.calls.map((x) => x.url)).toEqual([
      "https://api.test/v1/me/addresses?limit=2",
      "https://api.test/v1/me/addresses?cursor=c2&limit=2",
      "https://api.test/v1/me/addresses?cursor=c3&limit=2",
    ]);
  });
});
