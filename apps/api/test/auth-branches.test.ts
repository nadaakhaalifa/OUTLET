import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UnconfiguredPasskeys } from "../src/modules/auth/index.js";
import { RP_ID, RP_ORIGIN, bearer, createTestApp, idemKey } from "./harness.js";
import type { TestApp } from "./harness.js";
import { authedHeaders, enrollPasskey, phone, signIn } from "./flows.js";
import { VirtualAuthenticator } from "./webauthn.js";

let t: TestApp;
beforeAll(async () => { t = await createTestApp(); });
afterAll(async () => { await t.close(); });
// Test helper: the caller names the expected shape.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
const json = <T>(body: string): T => JSON.parse(body) as T;
const code = (body: string): string => json<{ code: string }>(body).code;

const registerOptions = async (s: Awaited<ReturnType<typeof signIn>>): Promise<{ challenge_id: string; public_key: { challenge: string; excludeCredentials?: { id: string }[] } }> => {
  const o = await t.inject({ method: "POST", url: "/v1/eg/auth/passkeys/register/options", headers: authedHeaders(t, s.token, { "x-device-id": s.deviceId }), payload: { purpose: "register" } });
  expect(o.statusCode).toBe(200);
  return json(o.body);
};
const registerVerify = (s: Awaited<ReturnType<typeof signIn>>, challengeId: string, credential: unknown) =>
  t.inject({ method: "POST", url: "/v1/eg/auth/passkeys/register/verify", headers: authedHeaders(t, s.token, { "x-device-id": s.deviceId }), payload: { challenge_id: challengeId, credential } });

describe("passkey enrolment negatives", () => {
  it("a challenge issued to another user is refused (422) and is burned for its owner too", async () => {
    const owner = await signIn(t);
    const thief = await signIn(t);
    const o = await registerOptions(owner);
    const authn = new VirtualAuthenticator(RP_ID, RP_ORIGIN);
    const r = await registerVerify(thief, o.challenge_id, authn.create(o.public_key.challenge));
    expect(r.statusCode).toBe(422);
    expect(code(r.body)).toBe("passkey-challenge-invalid");
    const ownerTry = await registerVerify(owner, o.challenge_id, authn.create(o.public_key.challenge));
    expect(ownerTry.statusCode).toBe(422);
    expect(code(ownerTry.body)).toBe("passkey-challenge-invalid");
    expect(await t.passkeyStore.findByCredentialId("EG", authn.id)).toBeNull();
  });
  it("an unknown challenge id and an expired challenge are refused the same way", async () => {
    const s = await signIn(t);
    const authn = new VirtualAuthenticator(RP_ID, RP_ORIGIN);
    const o = await registerOptions(s);
    expect(code((await registerVerify(s, randomUUID(), authn.create(o.public_key.challenge))).body)).toBe("passkey-challenge-invalid");
    const o2 = await registerOptions(s);
    t.clock.now += 6 * 60_000;
    try {
      const r = await registerVerify({ ...s, token: await t.mint({ userId: s.userId }) }, o2.challenge_id, authn.create(o2.public_key.challenge));
      expect(r.statusCode).toBe(422);
      expect(code(r.body)).toBe("passkey-challenge-invalid");
    } finally {
      t.clock.now -= 6 * 60_000;
    }
  });
  it("an attestation from the wrong origin or for another challenge fails verification (422) and stores nothing", async () => {
    const s = await signIn(t);
    const o = await registerOptions(s);
    const authn = new VirtualAuthenticator(RP_ID, RP_ORIGIN);
    const r = await registerVerify(s, o.challenge_id, authn.create(o.public_key.challenge, { origin: "https://evil.test" }));
    expect(r.statusCode).toBe(422);
    expect(code(r.body)).toBe("passkey-verification-failed");
    const o2 = await registerOptions(s);
    const r2 = await registerVerify(s, o2.challenge_id, authn.create("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"));
    expect(code(r2.body)).toBe("passkey-verification-failed");
    expect(await t.passkeyStore.findByCredentialId("EG", authn.id)).toBeNull();
  });
  it("the same authenticator cannot be enrolled twice, not even by another user (409); the second options call excludes the first credential", async () => {
    const s = await signIn(t);
    const authn = await enrollPasskey(t, s);
    const o = await registerOptions(s);
    expect(o.public_key.excludeCredentials?.map((c) => c.id)).toContain(authn.id);
    const again = await registerVerify(s, o.challenge_id, authn.create(o.public_key.challenge));
    expect(again.statusCode).toBe(409);
    expect(code(again.body)).toBe("passkey-already-registered");
    const other = await signIn(t);
    const o3 = await registerOptions(other);
    const stolen = await registerVerify(other, o3.challenge_id, authn.create(o3.public_key.challenge));
    expect(stolen.statusCode).toBe(409);
  });
  it("the credential response omits secrets and reports a null last use before the first sign-in", async () => {
    const s = await signIn(t);
    const o = await registerOptions(s);
    const authn = new VirtualAuthenticator(RP_ID, RP_ORIGIN);
    const r = await registerVerify(s, o.challenge_id, authn.create(o.public_key.challenge));
    expect(r.statusCode).toBe(201);
    const body = json<Record<string, unknown>>(r.body);
    expect(body.last_used_at).toBeNull();
    expect(Object.keys(body).sort()).toEqual(["aaguid", "backup_eligible", "created_at", "id", "last_used_at", "transports"]);
  });
  it("register options and verify need a bearer token (401), and verify refuses an unknown body field (400)", async () => {
    expect((await t.inject({ method: "POST", url: "/v1/eg/auth/passkeys/register/options", headers: { "idempotency-key": idemKey(t) }, payload: { purpose: "register" } })).statusCode).toBe(401);
    expect((await t.inject({ method: "POST", url: "/v1/eg/auth/passkeys/register/verify", headers: { "idempotency-key": idemKey(t) }, payload: {} })).statusCode).toBe(401);
    const s = await signIn(t);
    const bad = await t.inject({ method: "POST", url: "/v1/eg/auth/passkeys/register/options", headers: authedHeaders(t, s.token), payload: { purpose: "register", extra: 1 } });
    expect(bad.statusCode).toBe(400);
  });
  it("wrong purposes: register options reject sign_in/step_up (422); assert options reject register (422)", async () => {
    const s = await signIn(t);
    for (const purpose of ["sign_in", "step_up"]) {
      const r = await t.inject({ method: "POST", url: "/v1/eg/auth/passkeys/register/options", headers: authedHeaders(t, s.token, { "x-device-id": s.deviceId }), payload: { purpose } });
      expect(r.statusCode).toBe(422);
      expect(code(r.body)).toBe("purpose-invalid");
    }
    const a = await t.inject({ method: "POST", url: "/v1/eg/auth/passkeys/assert/options", headers: { "x-device-id": s.deviceId, "idempotency-key": idemKey(t) }, payload: { purpose: "register" } });
    expect(a.statusCode).toBe(422);
    expect(code(a.body)).toBe("purpose-invalid");
  });
});

describe("UnconfiguredPasskeys fails closed", () => {
  it("every ceremony is 503 passkeys-unavailable and no credential is ever reported", async () => {
    const p = new UnconfiguredPasskeys();
    for (const call of [() => p.registrationOptions(), () => p.verifyRegistration(), () => p.assertionOptions(), () => p.verifyAssertion()]) {
      let err: unknown;
      try { await call(); } catch (e) { err = e; }
      expect(err).toMatchObject({ status: 503, code: "passkeys-unavailable" });
    }
    expect(await p.hasCredential()).toBe(false);
  });
});

describe("OTP and session edge cases over HTTP", () => {
  it("a step-up OTP request is accepted; a returning user verifies without a date of birth", async () => {
    const s = await signIn(t);
    const device = await t.device();
    const h = { "x-device-id": device };
    const req = await t.inject({ method: "POST", url: "/v1/eg/auth/otp/request", headers: { ...h, "idempotency-key": idemKey(t) }, payload: { phone_e164: s.phone, channel: "sms", purpose: "step_up" } });
    expect(req.statusCode).toBe(201);
    const { challenge_id } = json<{ challenge_id: string }>(req.body);
    const ver = await t.inject({ method: "POST", url: "/v1/eg/auth/otp/verify", headers: { ...h, "idempotency-key": idemKey(t) }, payload: { challenge_id, phone_e164: s.phone, code: t.sms.last() } });
    expect(ver.statusCode).toBe(200);
    expect(json<{ user_id: string }>(ver.body).user_id).toBe(s.userId);
  });
  it("a new number without a date of birth is 422 dob-required", async () => {
    const device = await t.device();
    const h = { "x-device-id": device };
    const p = phone();
    const req = await t.inject({ method: "POST", url: "/v1/eg/auth/otp/request", headers: { ...h, "idempotency-key": idemKey(t) }, payload: { phone_e164: p, channel: "sms", purpose: "sign_in" } });
    const { challenge_id } = json<{ challenge_id: string }>(req.body);
    const ver = await t.inject({ method: "POST", url: "/v1/eg/auth/otp/verify", headers: { ...h, "idempotency-key": idemKey(t) }, payload: { challenge_id, phone_e164: p, code: t.sms.last() } });
    expect(ver.statusCode).toBe(422);
    expect(code(ver.body)).toBe("dob-required");
  });
  it("an unregistered device id is rejected without a 500", async () => {
    const r = await t.inject({ method: "POST", url: "/v1/eg/auth/otp/request", headers: { "x-device-id": randomUUID(), "idempotency-key": idemKey(t) }, payload: { phone_e164: phone(), channel: "sms", purpose: "sign_in" } });
    expect(r.statusCode).toBeLessThan(500);
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
  });
  it("session list pages with a keyset cursor, never leaks another user's sessions, and a tampered cursor is 400", async () => {
    const s = await signIn(t);
    const second = await signIn(t); // a different user: must never appear in s's list
    const h = bearer(s.token);
    for (let i = 0; i < 2; i++) {
      const device = await t.device();
      const rq = await t.inject({ method: "POST", url: "/v1/eg/auth/otp/request", headers: { "x-device-id": device, "idempotency-key": idemKey(t) }, payload: { phone_e164: s.phone, channel: "sms", purpose: "sign_in" } });
      t.clock.now += 1000;
      const { challenge_id } = json<{ challenge_id: string }>(rq.body);
      const v = await t.inject({ method: "POST", url: "/v1/eg/auth/otp/verify", headers: { "x-device-id": device, "idempotency-key": idemKey(t) }, payload: { challenge_id, phone_e164: s.phone, code: t.sms.last() } });
      expect(v.statusCode).toBe(200);
    }
    const p1 = json<{ items: { id: string; last_seen_at: string | null }[]; next_cursor: string | null }>((await t.inject({ method: "GET", url: "/v1/eg/me/sessions?limit=1", headers: h })).body);
    expect(p1.items).toHaveLength(1);
    expect(p1.next_cursor).not.toBeNull();
    const p2 = json<{ items: { id: string }[]; next_cursor: string | null }>((await t.inject({ method: "GET", url: `/v1/eg/me/sessions?limit=5&cursor=${p1.next_cursor ?? ""}`, headers: h })).body);
    expect(p2.items.length).toBeGreaterThanOrEqual(1);
    expect(p2.items.map((i) => i.id)).not.toContain(p1.items[0]?.id);
    const all = [...p1.items, ...p2.items].map((i) => i.id);
    expect(all).not.toContain(second.sessionId);
    expect((await t.inject({ method: "GET", url: "/v1/eg/me/sessions?cursor=bad", headers: h })).statusCode).toBe(400);
    expect((await t.inject({ method: "DELETE", url: `/v1/eg/me/sessions/${randomUUID()}`, headers: authedHeaders(t, s.token) })).statusCode).toBeLessThan(500);
  });
  it("logout answers 204 and clears the refresh cookie (Max-Age=0)", async () => {
    const s = await signIn(t);
    const first = await t.inject({ method: "POST", url: "/v1/eg/auth/logout", headers: authedHeaders(t, s.token), payload: {} });
    expect(first.statusCode).toBe(204);
    expect(String(first.headers["set-cookie"])).toContain("Max-Age=0");
  });
});
