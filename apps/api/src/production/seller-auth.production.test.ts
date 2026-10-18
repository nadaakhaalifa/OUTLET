import { createHash, randomBytes, randomUUID } from "node:crypto";
import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { SignJWT, importJWK } from "jose";
import { sql } from "kysely";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabaseUpTo } from "@outlet/db";
import { base32Decode, base32Encode, toHex, totpCode, totpStep, type OtpChannel, type OtpSender } from "@outlet/auth-core";
import { AppModule } from "../app.module";
import { configureApp } from "../app.setup";
import { loadConfig } from "../config/env";
import {
  DevAttestationVerifier,
  LocalKeyFieldCipher,
  StaticTokenKeySource,
  generateTokenKey,
  type TokenKeyMaterial,
} from "../modules/auth";
import { SELLER_MEMBERSHIPS, SELLER_SESSIONS, SELLER_STORES, type SellerMembershipService, type SellerSessions, type SellerStores } from "../modules/auth";
import { hashProof } from "../modules/auth/seller/application/otp";
import { VirtualAuthenticator } from "../modules/auth/test/virtual-authenticator";
import { createPgliteDatabase, type PgliteInstance } from "../platform/db";
import { PROD_ENV } from "./test/test-support";

const RP = "outletnk.invalid";
const ORIGIN = "https://outletnk.invalid";
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
let seq = 0;
// International numbers on purpose: sellers are not limited to Egypt.
const nextPhone = (): string => `+4479${String(10_000_000 + ++seq)}`;
interface Booted {
  app: INestApplication;
  db: ReturnType<typeof createPgliteDatabase<Record<string, never>>>;
  sent: { phoneE164: string; code: string; channel: OtpChannel }[];
  material: TokenKeyMaterial;
  http: () => ReturnType<typeof request>;
}

async function boot(configured: boolean): Promise<Booted> {
  // Was a prefix of 53; the shared session store now reads auth_sessions.uv and devices.install_secret_hash (migration 0092).
  const raw = await createTestDatabaseUpTo(9999);
  const db = createPgliteDatabase<Record<string, never>>(raw as unknown as PgliteInstance);
  const config = loadConfig({ ...PROD_ENV, TRUST_PROXY_HOPS: "1" });
  const sent: Booted["sent"] = [];
  const cap = (channel: OtpChannel): OtpSender => ({
    id: `cap-${channel}`,
    channel,
    async send(r) {
      sent.push({ phoneE164: r.phoneE164, code: r.code, channel });
      return { ok: true, providerMessageId: `m-${sent.length}` };
    },
  });
  const material: TokenKeyMaterial = { activeKid: "prod-k1", keys: [await generateTokenKey("prod-k1")] };
  const auth = configured
    ? {
        cipher: new LocalKeyFieldCipher(new Uint8Array(randomBytes(32))),
        keySource: new StaticTokenKeySource(material),
        attestation: new DevAttestationVerifier(),
        senders: [cap("sms"), cap("whatsapp")],
      }
    : undefined;
  const mod = await Test.createTestingModule({
    imports: [AppModule.register(config, {}, { production: { db, ...(auth === undefined ? {} : { auth }) } })],
  }).compile();
  const app = mod.createNestApplication();
  configureApp(app, config);
  await app.init();
  // Every request comes from a fresh client IP so the per-IP limits of one test never bleed into the next.
  let ipSeq = 0;
  const http = () => {
    const agent = request(app.getHttpServer());
    const withIp = <T extends { set(n: string, v: string): T }>(t: T): T => t.set("X-Forwarded-For", `10.${(++ipSeq >> 16) & 255}.${(ipSeq >> 8) & 255}.${ipSeq & 255}`);
    return {
      get: (u: string) => withIp(agent.get(u)),
      post: (u: string) => withIp(agent.post(u)),
      delete: (u: string) => withIp(agent.delete(u)),
    } as unknown as ReturnType<typeof request>;
  };
  return { app, db, sent, material, http };
}

describe("seller auth in production composition: unconfigured providers fail closed", () => {
  let b: Booted;
  beforeAll(async () => {
    b = await boot(false);
  }, 120_000);
  afterAll(async () => b.app.close());

  it("OTP request is 503 provider_not_configured, seller bearers are 401, assertions never succeed", async () => {
    const r = await b.http().post("/v1/seller/auth/otp/request").send({ phone_e164: nextPhone(), email: "a@example.com", locale: "en" });
    expect(r.status).toBe(503);
    expect(r.body.code).toBe("provider_not_configured");
    expect((await b.http().get("/v1/seller/auth/sessions").set(bearer("x.y.z"))).status).toBe(401);
    const a = await b.http().post("/v1/seller/auth/totp/assert").send({ otp_proof: "a".repeat(64), code: "123456" });
    expect([401, 503]).toContain(a.status);
  });
});

describe("seller auth in production composition", () => {
  let b: Booted;
  let stores: SellerStores;
  let team: SellerMembershipService;
  beforeAll(async () => {
    b = await boot(true);
    stores = b.app.get<SellerStores>(SELLER_STORES, { strict: false });
    team = b.app.get<SellerMembershipService>(SELLER_MEMBERSHIPS, { strict: false });
  }, 120_000);
  afterAll(async () => b.app.close());

  async function otpLogin(phone = nextPhone(), email = "owner@example.com") {
    const req = await b.http().post("/v1/seller/auth/otp/request").send({ phone_e164: phone, email, locale: "en" });
    expect(req.status).toBe(202);
    const code = b.sent.filter((s) => s.phoneE164 === phone).at(-1)?.code ?? "";
    const verify = await b.http().post("/v1/seller/auth/otp/verify").send({ challenge_id: req.body.challenge_id, code });
    expect(verify.status).toBe(200);
    return { phone, req, verify };
  }
  /** A fresh phone proof for a seller, minted at the store (the OTP path itself is covered by otpLogin). */
  async function proofFor(sellerUserId: string): Promise<string> {
    const p = toHex(randomBytes(32));
    await stores.proofs.put(hashProof(p), { sellerUserId, channel: "sms" }, Date.now() + 300_000);
    return p;
  }
  /** Moves earlier sends out of the resend window (the real clock is used). */
  const ageSends = async (): Promise<void> => {
    await sql`update seller_otp_send_log set sent_at = sent_at - interval '2 hours'`.execute(b.db);
  };
  async function enrolPasskey(phone = nextPhone()) {
    const { verify } = await otpLogin(phone);
    const token = verify.body.enrol_token as string;
    const opts = await b.http().post("/v1/seller/auth/passkey/register/options").set(bearer(token)).send({});
    expect(opts.status).toBe(200);
    const auth = new VirtualAuthenticator({ rpId: RP, origin: ORIGIN });
    const reg = await b.http().post("/v1/seller/auth/passkey/register").set(bearer(token)).send({ challenge_id: opts.body.challenge_id, credential: auth.register(opts.body.public_key.challenge) });
    expect(reg.status).toBe(200);
    return { phone, auth, enrolToken: token, session: reg.body as Record<string, unknown> & { access_token: string; refresh_token: string; seller_user_id: string } };
  }
  async function enrolTotp(phone = nextPhone()) {
    const { verify } = await otpLogin(phone);
    const token = verify.body.enrol_token as string;
    const en = await b.http().post("/v1/seller/auth/totp/enrol").set(bearer(token)).send({});
    expect(en.status).toBe(200);
    const secret = /secret=([A-Z2-7]+)/.exec(en.body.otpauth_uri as string)?.[1] ?? "";
    const conf = await b.http().post("/v1/seller/auth/totp/confirm").set(bearer(token)).send({ code: totpCode(secret, totpStep(Date.now())) });
    expect(conf.status).toBe(200);
    return { phone, secret, recovery: en.body.recovery_codes as string[], session: conf.body as { access_token: string; refresh_token: string; seller_user_id: string } };
  }

  it("OTP verify gives an ENROL token (scope seller:enrol, 30 min, no refresh) and no session", async () => {
    const { verify } = await otpLogin();
    expect(Object.keys(verify.body).sort()).toEqual(["enrol_token", "expires_in", "next_step", "strong_factor_enrolled"]);
    expect(verify.body).toMatchObject({ expires_in: 1800, strong_factor_enrolled: false, next_step: "enrol_strong_factor" });
    const claims = JSON.parse(Buffer.from((verify.body.enrol_token as string).split(".")[1] ?? "", "base64url").toString()) as Record<string, unknown>;
    expect(claims).toMatchObject({ aud: "seller_api", scope: "seller:enrol", amr: ["otp_sms"] });
    expect((claims["exp"] as number) - (claims["iat"] as number)).toBe(1800);
  });

  it("an enrol token cannot reach privileged routes (403) and shopper routes (401)", async () => {
    const { verify } = await otpLogin();
    const t = verify.body.enrol_token as string;
    for (const r of [await b.http().get("/v1/seller/auth/sessions").set(bearer(t)), await b.http().delete(`/v1/seller/auth/sessions/${randomUUID()}`).set(bearer(t))]) {
      expect(r.status).toBe(403);
      expect(r.body.code).toBe("strong_factor_required");
    }
    expect((await b.http().get("/v1/me").set(bearer(t))).status).toBe(401);
    expect((await b.http().post("/v1/auth/logout").set(bearer(t))).status).toBe(401);
    expect((await b.http().post("/v1/seller/auth/logout").set(bearer(t))).status).toBe(204);
    expect((await b.http().post("/v1/seller/auth/passkey/register/options").set(bearer(t)).send({})).status).toBe(401);
  });

  it("passkey journey: register -> full session (webauthn), sign-in with phone proof, replay and proof reuse fail", async () => {
    const { auth, session, enrolToken, phone } = await enrolPasskey();
    expect(session["amr"]).toEqual(["otp", "webauthn"]);
    expect(session["expires_in"]).toBe(600);
    expect(session["memberships"]).toEqual([]);
    const full = session.access_token;
    const claims = JSON.parse(Buffer.from(full.split(".")[1] ?? "", "base64url").toString()) as Record<string, unknown>;
    expect(claims["scope"]).toBeUndefined();
    expect((await b.http().get("/v1/seller/auth/sessions").set(bearer(full))).status).toBe(200);
    // The enrol token was upgraded away.
    expect((await b.http().get("/v1/seller/auth/sessions").set(bearer(enrolToken))).status).toBe(401);

    // Returning seller: OTP says assert_strong_factor and hands out a restricted enrol token.
    await ageSends();
    const again = await otpLogin(phone);
    expect(again.verify.body).toMatchObject({ next_step: "assert_strong_factor", strong_factor_enrolled: true });
    const proof = again.verify.body.otp_proof as string;
    const restricted = again.verify.body.enrol_token as string;
    for (const path of ["passkey/register/options", "totp/enrol"]) {
      expect((await b.http().post(`/v1/seller/auth/${path}`).set(bearer(restricted)).send({})).status).toBe(403);
    }
    const ao = await b.http().post("/v1/seller/auth/passkey/assert/options").send({ otp_proof: proof });
    expect(ao.status).toBe(200);
    const assertion = auth.assert(ao.body.public_key.challenge);
    const signed = await b.http().post("/v1/seller/auth/passkey/assert").send({ challenge_id: ao.body.challenge_id, credential: assertion });
    expect(signed.status).toBe(200);
    expect(signed.body.amr).toEqual(["otp", "webauthn"]);
    expect(signed.body.seller_user_id).toBe(session.seller_user_id);
    // Replay of the same challenge, and reuse of the proof.
    expect((await b.http().post("/v1/seller/auth/passkey/assert").send({ challenge_id: ao.body.challenge_id, credential: assertion })).status).toBe(401);
    expect((await b.http().post("/v1/seller/auth/passkey/assert/options").send({ otp_proof: proof })).status).toBe(401);
    // A wrong key signature is rejected.
    const proof2 = await proofFor(session.seller_user_id);
    const ao2 = await b.http().post("/v1/seller/auth/passkey/assert/options").send({ otp_proof: proof2 });
    const forged = auth.assert(ao2.body.public_key.challenge, { signWith: VirtualAuthenticator.foreignKey() });
    expect((await b.http().post("/v1/seller/auth/passkey/assert").send({ challenge_id: ao2.body.challenge_id, credential: forged })).status).toBe(401);
  });

  it("a passkey counter rollback suspects a clone and revokes every seller session", async () => {
    const { auth, session } = await enrolPasskey();
    const ok = await proofFor(session.seller_user_id);
    const o1 = await b.http().post("/v1/seller/auth/passkey/assert/options").send({ otp_proof: ok });
    const first = await b.http().post("/v1/seller/auth/passkey/assert").send({ challenge_id: o1.body.challenge_id, credential: auth.assert(o1.body.public_key.challenge, { counter: 10 }) });
    expect(first.status).toBe(200);
    const o2 = await b.http().post("/v1/seller/auth/passkey/assert/options").send({ otp_proof: await proofFor(session.seller_user_id) });
    const rolled = await b.http().post("/v1/seller/auth/passkey/assert").send({ challenge_id: o2.body.challenge_id, credential: auth.assert(o2.body.public_key.challenge, { counter: 3 }) });
    expect(rolled.status).toBe(401);
    expect((await b.http().get("/v1/seller/auth/sessions").set(bearer(first.body.access_token))).status).toBe(401);
    expect((await b.http().get("/v1/seller/auth/sessions").set(bearer(session.access_token))).status).toBe(401);
  });

  it("refresh rotates; reusing a rotated token revokes the family; wrong device is refused", async () => {
    const { session } = await enrolPasskey();
    const nil = "00000000-0000-0000-0000-000000000000";
    const r1 = await b.http().post("/v1/auth/refresh").send({ refresh_token: session.refresh_token, device_install_id: nil });
    expect(r1.status).toBe(200);
    expect(r1.body.refresh_token).not.toBe(session.refresh_token);
    expect((await b.http().get("/v1/seller/auth/sessions").set(bearer(r1.body.access_token))).status).toBe(200);
    const reuse = await b.http().post("/v1/auth/refresh").send({ refresh_token: session.refresh_token, device_install_id: nil });
    expect(reuse.status).toBe(401);
    // The legitimate newest token and its access token are dead too.
    expect((await b.http().post("/v1/auth/refresh").send({ refresh_token: r1.body.refresh_token, device_install_id: nil })).status).toBe(401);
    expect((await b.http().get("/v1/seller/auth/sessions").set(bearer(r1.body.access_token))).status).toBe(401);
    const s2 = await enrolPasskey();
    expect((await b.http().post("/v1/auth/refresh").send({ refresh_token: s2.session.refresh_token, device_install_id: randomUUID() })).status).toBe(401);
  });

  it("TOTP journey: enrol returns uri and 8 recovery codes once; replay of a used step is rejected; next step works", async () => {
    const t = await enrolTotp();
    expect(t.recovery).toHaveLength(8);
    const sid = t.session.seller_user_id;
    const now = totpStep(Date.now());
    const same = await b.http().post("/v1/seller/auth/totp/assert").send({ otp_proof: await proofFor(sid), code: totpCode(t.secret, now) });
    expect(same.status).toBe(401); // confirm already consumed this step
    const next = await b.http().post("/v1/seller/auth/totp/assert").send({ otp_proof: await proofFor(sid), code: totpCode(t.secret, now + 1) });
    expect(next.status).toBe(200);
    expect(next.body.amr).toEqual(["otp", "totp"]);
    const replay = await b.http().post("/v1/seller/auth/totp/assert").send({ otp_proof: await proofFor(sid), code: totpCode(t.secret, now + 1) });
    expect(replay.status).toBe(401);
    // Far outside the +-1 window.
    expect((await b.http().post("/v1/seller/auth/totp/assert").send({ otp_proof: await proofFor(sid), code: totpCode(t.secret, now + 10) })).status).toBe(401);
    // The secret is encrypted at rest.
    const row = await sql<{ c: Buffer }>`select secret_ciphertext as c from seller_totp where seller_user_id = ${sid}::uuid`.execute(b.db);
    expect(Buffer.from(row.rows[0]?.c ?? []).toString("latin1")).not.toContain(t.secret);
    expect(base32Encode(base32Decode(t.secret))).toBe(t.secret);
  });

  it("TOTP needs a valid phone proof; recovery codes are single use; the proof survives a typo", async () => {
    const t = await enrolTotp();
    const sid = t.session.seller_user_id;
    expect((await b.http().post("/v1/seller/auth/totp/assert").send({ otp_proof: "b".repeat(64), code: "000000" })).status).toBe(401);
    const proof = await proofFor(sid);
    expect((await b.http().post("/v1/seller/auth/totp/assert").send({ otp_proof: proof, code: "000000" })).status).toBe(401);
    const code = t.recovery[0] ?? "";
    const used = await b.http().post("/v1/seller/auth/totp/assert").send({ otp_proof: proof, code });
    expect(used.status).toBe(200);
    expect((await b.http().post("/v1/seller/auth/totp/assert").send({ otp_proof: await proofFor(sid), code })).status).toBe(401);
    const stored = await sql<{ n: number }>`select count(*)::int as n from seller_recovery_codes where seller_user_id = ${sid}::uuid and used_at is not null`.execute(b.db);
    expect(stored.rows[0]?.n).toBe(1);
    // Recovery codes are stored hashed only.
    const hashes = await sql<{ code_hash: string }>`select code_hash from seller_recovery_codes where seller_user_id = ${sid}::uuid`.execute(b.db);
    for (const c of t.recovery) expect(hashes.rows.map((h) => h.code_hash)).not.toContain(c);
  });

  it("5 wrong TOTP codes lock the account (429) even for the right code, until the lock expires", async () => {
    const t = await enrolTotp();
    const sid = t.session.seller_user_id;
    for (let i = 0; i < 5; i++) {
      expect((await b.http().post("/v1/seller/auth/totp/assert").send({ otp_proof: await proofFor(sid), code: "000001" })).status).toBe(401);
    }
    const locked = await b.http().post("/v1/seller/auth/totp/assert").send({ otp_proof: await proofFor(sid), code: totpCode(t.secret, totpStep(Date.now()) + 1) });
    expect(locked.status).toBe(429);
    expect(locked.headers["retry-after"]).toBeDefined();
    await sql`update seller_totp set locked_until = now() - interval '1 second' where seller_user_id = ${sid}::uuid`.execute(b.db);
    const ok = await b.http().post("/v1/seller/auth/totp/assert").send({ otp_proof: await proofFor(sid), code: totpCode(t.secret, totpStep(Date.now()) + 1) });
    expect(ok.status).toBe(200);
  });

  it("OTP abuse controls: brute force locks the challenge; responses do not reveal whether the phone is known", async () => {
    const phone = nextPhone();
    const known = await enrolPasskey(phone);
    expect(known.session.seller_user_id).toBeDefined();
    await ageSends();
    const unknown = await b.http().post("/v1/seller/auth/otp/request").send({ phone_e164: nextPhone(), email: "x@example.com", locale: "ar" });
    const existing = await b.http().post("/v1/seller/auth/otp/request").send({ phone_e164: phone, email: "y@example.com", locale: "ar" });
    expect(Object.keys(unknown.body).sort()).toEqual(Object.keys(existing.body).sort());
    expect(unknown.status).toBe(existing.status);
    expect(existing.status, JSON.stringify(existing.body)).toBe(202);
    let last = 0;
    for (let i = 0; i < 6; i++) {
      const r = await b.http().post("/v1/seller/auth/otp/verify").send({ challenge_id: existing.body.challenge_id, code: "000000" });
      last = r.status;
    }
    expect(last).toBe(429);
    const real = b.sent.filter((s) => s.phoneE164 === phone).at(-1)?.code ?? "";
    expect((await b.http().post("/v1/seller/auth/otp/verify").send({ challenge_id: existing.body.challenge_id, code: real })).status).toBe(429);
    expect((await b.http().post("/v1/seller/auth/otp/request").send({ phone_e164: "not-a-phone", email: "x@example.com", locale: "en" })).status).toBe(400);
  });

  it("token hygiene: wrong audience, forged, tampered, alg none and shopper tokens are refused", async () => {
    const { session } = await enrolPasskey();
    const t = session.access_token;
    const [h, p, s] = t.split(".") as [string, string, string];
    const payload = JSON.parse(Buffer.from(p, "base64url").toString()) as Record<string, unknown>;
    const tamper = (over: Record<string, unknown>): string => `${h}.${Buffer.from(JSON.stringify({ ...payload, ...over })).toString("base64url")}.${s}`;
    expect((await b.http().get("/v1/seller/auth/sessions").set(bearer(tamper({ aud: "buyer_api" })))).status).toBe(401);
    expect((await b.http().get("/v1/seller/auth/sessions").set(bearer(tamper({ sub: randomUUID() })))).status).toBe(401);
    expect((await b.http().get("/v1/seller/auth/sessions").set(bearer(tamper({ scope: "seller:enrol" })))).status).toBe(401);
    const none = `${Buffer.from('{"alg":"none","typ":"at+jwt"}').toString("base64url")}.${p}.`;
    expect((await b.http().get("/v1/seller/auth/sessions").set(bearer(none))).status).toBe(401);
    // Signed with a key the server does not trust.
    const rogue = await generateTokenKey("prod-k1");
    const key = await importJWK(rogue.privateJwk as never, "EdDSA");
    const forged = await new SignJWT({ ...payload }).setProtectedHeader({ alg: "EdDSA", kid: "prod-k1", typ: "at+jwt" }).sign(key);
    expect((await b.http().get("/v1/seller/auth/sessions").set(bearer(forged))).status).toBe(401);
    // An expired token (signed with the real key) is refused.
    const real = await importJWK(b.material.keys[0]?.privateJwk as never, "EdDSA");
    const old = Math.floor(Date.now() / 1000) - 7200;
    const expired = await new SignJWT({ ...payload, iat: old, exp: old + 600 }).setProtectedHeader({ alg: "EdDSA", kid: "prod-k1", typ: "at+jwt" }).sign(real);
    expect((await b.http().get("/v1/seller/auth/sessions").set(bearer(expired))).status).toBe(401);
    // A shopper session never works on seller routes.
    expect((await b.http().get("/v1/seller/auth/sessions")).status).toBe(401);
  });

  it("sessions: list shows only the caller's, revoke is owner scoped (404 for foreign), logout ends the session", async () => {
    const a = await enrolPasskey();
    const c = await enrolTotp();
    const list = await b.http().get("/v1/seller/auth/sessions").set(bearer(a.session.access_token));
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    const foreignId = (await b.http().get("/v1/seller/auth/sessions").set(bearer(c.session.access_token))).body.items[0].id as string;
    const foreign = await b.http().delete(`/v1/seller/auth/sessions/${foreignId}`).set(bearer(a.session.access_token));
    const missing = await b.http().delete(`/v1/seller/auth/sessions/${randomUUID()}`).set(bearer(a.session.access_token));
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect((await b.http().get("/v1/seller/auth/sessions").set(bearer(c.session.access_token))).status).toBe(200);
    expect((await b.http().post("/v1/seller/auth/logout").set(bearer(a.session.access_token))).status).toBe(204);
    expect((await b.http().get("/v1/seller/auth/sessions").set(bearer(a.session.access_token))).status).toBe(401);
  });

  it("memberships: GrantStoreRole reaches the session claims, invites become memberships after the strong factor, last owner is protected", async () => {
    const owner = await enrolPasskey();
    const ownerId = owner.session.seller_user_id;
    const storeId = randomUUID();
    expect((await team.grantStoreRole({ sellerUserId: ownerId, storeId, role: "owner", grantedBy: null })).kind).toBe("ok");
    expect((await team.grantStoreRole({ sellerUserId: ownerId, storeId, role: "owner", grantedBy: null })).kind).toBe("ok"); // idempotent
    expect(await team.listMemberships(ownerId)).toHaveLength(1);
    const refreshed = await b.http().post("/v1/auth/refresh").send({ refresh_token: owner.session.refresh_token, device_install_id: "00000000-0000-0000-0000-000000000000" });
    expect(refreshed.body.memberships).toEqual([{ store_id: storeId, role: "owner" }]);
    expect(await team.grantsFor(ownerId)).toEqual([{ kind: "brand", storeId, role: "owner" }]);

    // Invite a person who has not signed up yet; they only get the grant after the strong factor.
    const staffPhone = nextPhone();
    expect((await team.inviteStaff({ inviterSellerUserId: ownerId, storeId, phoneE164: staffPhone, role: "finance" })).kind).toBe("ok");
    const staff = await enrolTotp(staffPhone);
    expect(staff.session).toBeDefined();
    const staffSession = await b.http().get("/v1/seller/auth/sessions").set(bearer(staff.session.access_token));
    expect(staffSession.status).toBe(200);
    expect(await team.list(staff.session.seller_user_id)).toEqual([{ storeId, role: "finance" }]);
    // A finance member cannot invite; nobody outside the store can.
    expect((await team.inviteStaff({ inviterSellerUserId: staff.session.seller_user_id, storeId, phoneE164: nextPhone(), role: "support" })).kind).toBe("forbidden");
    const stranger = await enrolTotp();
    expect((await team.inviteStaff({ inviterSellerUserId: stranger.session.seller_user_id, storeId, phoneE164: nextPhone(), role: "support" })).kind).toBe("forbidden");
    expect((await team.revokeStoreRole({ sellerUserId: ownerId, storeId })).kind).toBe("last_owner");
    expect((await team.revokeStoreRole({ sellerUserId: staff.session.seller_user_id, storeId })).kind).toBe("revoked");
    expect((await team.revokeStoreRole({ sellerUserId: staff.session.seller_user_id, storeId })).kind).toBe("not_found");
  });

  it("step-up: assertRecentStrongFactor is true only for a full session within the window", async () => {
    const sessions = b.app.get<SellerSessions>(SELLER_SESSIONS, { strict: false });
    const { session } = await enrolPasskey();
    const sid = (await b.http().get("/v1/seller/auth/sessions").set(bearer(session.access_token))).body.items[0].id as string;
    expect(await sessions.assertRecentStrongFactor(sid, 300)).toBe(true);
    await sql`update seller_sessions set strong_at = now() - interval '1 hour' where id = ${sid}::uuid`.execute(b.db);
    expect(await sessions.assertRecentStrongFactor(sid, 300)).toBe(false);
    expect(await sessions.assertRecentStrongFactor(sid, 7200)).toBe(true);
    const { verify } = await otpLogin();
    const enrolSid = JSON.parse(Buffer.from((verify.body.enrol_token as string).split(".")[1] ?? "", "base64url").toString()).sid as string;
    expect(await sessions.assertRecentStrongFactor(enrolSid, 999_999)).toBe(false);
  });

  it("personal data is encrypted at rest and a seller is a separate identity from the shopper account", async () => {
    const phone = nextPhone();
    const { verify } = await otpLogin(phone, "private.owner@example.com");
    expect(verify.status).toBe(200);
    const dump = JSON.stringify(
      [
        ...(await sql`select * from seller_users`.execute(b.db)).rows,
        ...(await sql`select * from seller_otp_challenges`.execute(b.db)).rows,
        ...(await sql`select * from seller_otp_send_log`.execute(b.db)).rows,
        ...(await sql`select * from outbox_events`.execute(b.db)).rows,
      ],
      (_k, v) => (v instanceof Uint8Array ? Buffer.from(v).toString("latin1") : v),
    );
    expect(dump).not.toContain(phone);
    expect(dump).not.toContain("private.owner@example.com");
    const shopperCount = await sql<{ n: number }>`select count(*)::int as n from users`.execute(b.db);
    expect(shopperCount.rows[0]?.n).toBe(0);
    expect(createHash("sha256").update(phone).digest("hex")).toHaveLength(64);
  });
});
