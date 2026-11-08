import { randomUUID } from "node:crypto";
import { purgeExpired } from "@outlet/auth-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { roleClient } from "@outlet/db/testing";
import { PgChallengeStore, UnconfiguredDeviceAttestation, WebAuthnPasskeys, maskPhone } from "../src/modules/auth/index.js";
import { RP_ID, RP_ORIGIN, createTestApp, idemKey } from "./harness.js";
import type { TestApp } from "./harness.js";
import { assertVerifyRequest, authedHeaders, enrollPasskey, phone, signIn } from "./flows.js";
import { VirtualAuthenticator } from "./webauthn.js";

let t: TestApp;
beforeAll(async () => { t = await createTestApp(); });
afterAll(async () => { await t.close(); });
// Test helper: the caller names the expected shape.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
const json = <T>(body: string): T => JSON.parse(body) as T;
const code = (body: string): string => json<{ code: string }>(body).code;
const refresh = (s: { deviceId: string }, token: string) =>
  t.inject({ method: "POST", url: "/v1/eg/auth/refresh", headers: { "x-device-id": s.deviceId, "idempotency-key": idemKey(t) }, payload: { refresh_token: token } });

describe("finding 3: refresh grace window", () => {
  it("a second presentation within 10 s returns the same pair; a third is reuse and revokes the family", async () => {
    const s = await signIn(t);
    const a = await refresh(s, s.refresh);
    const b = await refresh(s, s.refresh);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(json<{ refresh_token: string }>(b.body).refresh_token).toBe(json<{ refresh_token: string }>(a.body).refresh_token);
    const c = await refresh(s, s.refresh);
    expect(c.statusCode).toBe(401);
    const after = await refresh(s, json<{ refresh_token: string }>(a.body).refresh_token);
    expect(after.statusCode).toBe(401);
  });

  it("after 10 s the rotated token is reuse", async () => {
    const s = await signIn(t);
    await refresh(s, s.refresh);
    t.clock.now += 11_000;
    try {
      expect((await refresh(s, s.refresh)).statusCode).toBe(401);
    } finally {
      t.clock.now -= 11_000;
    }
  });
});

describe("finding 4: logout without a valid access token", () => {
  const logout = (deviceId: string, o: { body?: Record<string, string>; cookie?: string }) =>
    t.inject({ method: "POST", url: "/v1/eg/auth/logout-by-refresh", headers: { "x-device-id": deviceId, ...(o.cookie === undefined ? {} : { cookie: o.cookie }) }, payload: o.body ?? {} });

  it("revokes the family by refresh token (body), with the access token long expired", async () => {
    const s = await signIn(t);
    t.clock.now += 3_600_000;
    try {
      const r = await logout(s.deviceId, { body: { refresh_token: s.refresh } });
      expect(r.statusCode).toBe(204);
      expect(String(r.headers["set-cookie"])).toContain("Max-Age=0");
      expect((await refresh(s, s.refresh)).statusCode).toBe(401);
    } finally {
      t.clock.now -= 3_600_000;
    }
  });

  it("works from the HttpOnly cookie, and unknown, missing or repeated tokens are all 204 (no oracle)", async () => {
    const s = await signIn(t);
    expect((await logout(s.deviceId, { cookie: `__Secure-outlet_rt=${s.refresh}` })).statusCode).toBe(204);
    expect((await refresh(s, s.refresh)).statusCode).toBe(401);
    expect((await logout(s.deviceId, { cookie: `__Secure-outlet_rt=${s.refresh}` })).statusCode).toBe(204);
    expect((await logout(s.deviceId, { body: { refresh_token: "nope" } })).statusCode).toBe(204);
    expect((await logout(s.deviceId, {})).statusCode).toBe(204);
  });

  it("is rate limited per device and needs a device id", async () => {
    const d = await t.device();
    expect((await t.inject({ method: "POST", url: "/v1/eg/auth/logout-by-refresh", payload: {} })).statusCode).toBe(400);
    let last = 204;
    for (let i = 0; i < 31; i++) last = (await logout(d, { body: { refresh_token: "x" } })).statusCode;
    expect(last).toBe(429);
  });
});

describe("finding 5: device registration trust and phone verify budget", () => {
  const register = (app: TestApp, o: { attestation?: string; ip?: string } = {}) =>
    app.inject({ method: "POST", url: "/v1/eg/auth/devices", ...(o.ip === undefined ? {} : { remoteAddress: o.ip }), payload: { install_id: randomUUID(), platform: "ios", ...(o.attestation === undefined ? {} : { attestation: o.attestation }) } });

  it("a failed attestation is 403 and registers nothing; the verifier sees the install", async () => {
    const app = await createTestApp();
    try {
      app.attestation.reject = true;
      const before = (await app.raw.query<{ n: string }>("SELECT count(*)::text n FROM devices")).rows[0]?.n;
      const r = await register(app, { attestation: "tok" });
      expect(r.statusCode).toBe(403);
      expect(code(r.body)).toBe("attestation-failed");
      expect((await app.raw.query<{ n: string }>("SELECT count(*)::text n FROM devices")).rows[0]?.n).toBe(before);
      expect(app.attestation.seen.at(-1)?.token).toBe("tok");
      app.attestation.reject = false;
      expect((await register(app, { attestation: "tok" })).statusCode).toBe(201);
    } finally {
      await app.close();
    }
  });

  it("the unconfigured verifier fails closed with 503", async () => {
    await expect(new UnconfiguredDeviceAttestation().verify()).rejects.toMatchObject({ status: 503, code: "device-attestation-unavailable" });
  });

  it("a registration storm from one IP is throttled (429) while another IP is not", async () => {
    const app = await createTestApp();
    try {
      // 20 per hour x10 (CGNAT multiplier) = 200 per IP; the guard runs before body validation, so bad bodies still count.
      for (let i = 0; i < 200; i++) expect((await app.inject({ method: "POST", url: "/v1/eg/auth/devices", remoteAddress: "10.1.1.1", payload: {} })).statusCode).toBe(400);
      const stormed = await app.inject({ method: "POST", url: "/v1/eg/auth/devices", remoteAddress: "10.1.1.1", payload: {} });
      expect(stormed.statusCode).toBe(429);
      expect(stormed.headers["retry-after"]).toBeDefined();
      expect((await register(app, { ip: "10.2.2.2" })).statusCode).toBe(201);
    } finally {
      await app.close();
    }
  });

  it("verify attempts per phone are capped across challenges and devices (429 on the 11th)", async () => {
    const p = phone();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const d = await t.device();
      const r = await t.inject({ method: "POST", url: "/v1/eg/auth/otp/verify", headers: { "x-device-id": d, "idempotency-key": idemKey(t) }, payload: { challenge_id: randomUUID(), phone_e164: p, code: "000000" } });
      statuses.push(r.statusCode);
    }
    expect(statuses.slice(0, 10).every((x) => x !== 429)).toBe(true);
    expect(statuses[10]).toBe(429);
    // another phone is unaffected
    const d = await t.device();
    const other = await t.inject({ method: "POST", url: "/v1/eg/auth/otp/verify", headers: { "x-device-id": d, "idempotency-key": idemKey(t) }, payload: { challenge_id: randomUUID(), phone_e164: phone(), code: "000000" } });
    expect(other.statusCode).not.toBe(429);
  });
});

describe("finding 6: passkey lifecycle", () => {
  it("lists my passkeys (no key material) and revokes one; a stranger gets 404 and the owner's passkey survives", async () => {
    const owner = await signIn(t);
    const stranger = await signIn(t);
    await enrollPasskey(t, owner);
    const list = await t.inject({ method: "GET", url: "/v1/eg/me/passkeys", headers: authedHeaders(t, owner.token) });
    expect(list.statusCode).toBe(200);
    const items = json<{ items: { id: string; public_key?: unknown; credential_id?: unknown }[] }>(list.body).items;
    expect(items).toHaveLength(1);
    expect(items[0]).not.toHaveProperty("public_key");
    const id = items[0]?.id ?? "";
    expect((await t.inject({ method: "DELETE", url: `/v1/eg/me/passkeys/${id}`, headers: authedHeaders(t, stranger.token) })).statusCode).toBe(404);
    expect(json<{ items: unknown[] }>((await t.inject({ method: "GET", url: "/v1/eg/me/passkeys", headers: authedHeaders(t, stranger.token) })).body).items).toHaveLength(0);
    expect((await t.inject({ method: "DELETE", url: `/v1/eg/me/passkeys/${id}`, headers: authedHeaders(t, owner.token) })).statusCode).toBe(204);
    expect((await t.inject({ method: "DELETE", url: `/v1/eg/me/passkeys/${id}`, headers: authedHeaders(t, owner.token) })).statusCode).toBe(404);
    expect(json<{ items: unknown[] }>((await t.inject({ method: "GET", url: "/v1/eg/me/passkeys", headers: authedHeaders(t, owner.token) })).body).items).toHaveLength(0);
  });

  it("a revoked passkey can no longer sign in", async () => {
    const s = await signIn(t);
    const authn = await enrollPasskey(t, s);
    const id = json<{ items: { id: string }[] }>((await t.inject({ method: "GET", url: "/v1/eg/me/passkeys", headers: authedHeaders(t, s.token) })).body).items[0]?.id ?? "";
    await t.inject({ method: "DELETE", url: `/v1/eg/me/passkeys/${id}`, headers: authedHeaders(t, s.token) });
    expect((await t.inject(await assertVerifyRequest(t, authn, s.deviceId))).statusCode).toBe(401);
  });

  it("an assertion challenge is bound to the device that asked for it (422), and burned", async () => {
    const s = await signIn(t);
    const authn = await enrollPasskey(t, s);
    const req = await assertVerifyRequest(t, authn, s.deviceId);
    const other = await t.device();
    const r = await t.inject({ ...req, headers: { ...req.headers, "x-device-id": other } });
    expect(r.statusCode).toBe(422);
    expect(code(r.body)).toBe("passkey-challenge-invalid");
    expect((await t.inject(req)).statusCode).toBe(422);
  });

  it("a registration challenge is bound to the device too", async () => {
    const s = await signIn(t);
    const o = await t.inject({ method: "POST", url: "/v1/eg/auth/passkeys/register/options", headers: authedHeaders(t, s.token, { "x-device-id": s.deviceId }), payload: { purpose: "register" } });
    const body = json<{ challenge_id: string; public_key: { challenge: string } }>(o.body);
    const r = await t.inject({
      method: "POST", url: "/v1/eg/auth/passkeys/register/verify", headers: authedHeaders(t, s.token, { "x-device-id": await t.device() }),
      payload: { challenge_id: body.challenge_id, credential: new VirtualAuthenticator(RP_ID, RP_ORIGIN).create(body.public_key.challenge) },
    });
    expect(r.statusCode).toBe(422);
  });

  it("user.id is a random handle (not the user uuid), shared by a user's credentials; userName is not the user id", async () => {
    const s = await signIn(t);
    const opts = async (): Promise<{ user: { id: string; name: string } }> => {
      const o = await t.inject({ method: "POST", url: "/v1/eg/auth/passkeys/register/options", headers: authedHeaders(t, s.token, { "x-device-id": s.deviceId }), payload: { purpose: "register" } });
      return json<{ public_key: { user: { id: string; name: string } } }>(o.body).public_key;
    };
    const first = await opts();
    expect(first.user.id).not.toBe(Buffer.from(s.userId).toString("base64url"));
    expect(first.user.name).not.toContain(s.userId);
    await enrollPasskey(t, s);
    await enrollPasskey(t, s);
    const rows = await t.passkeyStore.listByUser("EG", s.userId);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.userHandle).toBe(rows[1]?.userHandle);
    expect(rows[0]?.userHandle).not.toBe(s.userId);
    expect((await opts()).user.id).toBe(rows[0]?.userHandle);
  });

  it("maskPhone hides the middle digits", () => {
    expect(maskPhone("+201012345678")).toBe("+20********78");
    expect(maskPhone("+1")).toBe("Outlex account");
  });
});

describe("finding 7: challenge store in Postgres", () => {
  const store = (): PgChallengeStore => new PgChallengeStore(roleClient(t.raw, "outlet_auth"));
  const ch = (o: { expires?: Date; market?: string } = {}) => ({
    id: randomUUID(), marketId: o.market ?? "EG", purpose: "assert" as const, userId: null, deviceId: randomUUID(), challenge: "c".repeat(43), expiresAt: o.expires ?? new Date(t.clock.now + 300_000),
  });

  it("is single-use, also under concurrency", async () => {
    const c = ch();
    await store().put(c);
    const now = new Date(t.clock.now);
    const got = await Promise.all([store().take(c.id, "EG", now), store().take(c.id, "EG", now), store().take(c.id, "EG", now)]);
    expect(got.filter((g) => g !== null)).toHaveLength(1);
    expect(await store().take(c.id, "EG", now)).toBeNull();
  });

  it("expires (TTL), is market-bound, and an expired take still consumes it", async () => {
    const c = ch({ expires: new Date(t.clock.now + 1000) });
    await store().put(c);
    expect(await store().take(c.id, "AE", new Date(t.clock.now))).toBeNull();
    expect(await store().take(c.id, "EG", new Date(t.clock.now + 2000))).toBeNull();
    expect(await store().take(c.id, "EG", new Date(t.clock.now))).toBeNull();
  });

  it("two API instances share it: a ceremony started on one finishes on the other, once", async () => {
    const mk = (): WebAuthnPasskeys => new WebAuthnPasskeys({ marketId: "EG", rpName: "x", rpId: RP_ID, origins: [RP_ORIGIN], challengeTtlMs: 300_000, now: () => new Date(t.clock.now) }, t.passkeyStore, store());
    const a = mk();
    const b = mk();
    const s = await signIn(t);
    const o = await a.registrationOptions({ userId: s.userId, deviceId: s.deviceId, now: new Date(t.clock.now) });
    const authn = new VirtualAuthenticator(RP_ID, RP_ORIGIN);
    const credential = authn.create((o.publicKey as { challenge: string }).challenge);
    const rec = await b.verifyRegistration({ userId: s.userId, deviceId: s.deviceId, challengeId: o.challengeId, credential, now: new Date(t.clock.now) });
    expect(rec.userHandle.length).toBeGreaterThanOrEqual(32);
    await expect(a.verifyRegistration({ userId: s.userId, deviceId: s.deviceId, challengeId: o.challengeId, credential, now: new Date(t.clock.now) })).rejects.toMatchObject({ code: "passkey-challenge-invalid" });
  });

  it("purgeExpired removes challenges an hour past expiry and keeps fresh ones", async () => {
    const old = ch({ expires: new Date(Date.now() - 2 * 3_600_000) });
    const fresh = ch({ expires: new Date(Date.now() + 3_600_000) });
    await store().put(old);
    await store().put(fresh);
    const counts = await purgeExpired(t.raw, new Date());
    expect(counts.passkeyChallenges).toBeGreaterThanOrEqual(1);
    const left = await t.raw.query<{ id: string }>("SELECT id FROM passkey_challenges WHERE id = ANY($1)", [[old.id, fresh.id]]);
    expect(left.rows.map((r) => r.id)).toEqual([fresh.id]);
  });
});
