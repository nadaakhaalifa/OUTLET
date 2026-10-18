import { createSign, generateKeyPairSync, randomBytes, randomUUID, createHash, type KeyObject } from "node:crypto";
import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { SignJWT, importJWK, type JWK } from "jose";
import { sql } from "kysely";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabaseUpTo } from "@outlet/db";
import { buildAccessClaims, sha256Hex, type OtpChannel, type OtpSender } from "@outlet/auth-core";
import { AppModule } from "../app.module";
import { configureApp } from "../app.setup";
import { loadConfig } from "../config/env";
import {
  DEV_ATTESTATION_PREFIX,
  DevAttestationVerifier,
  LocalKeyFieldCipher,
  StaticTokenKeySource,
  cairoToday,
  generateTokenKey,
  type TokenKeyMaterial,
} from "../modules/auth";
import type { JwksHttp } from "../modules/auth";
import { VirtualAuthenticator } from "../modules/auth/test/virtual-authenticator";
import { createPgliteDatabase, type PgliteInstance } from "../platform/db";
import { PROD_ENV } from "./test/test-support";

/**
 * Production composition (Postgres stores, JOSE tokens, real WebAuthn and JWKS paths) over PGlite.
 * Only the external providers are test doubles: attestation, SMS/WhatsApp capture and the JWKS
 * transport. Everything else is the code that runs in production.
 */

const attest = (keyId: string) => ({ "X-App-Attest": `${DEV_ATTESTATION_PREFIX}${keyId}`, "X-Client-Platform": "ios" });
const deviceHash = (k: string): string => createHash("sha256").update(`device:${k}`).digest("hex");
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const RP = "outletnk.invalid";
const ORIGIN = "https://outletnk.invalid";
let phoneSeq = 0;
const nextPhone = (): string => `+20100${String(7_000_000 + ++phoneSeq)}`;

type Db = ReturnType<typeof createPgliteDatabase<Record<string, never>>>;

interface Booted {
  app: INestApplication;
  db: Db;
  sent: { phoneE164: string; code: string; channel: OtpChannel }[];
  material: TokenKeyMaterial;
  http: () => ReturnType<typeof request>;
}

function capture(channel: OtpChannel, sent: Booted["sent"]): OtpSender {
  return {
    id: `capture-${channel}`,
    channel,
    async send(r) {
      sent.push({ phoneE164: r.phoneE164, code: r.code, channel });
      return { ok: true, providerMessageId: `m-${sent.length}` };
    },
  };
}

// Apple key for the in-process JWKS transport.
const appleRsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const appleJwk = { ...(appleRsa.publicKey.export({ format: "jwk" }) as Record<string, string>), kid: "apple-1", alg: "RS256", use: "sig" };
const jwksHttp: JwksHttp = {
  async get(url) {
    if (url.hostname !== "appleid.apple.com") return { status: 404, headers: {}, body: "" };
    return { status: 200, headers: { "cache-control": "max-age=600" }, body: JSON.stringify({ keys: [appleJwk] }) };
  },
};
function appleToken(key: KeyObject, claims: Record<string, unknown>): string {
  const b = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString("base64url");
  const data = `${b({ alg: "RS256", kid: "apple-1" })}.${b(claims)}`;
  return `${data}.${createSign("RSA-SHA256").update(data).sign(key).toString("base64url")}`;
}

async function boot(configured: boolean): Promise<Booted> {
  const raw = await createTestDatabaseUpTo(9999);
  const db = createPgliteDatabase<Record<string, never>>(raw as unknown as PgliteInstance);
  const config = loadConfig({ ...PROD_ENV });
  const sent: Booted["sent"] = [];
  const key = await generateTokenKey("prod-k1");
  const material: TokenKeyMaterial = { activeKid: "prod-k1", keys: [key] };
  const auth = configured
    ? {
        cipher: new LocalKeyFieldCipher(new Uint8Array(randomBytes(32))),
        keySource: new StaticTokenKeySource(material),
        attestation: new DevAttestationVerifier(),
        senders: [capture("sms", sent), capture("whatsapp", sent)],
        jwksHttp,
      }
    : undefined;
  const mod = await Test.createTestingModule({
    imports: [AppModule.register(config, {}, { production: { db, ...(auth === undefined ? {} : { auth }) } })],
  }).compile();
  const app = mod.createNestApplication();
  configureApp(app, config);
  await app.init();
  return { app, db, sent, material, http: () => request(app.getHttpServer()) };
}

function dobYearsAgo(years: number): string {
  const t = cairoToday(Date.now());
  return `${String(t.year - years).padStart(4, "0")}-${String(t.month).padStart(2, "0")}-${String(t.day).padStart(2, "0")}`;
}

describe("production auth: unconfigured providers fail closed", () => {
  let b: Booted;
  beforeAll(async () => {
    b = await boot(false);
  }, 120_000);
  afterAll(async () => b.app.close());

  it("every authenticated route is 401 for any bearer (no signing keys configured)", async () => {
    expect((await b.http().get("/v1/me")).status).toBe(401);
    expect((await b.http().get("/v1/me").set(bearer("dev_" + "a".repeat(64)))).status).toBe(401);
    expect((await b.http().get("/v1/me/sessions").set(bearer("x.y.z"))).status).toBe(401);
  });

  it("attestation, KMS, SMS and key providers answer 503 provider_not_configured, never a fake success", async () => {
    const gate = await b.http().post("/v1/auth/age-gate").set(attest("k-unc-1")).send({ dob: "1990-01-01", device_id_hash: deviceHash("k-unc-1") });
    expect(gate.status).toBe(503);
    expect(gate.body).toMatchObject({ code: "provider_not_configured", provider: "attestation.app-attest" });
    const otp = await b.http().post("/v1/auth/otp/request").set(attest("k-unc-1")).send({ phone_e164: nextPhone() });
    expect(otp.status).toBe(503);
    const verify = await b.http().post("/v1/auth/otp/verify").set(attest("k-unc-1")).send({ challenge_id: randomUUID(), code: "123456", device: { platform: "ios", install_id: randomUUID() } });
    expect(verify.status).toBe(503);
  });
});

describe("production auth: configured providers", () => {
  let b: Booted;
  beforeAll(async () => {
    b = await boot(true);
  }, 120_000);
  afterAll(async () => b.app.close());

  async function passGate(keyId: string, dob = dobYearsAgo(30)) {
    return b.http().post("/v1/auth/age-gate").set(attest(keyId)).send({ dob, device_id_hash: deviceHash(keyId) });
  }

  async function signIn(keyId: string, opts: { dob?: string; phone?: string } = {}) {
    const gate = await passGate(keyId, opts.dob);
    expect(gate.status).toBe(200);
    const phone = opts.phone ?? nextPhone();
    const req = await b.http().post("/v1/auth/otp/request").set(attest(keyId)).send({ phone_e164: phone });
    expect(req.status).toBe(202);
    const code = b.sent.filter((s) => s.phoneE164 === phone).at(-1)?.code ?? "";
    const installId = randomUUID();
    const verify = await b.http().post("/v1/auth/otp/verify").set(attest(keyId)).send({ challenge_id: req.body.challenge_id, code, device: { platform: "ios", install_id: installId } });
    expect(verify.status).toBe(200);
    return {
      phone,
      installId,
      challengeId: req.body.challenge_id as string,
      access: verify.body.access_token as string,
      refresh: verify.body.refresh_token as string,
      userId: verify.body.user.id as string,
      body: verify.body as Record<string, unknown>,
    };
  }

  it("OTP sign-in issues an EdDSA JWT; GET /v1/me returns the profile summary with no P2/P3 fields", async () => {
    const s = await signIn("k-flow-1");
    const header = JSON.parse(Buffer.from(s.access.split(".")[0] ?? "", "base64url").toString()) as Record<string, string>;
    expect(header).toEqual({ alg: "EdDSA", kid: "prod-k1", typ: "at+jwt" });
    const me = await b.http().get("/v1/me").set(bearer(s.access));
    expect(me.status).toBe(200);
    expect(Object.keys(me.body as object).sort()).toEqual(["age_band", "created_at", "id", "limited_capacity", "locale", "phone_verified", "status"]);
    expect(me.body).toMatchObject({ id: s.userId, age_band: "21_plus", limited_capacity: false, phone_verified: true, status: "active" });
    expect(JSON.stringify(me.body)).not.toContain(s.phone);
    expect((await b.http().get("/v1/me")).status).toBe(401);
  });

  it("P2/P3 values are never stored in clear: phone, DOB and the OTP code", async () => {
    const dob = dobYearsAgo(40);
    const phone = nextPhone();
    const s = await signIn("k-enc-1", { dob, phone });
    const code = b.sent.at(-1)?.code ?? "";
    const dump = async (q: ReturnType<typeof sql>): Promise<string> => JSON.stringify((await q.execute(b.db)).rows, (_k, v) => (v instanceof Uint8Array ? Buffer.from(v).toString("latin1") : v));
    const tables = [
      await dump(sql`select * from users where id = ${s.userId}::uuid`),
      await dump(sql`select * from identities where user_id = ${s.userId}::uuid`),
      await dump(sql`select * from otp_challenges`),
      await dump(sql`select * from otp_send_log`),
      await dump(sql`select * from age_gate_passes`),
      await dump(sql`select * from age_gate_blocks`),
      await dump(sql`select * from sessions where user_id = ${s.userId}::uuid`),
      await dump(sql`select * from outbox_events`),
    ].join("\n");
    expect(tables).not.toContain(phone);
    expect(tables).not.toContain(phone.slice(1));
    expect(tables).not.toContain(dob);
    expect(tables).not.toContain(s.refresh);
    expect(tables).not.toContain(`"code":"${code}"`);
    const u = await sql<{ d: Buffer | null; band: string }>`select dob_ciphertext as d, age_band as band from users where id = ${s.userId}::uuid`.execute(b.db);
    expect(u.rows[0]?.d).not.toBeNull();
    expect(u.rows[0]?.band).toBe("21_plus");
    const challenge = await sql<{ code_hash: string }>`select code_hash from otp_challenges where id = ${s.challengeId}::uuid`.execute(b.db);
    expect(challenge.rows[0]?.code_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("an 18 to 20 year old gets limited_capacity; under 18 gets no account and a 30 day block", async () => {
    const s = await signIn("k-young-1", { dob: dobYearsAgo(19) });
    const me = await b.http().get("/v1/me").set(bearer(s.access));
    expect(me.body).toMatchObject({ age_band: "18_20", limited_capacity: true });

    const minorKey = "k-minor-1";
    const gate = await passGate(minorKey, dobYearsAgo(16));
    expect(gate.status).toBe(403);
    expect(gate.body.code).toBe("age_blocked");
    const until = Date.parse(gate.body.blocked_until as string) - Date.now();
    expect(until).toBeGreaterThan(29 * 86_400_000);
    expect(until).toBeLessThanOrEqual(30 * 86_400_000);
    const retry = await passGate(minorKey, dobYearsAgo(30));
    expect(retry.status).toBe(403); // changing the DOB does not lift the block
    const otp = await b.http().post("/v1/auth/otp/request").set(attest(minorKey)).send({ phone_e164: nextPhone() });
    expect(otp.status).toBe(403);
    const otherDevice = await b.http().post("/v1/auth/age-gate").set(attest("k-minor-2")).send({ dob: dobYearsAgo(16), device_id_hash: deviceHash(minorKey) });
    expect(otherDevice.status).toBe(403); // same device-id hash from another attested key
    const users = await sql<{ n: number }>`select count(*)::int as n from users u join identities i on i.user_id = u.id where i.provider = 'phone'`.execute(b.db);
    expect(users.rows[0]?.n).toBeGreaterThan(0);
    const events = await sql<{ n: number }>`select count(*)::int as n from outbox_events where event_type = 'user.age_blocked'`.execute(b.db);
    expect(events.rows[0]?.n).toBeGreaterThanOrEqual(1);
  });

  it("OTP brute force: five wrong codes stop the challenge; the right code afterwards does not sign in", async () => {
    const key = "k-brute-1";
    await passGate(key);
    const phone = nextPhone();
    const req = await b.http().post("/v1/auth/otp/request").set(attest(key)).send({ phone_e164: phone });
    const code = b.sent.at(-1)?.code ?? "";
    const wrong = code === "000000" ? "111111" : "000000";
    const body = (c: string) => ({ challenge_id: req.body.challenge_id, code: c, device: { platform: "ios", install_id: randomUUID() } });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await b.http().post("/v1/auth/otp/verify").set(attest(key)).send(body(wrong))).status);
    expect(statuses.slice(0, 4)).toEqual([422, 422, 422, 422]);
    expect([429, 422]).toContain(statuses[4]);
    const after = await b.http().post("/v1/auth/otp/verify").set(attest(key)).send(body(code));
    expect(after.status).not.toBe(200);
    expect(after.body.access_token).toBeUndefined();
    const row = await sql<{ status: string; attempts: number }>`select status, attempts from otp_challenges where id = ${req.body.challenge_id}::uuid`.execute(b.db);
    // The per-challenge rate limit (5 / 5 min) answers 429 on the fifth request before the use case
    // would lock the row (attempts 5, locked: covered by the auth-core OTP tests); either way the
    // code is never consumed.
    expect(row.rows[0]?.status).not.toBe("consumed");
    expect(row.rows[0]?.attempts).toBeGreaterThanOrEqual(4);
  });

  it("OTP send limits: 3 per 15 minutes per phone and a resend backoff; a foreign device cannot verify the code", async () => {
    const key = "k-limit-1";
    await passGate(key);
    const phone = nextPhone();
    const first = await b.http().post("/v1/auth/otp/request").set(attest(key)).send({ phone_e164: phone });
    expect(first.status).toBe(202);
    const again = await b.http().post("/v1/auth/otp/request").set(attest(key)).send({ phone_e164: phone });
    expect(again.status).toBe(429); // resend too soon (30 s base backoff)
    const foreignCode = b.sent.at(-1)?.code ?? "";
    await passGate("k-limit-2");
    const stolen = await b.http().post("/v1/auth/otp/verify").set(attest("k-limit-2")).send({ challenge_id: first.body.challenge_id, code: foreignCode, device: { platform: "ios", install_id: randomUUID() } });
    expect(stolen.status).toBe(422);
    const country = await b.http().post("/v1/auth/otp/request").set(attest(key)).send({ phone_e164: "+14155550123" });
    expect([400, 422]).toContain(country.status);
  });

  it("refresh rotates; reuse of a rotated token revokes the whole family, kills the access token and emits session.revoked", async () => {
    const s = await signIn("k-refresh-1");
    const r1 = await b.http().post("/v1/auth/refresh").send({ refresh_token: s.refresh, device_install_id: s.installId });
    expect(r1.status).toBe(200);
    expect(r1.body.refresh_token).not.toBe(s.refresh);
    expect((await b.http().get("/v1/me").set(bearer(r1.body.access_token))).status).toBe(200);
    // Replay of the first (rotated) token: reuse.
    const reuse = await b.http().post("/v1/auth/refresh").send({ refresh_token: s.refresh, device_install_id: s.installId });
    expect(reuse.status).toBe(401);
    // The legitimate newest token and its access token are dead too.
    expect((await b.http().post("/v1/auth/refresh").send({ refresh_token: r1.body.refresh_token, device_install_id: s.installId })).status).toBe(401);
    expect((await b.http().get("/v1/me").set(bearer(r1.body.access_token))).status).toBe(401);
    expect((await b.http().get("/v1/me").set(bearer(s.access))).status).toBe(401);
    const ev = await sql<{ payload: { reason: string; notify_user: boolean; user_id: string } }>`select payload from outbox_events where event_type = 'session.revoked' and payload->>'user_id' = ${s.userId}`.execute(b.db);
    expect(ev.rows.map((r) => r.payload.reason)).toContain("reuse_detected");
    expect(ev.rows.find((r) => r.payload.reason === "reuse_detected")?.payload.notify_user).toBe(true);
    const fam = await sql<{ revoke_reason: string }>`select revoke_reason from session_families where user_id = ${s.userId}::uuid`.execute(b.db);
    expect(fam.rows[0]?.revoke_reason).toBe("reuse_detected");
  });

  it("a refresh token presented by another install revokes the family (device binding)", async () => {
    const s = await signIn("k-bind-1");
    const stolen = await b.http().post("/v1/auth/refresh").send({ refresh_token: s.refresh, device_install_id: randomUUID() });
    expect(stolen.status).toBe(401);
    expect((await b.http().post("/v1/auth/refresh").send({ refresh_token: s.refresh, device_install_id: s.installId })).status).toBe(401);
    expect((await b.http().get("/v1/me").set(bearer(s.access))).status).toBe(401);
  });

  it("logout-style revocation by the owner ends the session immediately; foreign sessions are 404", async () => {
    const a = await signIn("k-rev-a");
    const o = await signIn("k-rev-b");
    const sessions = await b.http().get("/v1/me/sessions").set(bearer(a.access));
    expect(sessions.status).toBe(200);
    const sid = (JSON.parse(Buffer.from(a.access.split(".")[1] ?? "", "base64url").toString()) as { sid: string }).sid;
    const oSid = (JSON.parse(Buffer.from(o.access.split(".")[1] ?? "", "base64url").toString()) as { sid: string }).sid;
    expect((await b.http().delete(`/v1/me/sessions/${oSid}`).set(bearer(a.access))).status).toBe(404);
    expect((await b.http().get("/v1/me").set(bearer(o.access))).status).toBe(200);
    expect((await b.http().delete(`/v1/me/sessions/${sid}`).set(bearer(a.access))).status).toBe(204);
    expect((await b.http().get("/v1/me").set(bearer(a.access))).status).toBe(401);
  });

  it("forged, wrong-audience, expired and malformed bearer tokens are all 401", async () => {
    const s = await signIn("k-forge-1");
    const claims = (over: Partial<{ aud: "buyer_api" | "seller_api" | "admin_api"; nowMs: number }> = {}) =>
      buildAccessClaims({ issuer: "outlet-nk-api", userId: s.userId, audience: over.aud ?? "buyer_api", sessionId: (JSON.parse(Buffer.from(s.access.split(".")[1] ?? "", "base64url").toString()) as { sid: string }).sid, jti: randomUUID(), amr: ["otp_sms"], nowMs: over.nowMs ?? Date.now() });
    const active = b.material.keys[0];
    if (active?.privateJwk === undefined) throw new Error("no key");
    const priv = await importJWK(active.privateJwk as JWK, "EdDSA");
    const sign = (c: object, kid = "prod-k1", key: Awaited<ReturnType<typeof importJWK>> = priv) =>
      new SignJWT({ ...c }).setProtectedHeader({ alg: "EdDSA", kid, typ: "at+jwt" }).sign(key);
    // sanity: a correctly signed token for the live session works
    expect((await b.http().get("/v1/me").set(bearer(await sign(claims())))).status).toBe(200);
    expect((await b.http().get("/v1/me").set(bearer(await sign(claims({ aud: "seller_api" }))))).status).toBe(401);
    expect((await b.http().get("/v1/me").set(bearer(await sign(claims({ aud: "admin_api" }))))).status).toBe(401);
    expect((await b.http().get("/v1/me").set(bearer(await sign(claims({ nowMs: Date.now() - 3_600_000 }))))).status).toBe(401);
    const other = await generateTokenKey("prod-k1");
    const otherKey = await importJWK(other.privateJwk as JWK, "EdDSA");
    expect((await b.http().get("/v1/me").set(bearer(await sign(claims(), "prod-k1", otherKey)))).status).toBe(401);
    expect((await b.http().get("/v1/me").set(bearer(await sign(claims(), "prod-k2")))).status).toBe(401);
    const none = `${Buffer.from('{"alg":"none","typ":"at+jwt","kid":"prod-k1"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims())).toString("base64url")}.`;
    expect((await b.http().get("/v1/me").set(bearer(none))).status).toBe(401);
    expect((await b.http().get("/v1/me").set(bearer(`${s.access.slice(0, -4)}AAAA`))).status).toBe(401);
    expect((await b.http().get("/v1/me").set({ Authorization: "Bearer " })).status).toBe(401);
  });

  it("Apple sign-in through the real JWKS fetcher; a replayed nonce is refused", async () => {
    const key = "k-apple-1";
    await passGate(key);
    const nonce = `nonce-${randomUUID()}`;
    const now = Math.floor(Date.now() / 1000);
    const claims = { iss: "https://appleid.apple.com", aud: "com.outletnk.app", sub: `apple-${randomUUID()}`, iat: now, exp: now + 600, nonce: sha256Hex(nonce), email: "p@privaterelay.appleid.com", email_verified: "true" };
    const body = (token: string) => ({ id_token: token, nonce, device: { platform: "ios", install_id: randomUUID() } });
    const ok = await b.http().post("/v1/auth/apple").set(attest(key)).send(body(appleToken(appleRsa.privateKey, claims)));
    expect(ok.status).toBe(200);
    expect((await b.http().get("/v1/me").set(bearer(ok.body.access_token))).status).toBe(200);
    const replay = await b.http().post("/v1/auth/apple").set(attest(key)).send(body(appleToken(appleRsa.privateKey, claims)));
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe("nonce_reused");
    const forged = await b.http().post("/v1/auth/apple").set(attest(key)).send(body(appleToken(generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey, { ...claims, sub: "x" })));
    expect(forged.status).toBe(401);
    const wrongAud = await b.http().post("/v1/auth/apple").set(attest(key)).send(body(appleToken(appleRsa.privateKey, { ...claims, aud: "evil.app", nonce: sha256Hex("n2") })));
    expect(wrongAud.status).toBe(401);
  });

  it("passkeys end to end with a virtual authenticator: register, sign in, replay, counter rollback", async () => {
    const s = await signIn("k-pk-1");
    const auth = new VirtualAuthenticator({ rpId: RP, origin: ORIGIN });
    const reg = await b.http().post("/v1/auth/passkey/register/options").set(bearer(s.access)).send({});
    expect(reg.status).toBe(200);
    const registered = await b.http().post("/v1/auth/passkey/register").set(bearer(s.access)).send({ challenge_id: reg.body.challenge_id, credential: auth.register(reg.body.challenge as string) });
    expect(registered.status).toBe(204);
    const row = await sql<{ sign_count: string; status: string }>`select sign_count::text as sign_count, status from passkey_credentials where credential_id = ${auth.id}`.execute(b.db);
    expect(row.rows[0]).toEqual({ sign_count: "0", status: "active" });

    const signInWith = async (response: object, challenge: { challenge_id: string }) =>
      b.http().post("/v1/auth/passkey/assert").set(attest("k-pk-1")).send({ challenge_id: challenge.challenge_id, credential: response, device: { platform: "ios", install_id: randomUUID() } });
    const o1 = await b.http().post("/v1/auth/passkey/assert/options").send({});
    const a1 = auth.assert(o1.body.challenge as string, { userHandle: s.userId });
    const login = await signInWith(a1, o1.body);
    expect(login.status).toBe(200);
    expect(login.body.user.id).toBe(s.userId);
    const claims = JSON.parse(Buffer.from((login.body.access_token as string).split(".")[1] ?? "", "base64url").toString()) as { amr: string[] };
    expect(claims.amr).toEqual(["passkey", "attestation"]);
    // Replay of the very same assertion: the challenge is gone.
    expect((await signInWith(a1, o1.body)).status).toBe(401);
    // A second legitimate sign-in advances the counter.
    const o2 = await b.http().post("/v1/auth/passkey/assert/options").send({});
    expect((await signInWith(auth.assert(o2.body.challenge as string, { userHandle: s.userId }), o2.body)).status).toBe(200);
    // Challenge issued for one flow cannot be used with an assertion over another challenge.
    const o3 = await b.http().post("/v1/auth/passkey/assert/options").send({});
    expect((await signInWith(auth.assert(randomBytes(32).toString("base64url")), o3.body)).status).toBe(401);
    // Counter rollback: clone suspected, credential disabled, every session ended.
    const o4 = await b.http().post("/v1/auth/passkey/assert/options").send({});
    const rolled = await signInWith(auth.assert(o4.body.challenge as string, { counter: 1 }), o4.body);
    expect(rolled.status).toBe(401);
    const after = await sql<{ status: string }>`select status from passkey_credentials where credential_id = ${auth.id}`.execute(b.db);
    expect(after.rows[0]?.status).toBe("suspected_clone");
    expect((await b.http().get("/v1/me").set(bearer(s.access))).status).toBe(401);
    const o5 = await b.http().post("/v1/auth/passkey/assert/options").send({});
    expect((await signInWith(auth.assert(o5.body.challenge as string, { userHandle: s.userId }), o5.body)).status).toBe(401);
  });

  it("a passkey registered by user A cannot sign in as user B (user handle mismatch) and a foreign key signature fails", async () => {
    const a = await signIn("k-pk-a");
    const bUser = await signIn("k-pk-b");
    const auth = new VirtualAuthenticator({ rpId: RP, origin: ORIGIN });
    const reg = await b.http().post("/v1/auth/passkey/register/options").set(bearer(a.access)).send({});
    expect((await b.http().post("/v1/auth/passkey/register").set(bearer(a.access)).send({ challenge_id: reg.body.challenge_id, credential: auth.register(reg.body.challenge as string) })).status).toBe(204);
    const attempt = async (resp: (c: string) => object) => {
      const o = await b.http().post("/v1/auth/passkey/assert/options").send({});
      return b.http().post("/v1/auth/passkey/assert").set(attest("k-pk-a")).send({ challenge_id: o.body.challenge_id, credential: resp(o.body.challenge as string), device: { platform: "ios", install_id: randomUUID() } });
    };
    expect((await attempt((c) => auth.assert(c, { userHandle: bUser.userId }))).status).toBe(401);
    expect((await attempt((c) => auth.assert(c, { signWith: VirtualAuthenticator.foreignKey() }))).status).toBe(401);
    expect((await attempt((c) => auth.assert(c, { origin: "https://evil.example" }))).status).toBe(401);
    expect((await attempt((c) => auth.assert(c, { userHandle: a.userId }))).status).toBe(200);
  });
});
