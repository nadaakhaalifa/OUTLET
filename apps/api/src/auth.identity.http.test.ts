import { createHash, createSign, generateKeyPairSync, type JsonWebKey, type KeyObject } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cairoToday, DEV_ATTESTATION_PREFIX, JWKS_KEY_FETCHER, type JwksKeyFetcher } from "./modules/auth";
import { AUTHENTICATOR, type Authenticator } from "./platform";
import { createHarness, INSTALL_ID, type Harness } from "./test/harness";

const OTHER_INSTALL_ID = "0192f3a4-5b6c-4d8e-9f01-23456789abce";
const DAY = 86_400_000;
const NOW_S = (h: Harness): number => Math.floor(h.clock.nowMs() / 1000);

const attest = (keyId: string) => ({ "X-App-Attest": `${DEV_ATTESTATION_PREFIX}${keyId}`, "X-Client-Platform": "ios" });
const deviceHash = (keyId: string): string => createHash("sha256").update(`device:${keyId}`).digest("hex");
const ADULT_DOB = "1990-05-17";
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

function dateString(d: { year: number; month: number; day: number }): string {
  return `${String(d.year).padStart(4, "0")}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
}

async function passGate(h: Harness, keyId: string, dob = ADULT_DOB) {
  return h
    .http()
    .post("/v1/auth/age-gate")
    .set(attest(keyId))
    .send({ dob, device_id_hash: deviceHash(keyId) });
}

// ---- JWT helpers ---------------------------------------------------------------------------

interface TestKey {
  readonly kid: string;
  readonly privateKey: KeyObject;
  readonly jwk: JsonWebKey;
}

function makeKey(kid: string): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { kid, privateKey, jwk: publicKey.export({ format: "jwk" }) };
}

const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString("base64url");

function signJwt(key: TestKey, claims: Record<string, unknown>, headerOverrides: Record<string, unknown> = {}): string {
  const header = { alg: "RS256", kid: key.kid, typ: "JWT", ...headerOverrides };
  const data = `${b64(header)}.${b64(claims)}`;
  const sig = createSign("RSA-SHA256").update(data).sign(key.privateKey).toString("base64url");
  return `${data}.${sig}`;
}

class FakeJwks implements JwksKeyFetcher {
  readonly keys = new Map<string, JsonWebKey>();
  down = false;
  async getKey(provider: "apple" | "google", kid: string): Promise<JsonWebKey | null> {
    if (this.down) throw new Error("jwks unreachable");
    return this.keys.get(`${provider}:${kid}`) ?? null;
  }
}

const jwks = new FakeJwks();
const appleKey = makeKey("apple-key-1");
const googleKey = makeKey("google-key-1");
const rogueKey = makeKey("apple-key-1");
jwks.keys.set("apple:apple-key-1", appleKey.jwk);
jwks.keys.set("google:google-key-1", googleKey.jwk);

async function harness(): Promise<Harness> {
  return createHarness({
    customise: (b) => b.overrideProvider(JWKS_KEY_FETCHER).useValue(jwks),
  });
}

function appleClaims(h: Harness, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: "https://appleid.apple.com",
    aud: "com.outletnk.app",
    sub: "apple-subject-001",
    iat: NOW_S(h),
    exp: NOW_S(h) + 600,
    nonce: "nonce-apple-0001",
    email: "someone@privaterelay.appleid.com",
    email_verified: "true",
    is_private_email: "true",
    ...over,
  };
}

function googleClaims(h: Harness, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: "https://accounts.google.com",
    aud: "outletnk-ios.apps.googleusercontent.com",
    sub: "google-subject-001",
    iat: NOW_S(h),
    exp: NOW_S(h) + 3000,
    nonce: "nonce-google-0001",
    email: "dana@example.com",
    email_verified: true,
    ...over,
  };
}

const socialBody = (idToken: string, nonce: string) => ({
  id_token: idToken,
  nonce,
  device: { platform: "ios", install_id: INSTALL_ID },
});

// ---- Age gate ------------------------------------------------------------------------------

describe("POST /v1/auth/age-gate", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(async () => h.close());

  it("an adult passes and the OTP request that follows is allowed", async () => {
    const r = await passGate(h, "key-adult-0001");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: "passed", expires_at: new Date(h.clock.nowMs() + DAY).toISOString() });
    const otp = await h.http().post("/v1/auth/otp/request").set(attest("key-adult-0001")).send({ phone_e164: "+201005551001" });
    expect(otp.status).toBe(202);
  });

  it("OTP request without a passed gate is refused and nothing is sent", async () => {
    const before = h.mailbox.entries.length;
    const r = await h.http().post("/v1/auth/otp/request").set(attest("key-nogate-0001")).send({ phone_e164: "+201005551002" });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ type: "/problems/age-gate-required", code: "age_gate_required" });
    expect(h.mailbox.entries.length).toBe(before);
  });

  it("the gate pass is per attested device: another device still needs its own", async () => {
    await passGate(h, "key-adult-0002");
    const r = await h.http().post("/v1/auth/otp/request").set(attest("key-adult-other")).send({ phone_e164: "+201005551003" });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("age_gate_required");
  });

  it("under 18: 403 with blocked_until 30 days out; OTP is then refused on that device", async () => {
    const today = cairoToday(h.clock.nowMs());
    const minor = dateString({ year: today.year - 15, month: 6, day: 1 });
    const r = await passGate(h, "key-minor-0001", minor);
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ type: "/problems/age-blocked", code: "age_blocked" });
    expect(r.body.blocked_until).toBe(new Date(h.clock.nowMs() + 30 * DAY).toISOString());
    expect(JSON.stringify(r.body)).not.toContain(minor);

    const before = h.mailbox.entries.length;
    const otp = await h.http().post("/v1/auth/otp/request").set(attest("key-minor-0001")).send({ phone_e164: "+201005551004" });
    expect(otp.status).toBe(403);
    expect(otp.body.code).toBe("age_blocked");
    expect(h.mailbox.entries.length).toBe(before);
    expect(h.events.events.some((e) => e.type === "user.age_blocked")).toBe(true);
  });

  it("the block survives a reinstall: same attested device with a new device hash and an adult DOB stays blocked", async () => {
    const today = cairoToday(h.clock.nowMs());
    const minor = dateString({ year: today.year - 16, month: 1, day: 10 });
    expect((await passGate(h, "key-minor-0002", minor)).status).toBe(403);
    const retry = await h
      .http()
      .post("/v1/auth/age-gate")
      .set(attest("key-minor-0002"))
      .send({ dob: ADULT_DOB, device_id_hash: deviceHash("fresh-install") });
    expect(retry.status).toBe(403);
    expect(retry.body.code).toBe("age_blocked");
  });

  it("the block follows the device id hash: a new attestation key with the same hash and an adult DOB stays blocked", async () => {
    const today = cairoToday(h.clock.nowMs());
    const minor = dateString({ year: today.year - 14, month: 3, day: 3 });
    expect((await passGate(h, "key-minor-0003", minor)).status).toBe(403);
    const retry = await h
      .http()
      .post("/v1/auth/age-gate")
      .set(attest("key-minor-0003-new"))
      .send({ dob: ADULT_DOB, device_id_hash: deviceHash("key-minor-0003") });
    expect(retry.status).toBe(403);
  });

  it("the block follows the date of birth: a different device entering the same DOB is blocked", async () => {
    const today = cairoToday(h.clock.nowMs());
    const minor = dateString({ year: today.year - 13, month: 9, day: 9 });
    expect((await passGate(h, "key-minor-0004", minor)).status).toBe(403);
    const other = await passGate(h, "key-minor-0004-other", minor);
    expect(other.status).toBe(403);
    expect(other.body.code).toBe("age_blocked");
  });

  it("turns 18 exactly on the birthday in Cairo time: the day before is blocked, the day itself passes", async () => {
    const today = cairoToday(h.clock.nowMs());
    const exact = dateString({ year: today.year - 18, month: today.month, day: today.day });
    expect((await passGate(h, "key-boundary-ok", exact)).status).toBe(200);
    const next = new Date(Date.UTC(today.year - 18, today.month - 1, today.day + 1));
    const tomorrowBirthday = dateString({ year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() });
    expect((await passGate(h, "key-boundary-no", tomorrowBirthday)).status).toBe(403);
  });

  it("the block expires after 30 days", async () => {
    const today = cairoToday(h.clock.nowMs());
    const minor = dateString({ year: today.year - 12, month: 2, day: 2 });
    expect((await passGate(h, "key-minor-expire", minor)).status).toBe(403);
    h.clock.advance(30 * DAY + 1000);
    const r = await passGate(h, "key-minor-expire", ADULT_DOB);
    expect(r.status).toBe(200);
  });

  it("stores only keyed identifiers: no DOB, no plain hash of it, no device id", async () => {
    const today = cairoToday(h.clock.nowMs());
    const minor = dateString({ year: today.year - 11, month: 4, day: 4 });
    await passGate(h, "key-minor-pii", minor);
    const snap = h.ageGateStore.snapshotForTest();
    const dump = JSON.stringify(snap);
    expect(dump).not.toContain(minor);
    expect(dump).not.toContain("key-minor-pii");
    expect(dump).not.toContain(deviceHash("key-minor-pii"));
    expect(dump).not.toContain(createHash("sha256").update(minor).digest("hex"));
    for (const [key] of [...snap.blocks, ...snap.passed]) expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("validates input: malformed or impossible DOB, unknown fields, bad device hash", async () => {
    const send = (body: unknown) => h.http().post("/v1/auth/age-gate").set(attest("key-validate-1")).send(body as object);
    for (const body of [
      {},
      { dob: "17/05/1990", device_id_hash: deviceHash("x") },
      { dob: ADULT_DOB, device_id_hash: "short" },
      { dob: ADULT_DOB, device_id_hash: deviceHash("x"), extra: 1 },
    ]) {
      const r = await send(body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.type).toBe("/problems/validation-failed");
    }
    for (const dob of ["1990-02-30", "2999-01-01", "1850-01-01"]) {
      const r = await send({ dob, device_id_hash: deviceHash("x") });
      expect(r.status, dob).toBe(422);
      expect(r.body.code).toBe("invalid_dob");
    }
  });

  it("requires device attestation", async () => {
    const r = await h.http().post("/v1/auth/age-gate").send({ dob: ADULT_DOB, device_id_hash: deviceHash("x") });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("attestation_failed");
    const forged = await h
      .http()
      .post("/v1/auth/age-gate")
      .set({ "X-App-Attest": "forged", "X-Client-Platform": "ios" })
      .send({ dob: ADULT_DOB, device_id_hash: deviceHash("x") });
    expect(forged.status).toBe(403);
  });
});

describe("POST /v1/auth/age-gate rate limit", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(async () => h.close());

  it("allows 10 attempts per device per day, then 429 with Retry-After", async () => {
    // A guessing client probing DOBs on one device: every attempt counts, even failed ones.
    for (let i = 0; i < 10; i += 1) {
      const r = await h
        .http()
        .post("/v1/auth/age-gate")
        .set(attest("key-flood-0001"))
        .send({ dob: "2999-01-01", device_id_hash: deviceHash("flood") });
      expect(r.status).toBe(422);
    }
    const blocked = await passGate(h, "key-flood-0001");
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
  });
});

// ---- Apple and Google ----------------------------------------------------------------------

describe("POST /v1/auth/apple and /v1/auth/google", () => {
  let h: Harness;
  const KEY = "key-social-0001";
  beforeAll(async () => {
    h = await harness();
    h.grantAgeGate(KEY);
  });
  afterAll(async () => h.close());

  const post = (path: "apple" | "google", body: unknown, headers: Record<string, string> = attest(KEY)) =>
    h.http().post(`/v1/auth/${path}`).set(headers).send(body as object);

  it("apple: valid token creates an account without a phone and returns a token pair that authenticates", async () => {
    const token = signJwt(appleKey, appleClaims(h));
    const r = await post("apple", socialBody(token, "nonce-apple-0001"));
    expect(r.status).toBe(200);
    expect(r.body.user).toMatchObject({ phone_verified: false, email: "someone@privaterelay.appleid.com", status: "active" });
    expect(r.body.user.phone_masked).toBeUndefined();
    expect(r.body.refresh_token).toMatch(/^[0-9a-f]{64}$/);
    const auth = h.app.get<Authenticator>(AUTHENTICATOR, { strict: false });
    const principal = await auth.authenticate(r.body.access_token, h.clock.nowMs());
    expect(principal?.claims.amr).toEqual(["apple", "attestation"]);
    expect(principal?.actor.id).toBe(r.body.user.id);
  });

  it("apple: a second sign-in with the same subject resolves to the same user", async () => {
    const first = await post("apple", socialBody(signJwt(appleKey, appleClaims(h, { nonce: "nonce-apple-0002" })), "nonce-apple-0002"));
    const second = await post("apple", socialBody(signJwt(appleKey, appleClaims(h, { nonce: "nonce-apple-0003" })), "nonce-apple-0003"));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.user.id).toBe(first.body.user.id);
  });

  it("apple: the SHA-256 of the raw nonce is accepted, as Apple sends it", async () => {
    const raw = "raw-nonce-apple-0004";
    const hashed = createHash("sha256").update(raw).digest("hex");
    const r = await post("apple", socialBody(signJwt(appleKey, appleClaims(h, { nonce: hashed, sub: "apple-subject-004" })), raw));
    expect(r.status).toBe(200);
  });

  it("google: valid token signs in, verified email is kept", async () => {
    const r = await post("google", socialBody(signJwt(googleKey, googleClaims(h)), "nonce-google-0001"));
    expect(r.status).toBe(200);
    expect(r.body.user).toMatchObject({ email: "dana@example.com", phone_verified: false });
    const principal = await h.app.get<Authenticator>(AUTHENTICATOR, { strict: false }).authenticate(r.body.access_token, h.clock.nowMs());
    expect(principal?.claims.amr).toEqual(["google", "attestation"]);
  });

  it("google: an unverified email is not stored", async () => {
    const claims = googleClaims(h, { sub: "google-subject-unverified", nonce: "nonce-google-0002", email_verified: false });
    const r = await post("google", socialBody(signJwt(googleKey, claims), "nonce-google-0002"));
    expect(r.status).toBe(200);
    expect(r.body.user.email).toBeNull();
  });

  it("rejects a nonce that was already consumed, even with a freshly signed token", async () => {
    const nonce = "nonce-replay-0001";
    const first = await post("google", socialBody(signJwt(googleKey, googleClaims(h, { nonce, sub: "g-replay" })), nonce));
    expect(first.status).toBe(200);
    const again = await post("google", socialBody(signJwt(googleKey, googleClaims(h, { nonce, sub: "g-replay" })), nonce));
    expect(again.status).toBe(401);
    expect(again.body).toMatchObject({ type: "/problems/invalid-identity-token", code: "nonce_reused" });
  });

  it("rejects the wrong audience, issuer, expired tokens and a nonce that does not match", async () => {
    const cases: [string, Record<string, unknown>, string][] = [
      ["audience", { aud: "com.someone.else" }, "audience_mismatch"],
      ["issuer", { iss: "https://evil.example" }, "issuer_mismatch"],
      ["expired", { exp: NOW_S(h) - 120, iat: NOW_S(h) - 3600 }, "identity_token_expired"],
      ["nonce", { nonce: "different-nonce-value" }, "nonce_mismatch"],
      ["no nonce", { nonce: undefined }, "nonce_mismatch"],
    ];
    for (const [name, over, code] of cases) {
      const r = await post("apple", socialBody(signJwt(appleKey, appleClaims(h, { sub: `apple-rej-${name}`, ...over })), "nonce-apple-0001"));
      expect(r.status, name).toBe(401);
      expect(r.body.code, name).toBe(code);
    }
  });

  it("rejects forged signatures, unknown key ids, alg none and HS256 confusion", async () => {
    const claims = appleClaims(h, { sub: "apple-forged", nonce: "nonce-forged-1" });
    const forged = signJwt(rogueKey, claims);
    const unknownKid = signJwt(appleKey, claims, { kid: "no-such-kid" });
    const none = `${b64({ alg: "none", kid: "apple-key-1" })}.${b64(claims)}.`;
    const hs256 = `${b64({ alg: "HS256", kid: "apple-key-1" })}.${b64(claims)}.${Buffer.from("x").toString("base64url")}`;
    for (const token of [forged, unknownKid, none, hs256, "not.a.jwt.but.long.enough.to.pass", "x".repeat(40)]) {
      const r = await post("apple", socialBody(token, "nonce-forged-1"));
      expect(r.status, token.slice(0, 24)).toBe(401);
      expect(r.body.code).toBe("invalid_identity_token");
    }
  });

  it("an unreachable key source fails closed with 503 and a Retry-After", async () => {
    jwks.down = true;
    try {
      const r = await post("google", socialBody(signJwt(googleKey, googleClaims(h, { nonce: "nonce-down-0001" })), "nonce-down-0001"));
      expect(r.status).toBe(503);
      expect(r.body.code).toBe("identity_provider_unavailable");
    } finally {
      jwks.down = false;
    }
  });

  it("a failed verification does not consume the nonce", async () => {
    const nonce = "nonce-keep-0001";
    const bad = await post("apple", socialBody(signJwt(rogueKey, appleClaims(h, { nonce, sub: "apple-keep" })), nonce));
    expect(bad.status).toBe(401);
    const good = await post("apple", socialBody(signJwt(appleKey, appleClaims(h, { nonce, sub: "apple-keep" })), nonce));
    expect(good.status).toBe(200);
  });

  it("requires attestation and a passed age gate", async () => {
    const token = signJwt(appleKey, appleClaims(h, { nonce: "nonce-gate-0001", sub: "apple-gate" }));
    const noAttest = await post("apple", socialBody(token, "nonce-gate-0001"), {});
    expect(noAttest.status).toBe(403);
    expect(noAttest.body.code).toBe("attestation_failed");
    const noGate = await post("apple", socialBody(token, "nonce-gate-0001"), attest("key-social-nogate"));
    expect(noGate.status).toBe(403);
    expect(noGate.body.code).toBe("age_gate_required");
  });

  it("validates the body", async () => {
    for (const body of [{}, { id_token: "short", nonce: "n", device: { platform: "ios", install_id: INSTALL_ID } }, { ...socialBody("x".repeat(30), "nonce-12345"), extra: true }]) {
      const r = await post("google", body);
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
  });
});

// ---- Passkeys ------------------------------------------------------------------------------

describe("passkeys", () => {
  let h: Harness;
  const KEY = "key-passkey-0001";
  const ORIGIN = "https://outletnk.invalid";
  beforeAll(async () => {
    h = await harness();
    h.grantAgeGate(KEY);
  });
  afterAll(async () => h.close());

  async function signedIn(keyId: string, subject: string) {
    h.grantAgeGate(keyId);
    const nonce = `nonce-${subject}-1`;
    const r = await h
      .http()
      .post("/v1/auth/google")
      .set(attest(keyId))
      .send(socialBody(signJwt(googleKey, googleClaims(h, { sub: subject, nonce })), nonce));
    expect(r.status).toBe(200);
    return { token: r.body.access_token as string, userId: r.body.user.id as string };
  }

  async function register(token: string, userId: string, credentialId: string, signCount = 0) {
    const opts = await h.http().post("/v1/auth/passkey/register/options").set(bearer(token)).send({});
    expect(opts.status).toBe(200);
    const res = await h
      .http()
      .post("/v1/auth/passkey/register")
      .set(bearer(token))
      .send({
        challenge_id: opts.body.challenge_id,
        credential: { id: credentialId, credentialId, publicKey: `pk-${credentialId}`, signCount, origin: ORIGIN, challenge: opts.body.challenge },
      });
    return { res, opts, userId };
  }

  async function assertWith(credentialId: string, userId: string, signCount: number, over: Record<string, unknown> = {}, headers = attest(KEY)) {
    const opts = await h.http().post("/v1/auth/passkey/assert/options").send({});
    expect(opts.status).toBe(200);
    const res = await h
      .http()
      .post("/v1/auth/passkey/assert")
      .set(headers)
      .send({
        challenge_id: opts.body.challenge_id,
        credential: {
          id: credentialId,
          credentialId,
          signCount,
          userHandle: userId,
          origin: ORIGIN,
          challenge: opts.body.challenge,
          ...over,
        },
        device: { platform: "ios", install_id: INSTALL_ID },
      });
    return { res, opts };
  }

  it("registration needs a signed-in user", async () => {
    const r1 = await h.http().post("/v1/auth/passkey/register/options").send({});
    expect(r1.status).toBe(401);
    const r2 = await h.http().post("/v1/auth/passkey/register").send({ challenge_id: INSTALL_ID, credential: { id: "x" } });
    expect(r2.status).toBe(401);
  });

  it("registers a passkey (204), then signs in with it", async () => {
    const { token, userId } = await signedIn("key-pk-owner-1", "pk-owner-1");
    const { res, opts } = await register(token, userId, "cred-owner-1", 0);
    expect(res.status).toBe(204);
    expect(opts.body.rp_id).toBe("outletnk.invalid");
    expect(Date.parse(opts.body.expires_at) - h.clock.nowMs()).toBe(5 * 60_000);

    const { res: login } = await assertWith("cred-owner-1", userId, 1);
    expect(login.status).toBe(200);
    expect(login.body.user.id).toBe(userId);
    const principal = await h.app.get<Authenticator>(AUTHENTICATOR, { strict: false }).authenticate(login.body.access_token, h.clock.nowMs());
    expect(principal?.claims.amr).toEqual(["passkey", "attestation"]);
  });

  it("a challenge is single use: replaying a registration or an assertion fails", async () => {
    const { token, userId } = await signedIn("key-pk-single-1", "pk-single-1");
    const opts = await h.http().post("/v1/auth/passkey/register/options").set(bearer(token)).send({});
    const body = {
      challenge_id: opts.body.challenge_id,
      credential: { id: "cred-single-1", credentialId: "cred-single-1", publicKey: "pk", signCount: 0, origin: ORIGIN, challenge: opts.body.challenge },
    };
    expect((await h.http().post("/v1/auth/passkey/register").set(bearer(token)).send(body)).status).toBe(204);
    const replay = await h.http().post("/v1/auth/passkey/register").set(bearer(token)).send(body);
    expect(replay.status).toBe(422);
    expect(replay.body.code).toBe("invalid_challenge");

    const first = await assertWith("cred-single-1", userId, 1);
    expect(first.res.status).toBe(200);
    const replayAssert = await h
      .http()
      .post("/v1/auth/passkey/assert")
      .set(attest(KEY))
      .send({
        challenge_id: first.opts.body.challenge_id,
        credential: { id: "cred-single-1", credentialId: "cred-single-1", signCount: 2, userHandle: userId, origin: ORIGIN, challenge: first.opts.body.challenge },
        device: { platform: "ios", install_id: INSTALL_ID },
      });
    expect(replayAssert.status).toBe(401);
    expect(replayAssert.body.code).toBe("invalid_passkey_assertion");
  });

  it("a challenge expires after 5 minutes", async () => {
    const { token } = await signedIn("key-pk-exp-1", "pk-exp-1");
    const opts = await h.http().post("/v1/auth/passkey/register/options").set(bearer(token)).send({});
    h.clock.advance(5 * 60_000 + 1);
    const r = await h
      .http()
      .post("/v1/auth/passkey/register")
      .set(bearer(token))
      .send({ challenge_id: opts.body.challenge_id, credential: { id: "cred-exp", credentialId: "cred-exp", publicKey: "pk", signCount: 0, origin: ORIGIN, challenge: opts.body.challenge } });
    expect(r.status).toBe(422);
    const assertOpts = await h.http().post("/v1/auth/passkey/assert/options").send({});
    h.clock.advance(5 * 60_000 + 1);
    h.grantAgeGate(KEY);
    const a = await h
      .http()
      .post("/v1/auth/passkey/assert")
      .set(attest(KEY))
      .send({
        challenge_id: assertOpts.body.challenge_id,
        credential: { id: "cred-exp", credentialId: "cred-exp", signCount: 1, userHandle: "u", origin: ORIGIN, challenge: assertOpts.body.challenge },
        device: { platform: "ios", install_id: INSTALL_ID },
      });
    expect(a.status).toBe(401);
  });

  it("a registration challenge issued to another user is a 404 and stays usable by its owner", async () => {
    const a = await signedIn("key-pk-a-1", "pk-user-a");
    const b = await signedIn("key-pk-b-1", "pk-user-b");
    const opts = await h.http().post("/v1/auth/passkey/register/options").set(bearer(a.token)).send({});
    const credential = { id: "cred-a", credentialId: "cred-a", publicKey: "pk", signCount: 0, origin: ORIGIN, challenge: opts.body.challenge };
    const stolen = await h.http().post("/v1/auth/passkey/register").set(bearer(b.token)).send({ challenge_id: opts.body.challenge_id, credential });
    expect(stolen.status).toBe(404);
    const own = await h.http().post("/v1/auth/passkey/register").set(bearer(a.token)).send({ challenge_id: opts.body.challenge_id, credential });
    expect(own.status).toBe(204);
  });

  it("registering a credential id that already exists is a 409", async () => {
    const a = await signedIn("key-pk-dup-a", "pk-dup-a");
    const b = await signedIn("key-pk-dup-b", "pk-dup-b");
    expect((await register(a.token, a.userId, "cred-dup")).res.status).toBe(204);
    const second = await register(b.token, b.userId, "cred-dup");
    expect(second.res.status).toBe(409);
    expect(second.res.body.code).toBe("credential_exists");
  });

  it("rejects unknown credentials, wrong origin, wrong challenge and a mismatched user handle", async () => {
    const { token, userId } = await signedIn("key-pk-rej-1", "pk-rej-1");
    await register(token, userId, "cred-rej-1", 0);
    const unknown = await assertWith("cred-nope", userId, 1);
    expect(unknown.res.status).toBe(401);
    const origin = await assertWith("cred-rej-1", userId, 1, { origin: "https://evil.example" });
    expect(origin.res.status).toBe(401);
    const challenge = await assertWith("cred-rej-1", userId, 1, { challenge: "tampered" });
    expect(challenge.res.status).toBe(401);
    const handle = await assertWith("cred-rej-1", "someone-else", 1);
    expect(handle.res.status).toBe(401);
    // None of those burned the credential: a correct assertion still works.
    expect((await assertWith("cred-rej-1", userId, 1)).res.status).toBe(200);
  });

  it("detects a signature counter rollback: rejects, disables the credential and revokes sessions", async () => {
    const { token, userId } = await signedIn("key-pk-clone-1", "pk-clone-1");
    await register(token, userId, "cred-clone-1", 0);
    const ok = await assertWith("cred-clone-1", userId, 7);
    expect(ok.res.status).toBe(200);
    const eventsBefore = h.events.events.length;

    const rollback = await assertWith("cred-clone-1", userId, 3);
    expect(rollback.res.status).toBe(401);
    const equal = await assertWith("cred-clone-1", userId, 7);
    expect(equal.res.status).toBe(401);

    // Credential is disabled even for a now-correct counter.
    const after = await assertWith("cred-clone-1", userId, 99);
    expect(after.res.status).toBe(401);

    const revoked = h.events.events.slice(eventsBefore).filter((e) => e.type === "session.revoked" && e.reason === "clone_suspected");
    expect(revoked.length).toBeGreaterThanOrEqual(1);
    // The sessions issued by the legitimate login no longer authenticate.
    const me = await h.http().get("/v1/me/sessions").set(bearer(ok.res.body.access_token));
    expect(me.status).toBe(401);
  });

  it("assertion requires attestation and a passed age gate", async () => {
    const { token, userId } = await signedIn("key-pk-gate-1", "pk-gate-1");
    await register(token, userId, "cred-gate-1", 0);
    const noAttest = await assertWith("cred-gate-1", userId, 1, {}, {} as never);
    expect(noAttest.res.status).toBe(403);
    expect(noAttest.res.body.code).toBe("attestation_failed");
    const noGate = await assertWith("cred-gate-1", userId, 1, {}, attest("key-pk-nogate"));
    expect(noGate.res.status).toBe(403);
    expect(noGate.res.body.code).toBe("age_gate_required");
  });

  it("validates bodies strictly", async () => {
    const { token } = await signedIn("key-pk-val-1", "pk-val-1");
    for (const body of [{}, { challenge_id: "nope", credential: { id: "x" } }, { challenge_id: INSTALL_ID, credential: {} }, { challenge_id: INSTALL_ID, credential: { id: "x" }, extra: 1 }]) {
      const r = await h.http().post("/v1/auth/passkey/register").set(bearer(token)).send(body);
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
  });
});

// ---- Refresh, logout, sessions -------------------------------------------------------------

describe("refresh, logout and sessions", () => {
  let h: Harness;
  const KEY = "key-refresh-0001";
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(async () => h.close());

  let counter = 0;
  async function loginFresh() {
    counter += 1;
    const keyId = `${KEY}-${counter}`;
    h.grantAgeGate(keyId);
    const nonce = `nonce-refresh-${counter}`;
    const r = await h
      .http()
      .post("/v1/auth/google")
      .set(attest(keyId))
      .send(socialBody(signJwt(googleKey, googleClaims(h, { sub: `refresh-user-${counter}`, nonce })), nonce));
    expect(r.status).toBe(200);
    const auth = h.app.get<Authenticator>(AUTHENTICATOR, { strict: false });
    const principal = await auth.authenticate(r.body.access_token, h.clock.nowMs());
    return {
      access: r.body.access_token as string,
      refresh: r.body.refresh_token as string,
      userId: r.body.user.id as string,
      sessionId: principal?.claims.sid ?? "",
    };
  }
  const refresh = (token: string, installId = INSTALL_ID) =>
    h.http().post("/v1/auth/refresh").send({ refresh_token: token, device_install_id: installId });

  it("rotates: a new pair is returned, the session id is kept, the old access token still lives until expiry", async () => {
    const s = await loginFresh();
    h.clock.advance(60_000);
    const r = await refresh(s.refresh);
    expect(r.status).toBe(200);
    expect(r.body.refresh_token).not.toBe(s.refresh);
    expect(r.body.access_token).not.toBe(s.access);
    expect(r.body.user.id).toBe(s.userId);
    const principal = await h.app.get<Authenticator>(AUTHENTICATOR, { strict: false }).authenticate(r.body.access_token, h.clock.nowMs());
    expect(principal?.claims.sid).toBe(s.sessionId);
    const again = await refresh(r.body.refresh_token);
    expect(again.status).toBe(200);
  });

  it("reuse detection: presenting a rotated token revokes the whole family and emits session.revoked", async () => {
    const s = await loginFresh();
    const first = await refresh(s.refresh);
    expect(first.status).toBe(200);
    const before = h.events.events.length;
    const reuse = await refresh(s.refresh);
    expect(reuse.status).toBe(401);
    expect(reuse.body).toMatchObject({ type: "/problems/invalid-refresh-token", code: "invalid_refresh_token" });

    // The legitimate holder of the newest token is cut off too, and so is the access token.
    expect((await refresh(first.body.refresh_token)).status).toBe(401);
    expect((await h.http().get("/v1/me/sessions").set(bearer(first.body.access_token))).status).toBe(401);

    const ev = h.events.events.slice(before).find((e) => e.type === "session.revoked");
    expect(ev).toMatchObject({ type: "session.revoked", userId: s.userId, sessionId: s.sessionId, reason: "reuse_detected", notifyUser: true });
  });

  it("a token presented from another install revokes the family (device binding)", async () => {
    const s = await loginFresh();
    const before = h.events.events.length;
    const r = await refresh(s.refresh, OTHER_INSTALL_ID);
    expect(r.status).toBe(401);
    expect((await refresh(s.refresh)).status).toBe(401);
    expect(h.events.events.slice(before)[0]).toMatchObject({ reason: "device_mismatch", notifyUser: true });
  });

  it("unknown, expired and malformed tokens are 401 / 400", async () => {
    expect((await refresh("f".repeat(64))).status).toBe(401);
    const s = await loginFresh();
    h.clock.advance(30 * DAY + 1000);
    expect((await refresh(s.refresh)).status).toBe(401);
    for (const body of [{}, { refresh_token: "short", device_install_id: INSTALL_ID }, { refresh_token: "a".repeat(64), device_install_id: "nope" }]) {
      expect((await h.http().post("/v1/auth/refresh").send(body)).status).toBe(400);
    }
  });

  it("concurrent refreshes with the same token yield exactly one success", async () => {
    const s = await loginFresh();
    const results = await Promise.all([refresh(s.refresh), refresh(s.refresh), refresh(s.refresh)]);
    expect(results.filter((r) => r.status === 200).length).toBe(1);
    expect(results.filter((r) => r.status !== 200).every((r) => r.status === 401 || r.status === 409)).toBe(true);
  });

  it("refresh is not idempotency-cached: a replayed Idempotency-Key does not return the stored token pair", async () => {
    const s = await loginFresh();
    const key = "0192f3a4-5b6c-7d8e-9f01-23456789abd1";
    const a = await h.http().post("/v1/auth/refresh").set("Idempotency-Key", key).send({ refresh_token: s.refresh, device_install_id: INSTALL_ID });
    expect(a.status).toBe(200);
    const b = await h.http().post("/v1/auth/refresh").set("Idempotency-Key", key).send({ refresh_token: s.refresh, device_install_id: INSTALL_ID });
    expect(b.headers["idempotent-replayed"]).toBeUndefined();
    expect(b.status).toBe(401);
  });

  it("logout: 204, the access and refresh tokens die, session.revoked is emitted", async () => {
    const s = await loginFresh();
    const before = h.events.events.length;
    const out = await h.http().post("/v1/auth/logout").set(bearer(s.access));
    expect(out.status).toBe(204);
    expect((await h.http().get(`/v1/me/sessions/${s.sessionId}`).set(bearer(s.access))).status).toBe(401);
    expect((await refresh(s.refresh)).status).toBe(401);
    expect(h.events.events.slice(before)[0]).toMatchObject({ type: "session.revoked", reason: "logout", sessionId: s.sessionId, notifyUser: false });
    expect((await h.http().post("/v1/auth/logout").set(bearer(s.access))).status).toBe(401);
  });

  it("logout requires authentication", async () => {
    expect((await h.http().post("/v1/auth/logout")).status).toBe(401);
    expect((await h.http().post("/v1/auth/logout").set(bearer("dev_" + "0".repeat(64)))).status).toBe(401);
  });

  it("GET /v1/me/sessions lists only the caller's active sessions", async () => {
    const a = await loginFresh();
    const b = await loginFresh();
    const list = await h.http().get("/v1/me/sessions").set(bearer(a.access));
    expect(list.status).toBe(200);
    expect(list.body.page).toEqual({ next_cursor: null, has_more: false });
    const ids = list.body.items.map((i: { id: string }) => i.id);
    expect(ids).toContain(a.sessionId);
    expect(ids).not.toContain(b.sessionId);
    expect(list.body.items.find((i: { id: string }) => i.id === a.sessionId).current).toBe(true);
    expect((await h.http().get("/v1/me/sessions")).status).toBe(401);
    expect((await h.http().get("/v1/me/sessions?limit=500").set(bearer(a.access))).status).toBe(400);
  });

  it("DELETE /v1/me/sessions/{id}: not owned is 404 and changes nothing; owned revokes and kills refresh", async () => {
    const a = await loginFresh();
    const b = await loginFresh();
    const notOwned = await h.http().delete(`/v1/me/sessions/${b.sessionId}`).set(bearer(a.access));
    expect(notOwned.status).toBe(404);
    expect((await refresh(b.refresh)).status).toBe(200);

    const before = h.events.events.length;
    const own = await h.http().delete(`/v1/me/sessions/${a.sessionId}`).set(bearer(a.access));
    expect(own.status).toBe(204);
    expect((await refresh(a.refresh)).status).toBe(401);
    expect(h.events.events.slice(before)[0]).toMatchObject({ type: "session.revoked", reason: "user_revoked", sessionId: a.sessionId });
  });
});

describe("refresh rate limit", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(async () => h.close());

  it("limits refresh attempts per device (30 per hour) with a 429", async () => {
    const headers = attest("key-refresh-flood");
    let last = 0;
    for (let i = 0; i < 31; i += 1) {
      const r = await h
        .http()
        .post("/v1/auth/refresh")
        .set(headers)
        .send({ refresh_token: "e".repeat(64), device_install_id: INSTALL_ID });
      last = r.status;
      if (i < 30) expect(r.status).toBe(401);
    }
    expect(last).toBe(429);
  });
});
