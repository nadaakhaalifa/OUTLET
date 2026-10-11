import { describe, expect, it } from "vitest";
import { createSellerApi } from "../api/client";
import { readApiBaseUrl } from "../api/config";
import { createFetchTransport } from "../api/transport";
import { FakeSession } from "../session/fake";
import { ApiSession } from "../session/api-session";
import type { SessionState } from "../session/port";
import { fakeTransport, json, UUID_A } from "./fake-transport";

const state = { accessToken: "tok", refreshToken: "r", accessExpiresAtMs: 0, secondFactorRequired: false };
const orderBody = { id: UUID_A, status: "ACCEPTED", lines: [], subtotal: { amount: "0", currency: "EGP" }, shipping: { amount: "0", currency: "EGP" }, accept_by: "2026-10-12T00:00:00Z", payment_type: "prepaid", created_at: "2026-10-11T00:00:00Z" };

describe("seller api client", () => {
  it("sends bearer, an idempotency key on writes and none on reads", async () => {
    const t = fakeTransport({
      [`POST /v1/seller/orders/${UUID_A}/accept`]: () => json(orderBody),
      [`GET /v1/seller/orders/${UUID_A}`]: () => json(orderBody),
    });
    const api = createSellerApi({ transport: t, session: new FakeSession({ initial: state }), newIdempotencyKey: () => "k-1" });
    await api.acceptOrder(UUID_A);
    await api.getOrder(UUID_A);
    expect(t.calls[0]?.headers).toMatchObject({ authorization: "Bearer tok", "idempotency-key": "k-1" });
    expect(t.calls[1]?.headers?.["idempotency-key"]).toBeUndefined();
  });
  it("refreshes once on 401 and reuses the same idempotency key on the retry", async () => {
    let n = 0;
    const t = fakeTransport({
      [`POST /v1/seller/orders/${UUID_A}/accept`]: () => (n++ === 0 ? json({ title: "x" }, 401) : json(orderBody)),
    });
    const session = new FakeSession({ initial: state });
    const api = createSellerApi({ transport: t, session, newIdempotencyKey: () => "k-9" });
    const r = await api.acceptOrder(UUID_A);
    expect(r.ok).toBe(true);
    expect(session.refreshCalls).toBe(1);
    expect(t.calls.map((c) => c.headers?.["idempotency-key"])).toEqual(["k-9", "k-9"]);
    expect(t.calls[1]?.headers?.authorization).toBe("Bearer fake-access-1");
  });
  it("gives up with unauthorized when the refresh is rejected", async () => {
    const t = fakeTransport({ "GET /v1/seller/store": () => json({}, 401) });
    const api = createSellerApi({ transport: t, session: new FakeSession(), newIdempotencyKey: () => "k" });
    const r = await api.store();
    expect(r).toMatchObject({ ok: false, error: { kind: "unauthorized" } });
    expect(t.calls).toHaveLength(0);
  });
  it("carries problem code and request id, and violations", async () => {
    const t = fakeTransport({ "POST /v1/seller/team": () => json({ title: "bad", code: "invalid", request_id: "req-7", errors: [{ pointer: "/email", code: "format" }] }, 422) });
    const api = createSellerApi({ transport: t, session: new FakeSession({ initial: state }), newIdempotencyKey: () => "k" });
    const r = await api.inviteMember({ email: "x", role: "catalog" });
    expect(r).toMatchObject({ ok: false, error: { kind: "validation", code: "invalid", requestId: "req-7", violations: [{ pointer: "/email", code: "format" }] } });
  });
  it("rejects a response that fails the schema as a contract error", async () => {
    const t = fakeTransport({ [`GET /v1/seller/orders/${UUID_A}`]: () => json({ ...orderBody, subtotal: { amount: "12.5", currency: "EGP" } }) });
    const api = createSellerApi({ transport: t, session: new FakeSession({ initial: state }), newIdempotencyKey: () => "k" });
    expect(await api.getOrder(UUID_A)).toMatchObject({ ok: false, error: { kind: "contract" } });
  });
  it("url-encodes path ids", async () => {
    const t = fakeTransport({});
    const api = createSellerApi({ transport: t, session: new FakeSession({ initial: state }), newIdempotencyKey: () => "k" });
    await api.getOrder("a/b?c");
    expect(t.calls[0]?.path).toBe("/v1/seller/orders/a%2Fb%3Fc");
  });
});

describe("config + transport", () => {
  it("accepts https and loopback http only; otherwise not configured", () => {
    expect(readApiBaseUrl({ SELLER_API_BASE_URL: "https://api.example.test" })).toBe("https://api.example.test");
    expect(readApiBaseUrl({ SELLER_API_BASE_URL: "http://localhost:3000" })).toBe("http://localhost:3000");
    expect(readApiBaseUrl({ SELLER_API_BASE_URL: "http://api.example.test" })).toBeNull();
    expect(readApiBaseUrl({})).toBeNull();
    expect(readApiBaseUrl({ SELLER_API_BASE_URL: "not a url" })).toBeNull();
  });
  it("fetch transport builds the URL from the base and never forwards credentials", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (url: URL, init: RequestInit) => {
      seen = { url: url.toString(), init };
      return new Response(JSON.stringify({ ok: 1 }), { status: 200, headers: { date: "Sun, 11 Oct 2026 10:00:00 GMT" } });
    }) as unknown as typeof fetch;
    const tr = createFetchTransport({ baseUrl: "https://api.example.test/", fetchImpl });
    const res = await tr.send({ method: "GET", path: "/v1/seller/orders", query: { limit: 25, cursor: undefined } });
    expect(res.json).toEqual({ ok: 1 });
    expect((seen as unknown as { url: string }).url).toBe("https://api.example.test/v1/seller/orders?limit=25");
    expect((seen as unknown as { init: RequestInit }).init.credentials).toBe("omit");
  });
});

describe("ApiSession", () => {
  const tokens = { access_token: "a", access_expires_at: "2026-10-11T11:00:00Z", refresh_token: "r", refresh_expires_at: "2026-11-11T11:00:00Z" };
  const mk = (routes: Parameters<typeof fakeTransport>[0], cred: "ok" | "cancelled" = "ok") => {
    let stored: SessionState | null = null;
    const transport = fakeTransport(routes);
    const s = new ApiSession({
      transport,
      store: { read: async () => stored, write: async (v) => void (stored = v) },
      credentials: { getAssertion: async () => (cred === "ok" ? { ok: true, value: { id: "c" } } : { ok: false, error: "cancelled" }) },
      installId: () => UUID_A,
      newIdempotencyKey: () => "k",
    });
    return { s, transport, get stored() { return stored; } };
  };
  const opts = { challenge_id: UUID_A, challenge: "Y2g", rp_id: "seller.example.test", expires_at: "2026-10-11T10:05:00Z" };
  it("signs in with a passkey and stores tokens", async () => {
    const h = mk({ "POST /v1/auth/passkey/assert/options": () => json(opts), "POST /v1/auth/passkey/assert": () => json(tokens) });
    const r = await h.s.signInWithPasskey();
    expect(r.ok).toBe(true);
    expect(h.stored?.accessToken).toBe("a");
  });
  it("stores nothing when the user cancels the passkey prompt", async () => {
    const h = mk({ "POST /v1/auth/passkey/assert/options": () => json(opts) }, "cancelled");
    expect(await h.s.signInWithPasskey()).toEqual({ ok: false, error: "cancelled" });
    expect(h.stored).toBeNull();
  });
  it("fails closed on TOTP because the contract has no endpoint", async () => {
    const h = mk({});
    expect(await h.s.verifyTotp("123456")).toEqual({ ok: false, error: "totp_unavailable" });
  });
  it("clears local state on sign out even if the server call fails", async () => {
    const h = mk({ "POST /v1/auth/passkey/assert/options": () => json(opts), "POST /v1/auth/passkey/assert": () => json(tokens), "POST /v1/auth/logout": () => "network" });
    await h.s.signInWithPasskey();
    await h.s.signOut();
    expect(h.stored).toBeNull();
  });
});
