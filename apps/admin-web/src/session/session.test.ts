import { describe, expect, it } from "vitest";
import type { Transport, TransportRequest } from "../api/transport";
import { ApiSession } from "./api-session";
import type { SessionState, SessionStore } from "./port";
import { decodeSessionCookie, encodeSessionCookie, refreshIfNeeded } from "./refresh";
import { fromBase64Url, serializeAssertion, toBase64Url } from "./webauthn";
import { serializeAssertionInput } from "../server/passkey-input";

const U = "11111111-1111-4111-8111-111111111111";
const tokens = (extra: object = {}) => ({
  access_token: "a2", access_expires_at: "2026-10-11T10:10:00Z", refresh_token: "r2", refresh_expires_at: "2026-11-11T10:00:00Z", ...extra,
});

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
      transport: f.transport, store: f.store, installId: () => U, newIdempotencyKey: () => "k",
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
      transport: f.transport, store: f.store, installId: () => U, newIdempotencyKey: () => "k",
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

describe("proxy refresh and cookie", () => {
  const state: SessionState = { accessToken: "a", refreshToken: "r", accessExpiresAtMs: 1_000_000 };
  it("leaves a fresh token alone and refreshes near expiry", async () => {
    const f = fixture([tokens()]);
    const fresh = await refreshIfNeeded(state, 0, { transport: f.transport, installId: U });
    expect(fresh.kind).toBe("fresh");
    expect(f.sent).toHaveLength(0);
    const r = await refreshIfNeeded(state, 990_000, { transport: f.transport, installId: U });
    expect(r.kind).toBe("refreshed");
  });
  it("signs out on a rejected refresh instead of retrying", async () => {
    const f = fixture([{ code: "reuse" }], 401);
    expect((await refreshIfNeeded(state, 999_999, { transport: f.transport, installId: U })).kind).toBe("signed_out");
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
