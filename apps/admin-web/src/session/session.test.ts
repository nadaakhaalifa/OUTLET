import { describe, expect, it } from "vitest";
import type { Transport, TransportRequest } from "../api/transport";
import { ApiSession } from "./api-session";
import type { SessionState, SessionStore } from "./port";
import { INSTALL_COOKIE, INSTALL_COOKIE_OPTIONS, parseInstallToken, type InstallTokenStore } from "./install-token";
import { decodeSessionCookie, encodeSessionCookie, refreshIfNeeded } from "./refresh";
import { fromBase64Url, serializeAssertion, toBase64Url } from "./webauthn";
import { serializeAssertionInput } from "../server/passkey-input";

const U = "11111111-1111-4111-8111-111111111111";
const INSTALL = "A".repeat(43);
const tokens = (extra: object = {}) => ({
  access_token: "a2", access_expires_at: "2026-10-11T10:10:00Z", refresh_token: "r2", refresh_expires_at: "2026-11-11T10:00:00Z", install_token: INSTALL, ...extra,
});

function installStore(initial: string | null = null) {
  let value = initial;
  const store: InstallTokenStore = { read: async () => value, write: async (t) => { value = t; } };
  return { store, get value() { return value; } };
}

function fixture(json: unknown[], status = 200) {
  const sent: TransportRequest[] = [];
  const queue = [...json];
  const transport: Transport = { async send(req) { sent.push(req); return { status, headers: {}, json: queue.shift() }; } };
  let stored: SessionState | null = null;
  const store: SessionStore = { read: async () => stored, write: async (s) => { stored = s; } };
  return { sent, transport, store, get stored() { return stored; } };
}

describe("passkey-only session", () => {
  it("signs in with options then assertion and stores tokens", async () => {
    const f = fixture([{ challenge_id: U, challenge: "abc", rp_id: "admin.example", expires_at: "2026-10-11T10:05:00Z" }, tokens()]);
    const s = new ApiSession({
      transport: f.transport, store: f.store, installTokens: installStore().store, newIdempotencyKey: () => "k",
      credentials: { getAssertion: async () => ({ ok: true, value: { id: "c" } }) },
    });
    const r = await s.signInWithPasskey();
    expect(r.ok).toBe(true);
    expect(f.sent.map((x) => x.path)).toEqual(["/v1/auth/passkey/assert/options", "/v1/auth/passkey/assert"]);
    expect(f.stored?.accessToken).toBe("a2");
  });
  it("refuses a token that still wants a second factor", async () => {
    const f = fixture([tokens({ second_factor_required: true })]);
    const s = new ApiSession({
      transport: f.transport, store: f.store, installTokens: installStore().store, newIdempotencyKey: () => "k",
      credentials: { getAssertion: async () => ({ ok: false, error: "unsupported" }) },
    });
    const r = await s.completePasskey(U, {});
    expect(r).toEqual({ ok: false, error: "rejected" });
    expect(f.stored).toBeNull();
  });
  it("has no weaker sign-in path on the port", () => {
    const proto = Object.getOwnPropertyNames(ApiSession.prototype);
    expect(proto.some((n) => /totp|otp|password/i.test(n))).toBe(false);
  });
});

describe("server-minted install token (web session binding)", () => {
  const session = (f: ReturnType<typeof fixture>, installs = installStore()) =>
    new ApiSession({
      transport: f.transport, store: f.store, installTokens: installs.store, newIdempotencyKey: () => "k",
      credentials: { getAssertion: async () => ({ ok: true, value: { id: "c" } }) },
    });

  it("sends platform web with no client install id and keeps the token the server returned", async () => {
    const f = fixture([tokens()]);
    const installs = installStore("B".repeat(43));
    const r = await session(f, installs).completePasskey(U, {});
    expect(r.ok).toBe(true);
    const body = f.sent[0]?.body as { device: Record<string, unknown> };
    expect(body.device).toEqual({ platform: "web" });
    expect(JSON.stringify(f.sent[0])).not.toContain("00000000-0000-4000-8000-000000000000");
    // Rotated at login: the previous value is replaced by the new server-minted one.
    expect(installs.value).toBe(INSTALL);
  });
  it("refuses a sign-in response without a well-formed install token and stores nothing", async () => {
    for (const bad of [undefined, "short", "!".repeat(43)]) {
      const f = fixture([tokens({ install_token: bad })]);
      const installs = installStore();
      expect(await session(f, installs).completePasskey(U, {})).toEqual({ ok: false, error: "rejected" });
      expect(f.stored).toBeNull();
      expect(installs.value).toBeNull();
    }
  });
  it("refresh sends the token as X-Admin-Install and no device_install_id", async () => {
    const f = fixture([tokens({ install_token: undefined })]);
    f.store.write({ accessToken: "a", refreshToken: "r", accessExpiresAtMs: 1 });
    const r = await session(f, installStore(INSTALL)).refresh();
    expect(r.ok).toBe(true);
    expect(f.sent[0]?.headers).toEqual({ "x-admin-install": INSTALL });
    expect(f.sent[0]?.body).toEqual({ refresh_token: "r" });
  });
  it("sign-out clears the install token", async () => {
    const f = fixture([{}]);
    f.store.write({ accessToken: "a", refreshToken: "r", accessExpiresAtMs: 1 });
    const installs = installStore(INSTALL);
    await session(f, installs).signOut();
    expect(installs.value).toBeNull();
  });
  it("the proxy refresh carries the cookie token as a header and never invents one", async () => {
    const state: SessionState = { accessToken: "a", refreshToken: "r", accessExpiresAtMs: 1_000_000 };
    const f = fixture([tokens({ install_token: undefined })]);
    await refreshIfNeeded(state, 999_999, { transport: f.transport, installToken: INSTALL });
    expect(f.sent[0]?.headers).toEqual({ "x-admin-install": INSTALL });
    expect(f.sent[0]?.body).toEqual({ refresh_token: "r" });
    const g = fixture([tokens({ install_token: undefined })]);
    await refreshIfNeeded(state, 999_999, { transport: g.transport, installToken: null });
    expect(g.sent[0]?.headers).toEqual({});
  });
  it("cookie contract: __Host- prefix, httpOnly, secure, strict, root path, no domain", () => {
    expect(INSTALL_COOKIE).toBe("__Host-admin-install");
    expect(INSTALL_COOKIE_OPTIONS).toMatchObject({ httpOnly: true, secure: true, sameSite: "strict", path: "/" });
    expect("domain" in INSTALL_COOKIE_OPTIONS).toBe(false);
  });
  it("parseInstallToken accepts only the server's 43-char base64url shape", () => {
    expect(parseInstallToken(INSTALL)).toBe(INSTALL);
    for (const bad of [undefined, null, "", "A".repeat(42), "A".repeat(44), "A".repeat(42) + "=", "A".repeat(42) + " "]) {
      expect(parseInstallToken(bad)).toBeNull();
    }
  });
});

describe("proxy refresh and cookie", () => {
  const state: SessionState = { accessToken: "a", refreshToken: "r", accessExpiresAtMs: 1_000_000 };
  it("leaves a fresh token alone and refreshes near expiry", async () => {
    const f = fixture([tokens()]);
    const fresh = await refreshIfNeeded(state, 0, { transport: f.transport, installToken: INSTALL });
    expect(fresh.kind).toBe("fresh");
    expect(f.sent).toHaveLength(0);
    const r = await refreshIfNeeded(state, 990_000, { transport: f.transport, installToken: INSTALL });
    expect(r.kind).toBe("refreshed");
  });
  it("signs out on a rejected refresh instead of retrying", async () => {
    const f = fixture([{ code: "reuse" }], 401);
    expect((await refreshIfNeeded(state, 999_999, { transport: f.transport, installToken: INSTALL })).kind).toBe("signed_out");
    expect(f.sent).toHaveLength(1);
  });
  it("round-trips the cookie and rejects junk", () => {
    expect(decodeSessionCookie(encodeSessionCookie(state))).toEqual(state);
    expect(decodeSessionCookie("not-base64!!")).toBeNull();
    expect(decodeSessionCookie(undefined)).toBeNull();
    expect(decodeSessionCookie("x".repeat(5000))).toBeNull();
  });
});

describe("webauthn encoding", () => {
  it("base64url round-trips and serializes assertions", () => {
    const bytes = new Uint8Array([251, 255, 0, 1, 2]).buffer;
    expect(toBase64Url(bytes)).toBe("-_8AAQI");
    expect(new Uint8Array(fromBase64Url("-_8AAQI"))).toEqual(new Uint8Array(bytes));
    const out = serializeAssertion({ id: "i", rawId: bytes, type: "public-key", response: { clientDataJSON: bytes, authenticatorData: bytes, signature: bytes, userHandle: null } });
    expect(out).toMatchObject({ raw_id: "-_8AAQI", response: { user_handle: null } });
  });
  it("validates the credential the browser posts", () => {
    const good = { id: "i", raw_id: "r", type: "public-key", response: { client_data_json: "a", authenticator_data: "b", signature: "c", user_handle: null } };
    expect(serializeAssertionInput(U, JSON.stringify(good))).not.toBeNull();
    expect(serializeAssertionInput(U, JSON.stringify({ ...good, extra: 1 }))).toBeNull();
    expect(serializeAssertionInput("bad", JSON.stringify(good))).toBeNull();
    expect(serializeAssertionInput(U, "{")).toBeNull();
  });
});
