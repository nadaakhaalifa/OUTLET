import { createHash, randomBytes, randomUUID } from "node:crypto";
import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { sql } from "kysely";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDatabaseUpTo } from "@outlet/db";
import { sha256Hex, type OtpChannel, type OtpSender } from "@outlet/auth-core";
import { AppModule } from "../app.module";
import { configureApp } from "../app.setup";
import { loadConfig } from "../config/env";
import {
  ADMIN_GRANT_READER,
  DEV_ATTESTATION_PREFIX,
  DevAttestationVerifier,
  InMemoryAdminGrantReader,
  LocalKeyFieldCipher,
  StaticTokenKeySource,
  UnconfiguredAdminGrantReader,
  cairoToday,
  generateTokenKey,
  type AdminGrantReader,
} from "../modules/auth";
import { VirtualAuthenticator } from "../modules/auth/test/virtual-authenticator";
import { createPgliteDatabase, type PgliteInstance } from "../platform/db";
import { PROD_ENV } from "./test/test-support";

/**
 * Admin web sign-in (docs/specs/dashboard-foundations.md, track 1 "Session binding for admin-web", H1)
 * on the production composition: Postgres stores over PGlite with migration 0092, JOSE tokens and the
 * real WebAuthn verifier fed by a software authenticator. Only external providers are doubles.
 */

const attest = (keyId: string) => ({ "X-App-Attest": `${DEV_ATTESTATION_PREFIX}${keyId}`, "X-Client-Platform": "ios" });
const deviceHash = (k: string): string => createHash("sha256").update(`device:${k}`).digest("hex");
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const RP = "outletnk.invalid";
const ORIGIN = "https://outletnk.invalid";
const INSTALL_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
let phoneSeq = 0;
const nextPhone = (): string => `+20100${String(8_000_000 + ++phoneSeq)}`;

type Db = ReturnType<typeof createPgliteDatabase<Record<string, never>>>;

interface Booted {
  app: INestApplication;
  db: Db;
  grants: InMemoryAdminGrantReader;
  sent: { phoneE164: string; code: string }[];
  http: () => ReturnType<typeof request>;
}

function capture(channel: OtpChannel, sent: Booted["sent"]): OtpSender {
  return {
    id: `capture-${channel}`,
    channel,
    async send(r) {
      sent.push({ phoneE164: r.phoneE164, code: r.code });
      return { ok: true, providerMessageId: `m-${sent.length}` };
    },
  };
}

async function boot(adminGrants?: AdminGrantReader): Promise<Booted> {
  const raw = await createTestDatabaseUpTo(9999);
  const db = createPgliteDatabase<Record<string, never>>(raw as unknown as PgliteInstance);
  const config = loadConfig({ ...PROD_ENV });
  const sent: Booted["sent"] = [];
  const grants = new InMemoryAdminGrantReader();
  const key = await generateTokenKey("web-k1");
  const mod = await Test.createTestingModule({
    imports: [
      AppModule.register(config, {}, {
        production: {
          db,
          auth: {
            cipher: new LocalKeyFieldCipher(new Uint8Array(randomBytes(32))),
            keySource: new StaticTokenKeySource({ activeKid: "web-k1", keys: [key] }),
            attestation: new DevAttestationVerifier(),
            senders: [capture("sms", sent), capture("whatsapp", sent)],
          },
        },
      }),
    ],
  })
    // compose.ts does not pass `adminGrants` through yet (Wave 3 composition PR): bind the port directly.
    .overrideProvider(ADMIN_GRANT_READER)
    .useValue(adminGrants ?? grants)
    .compile();
  const app = mod.createNestApplication();
  configureApp(app, config);
  await app.init();
  return { app, db, grants, sent, http: () => request(app.getHttpServer()) };
}

function dobYearsAgo(years: number): string {
  const t = cairoToday(Date.now());
  return `${String(t.year - years).padStart(4, "0")}-${String(t.month).padStart(2, "0")}-${String(t.day).padStart(2, "0")}`;
}

describe("admin web sign-in (0092, web assertion branch, install token)", () => {
  let b: Booted;
  beforeAll(async () => {
    b = await boot();
  }, 120_000);
  afterAll(async () => b.app.close());

  /** A user with a registered passkey (set up through a mobile OTP session, as a real user would). */
  async function userWithPasskey(keyId: string) {
    const gate = await b.http().post("/v1/auth/age-gate").set(attest(keyId)).send({ dob: dobYearsAgo(30), device_id_hash: deviceHash(keyId) });
    expect(gate.status).toBe(200);
    const phone = nextPhone();
    const req = await b.http().post("/v1/auth/otp/request").set(attest(keyId)).send({ phone_e164: phone });
    expect(req.status).toBe(202);
    const code = b.sent.filter((s) => s.phoneE164 === phone).at(-1)?.code ?? "";
    const verify = await b.http().post("/v1/auth/otp/verify").set(attest(keyId)).send({
      challenge_id: req.body.challenge_id,
      code,
      device: { platform: "ios", install_id: randomUUID() },
    });
    expect(verify.status).toBe(200);
    const access = verify.body.access_token as string;
    const userId = verify.body.user.id as string;
    const auth = new VirtualAuthenticator({ rpId: RP, origin: ORIGIN });
    const reg = await b.http().post("/v1/auth/passkey/register/options").set(bearer(access)).send({});
    const registered = await b.http().post("/v1/auth/passkey/register").set(bearer(access)).send({ challenge_id: reg.body.challenge_id, credential: auth.register(reg.body.challenge as string) });
    expect(registered.status).toBe(204);
    return { auth, userId };
  }

  async function webAssert(u: { auth: VirtualAuthenticator; userId: string }, device: Record<string, unknown> = { platform: "web" }) {
    const o = await b.http().post("/v1/auth/passkey/assert/options").send({});
    return b.http().post("/v1/auth/passkey/assert").send({
      challenge_id: o.body.challenge_id,
      credential: u.auth.assert(o.body.challenge as string, { userHandle: u.userId }),
      device,
    });
  }

  const claimsOf = (jwt: string): { aud: string; amr: string[]; sid: string } =>
    JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString()) as { aud: string; amr: string[]; sid: string };

  it("a shopper-only user (no admin grant) gets 403 web_sign_in_not_allowed and no session, device or token is created", async () => {
    const u = await userWithPasskey("k-web-shopper");
    const before = await sql<{ n: string }>`select count(*)::text as n from devices where platform = 'web'`.execute(b.db);
    const r = await webAssert(u);
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ code: "web_sign_in_not_allowed" });
    expect(r.body.install_token).toBeUndefined();
    expect(r.body.access_token).toBeUndefined();
    const after = await sql<{ n: string }>`select count(*)::text as n from devices where platform = 'web'`.execute(b.db);
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
    expect((await sql`select 1 from auth_sessions where user_id = ${u.userId}::uuid and platform = 'web'`.execute(b.db)).rows).toHaveLength(0);
  });

  it("an expired admin grant does not admit web sign-in", async () => {
    const u = await userWithPasskey("k-web-expired");
    b.grants.grant(u.userId, Date.now() - 1000);
    expect((await webAssert(u)).status).toBe(403);
  });

  it("the production default (no grant reader composed) denies every web sign-in", async () => {
    const denied = await boot(new UnconfiguredAdminGrantReader());
    try {
      const gate = await denied.http().post("/v1/auth/age-gate").set(attest("k-unc")).send({ dob: dobYearsAgo(30), device_id_hash: deviceHash("k-unc") });
      expect(gate.status).toBe(200);
      const phone = nextPhone();
      const req = await denied.http().post("/v1/auth/otp/request").set(attest("k-unc")).send({ phone_e164: phone });
      const code = denied.sent.filter((s) => s.phoneE164 === phone).at(-1)?.code ?? "";
      const v = await denied.http().post("/v1/auth/otp/verify").set(attest("k-unc")).send({ challenge_id: req.body.challenge_id, code, device: { platform: "ios", install_id: randomUUID() } });
      const auth = new VirtualAuthenticator({ rpId: RP, origin: ORIGIN });
      const reg = await denied.http().post("/v1/auth/passkey/register/options").set(bearer(v.body.access_token)).send({});
      await denied.http().post("/v1/auth/passkey/register").set(bearer(v.body.access_token)).send({ challenge_id: reg.body.challenge_id, credential: auth.register(reg.body.challenge as string) });
      const o = await denied.http().post("/v1/auth/passkey/assert/options").send({});
      const r = await denied.http().post("/v1/auth/passkey/assert").send({
        challenge_id: o.body.challenge_id,
        credential: auth.assert(o.body.challenge as string, { userHandle: v.body.user.id }),
        device: { platform: "web" },
      });
      expect(r.status).toBe(403);
      expect(r.body.code).toBe("web_sign_in_not_allowed");
    } finally {
      await denied.app.close();
    }
  }, 120_000);

  it("an admin signs in: admin_api token with passkey and webauthn amr, a 43-char install token, only its hash stored, uv true, client install_id ignored", async () => {
    const u = await userWithPasskey("k-web-admin");
    b.grants.grant(u.userId);
    const clientInstallId = randomUUID();
    const r = await webAssert(u, { platform: "web", install_id: clientInstallId });
    expect(r.status).toBe(200);
    const token = r.body.install_token as string;
    expect(token).toMatch(INSTALL_TOKEN_RE);
    const claims = claimsOf(r.body.access_token as string);
    expect(claims.aud).toBe("admin_api");
    expect(claims.amr).toEqual(["passkey", "webauthn"]);

    const row = await sql<{ install_id: string; hash: Buffer; platform: string; uv: boolean }>`
      select d.install_id, d.install_secret_hash as hash, d.platform, s.uv from auth_sessions s join devices d on d.id = s.device_id where s.id = ${claims.sid}::uuid`.execute(b.db);
    const stored = row.rows[0];
    expect(stored?.platform).toBe("web");
    expect(stored?.uv).toBe(true);
    expect(stored?.install_id).not.toBe(clientInstallId);
    expect(stored?.install_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Buffer.from(stored?.hash ?? []).toString("hex")).toBe(sha256Hex(token));
    // The token is nowhere in the database in clear.
    const dump = JSON.stringify([
      (await sql`select * from devices`.execute(b.db)).rows,
      (await sql`select * from auth_sessions`.execute(b.db)).rows,
      (await sql`select * from outbox_events`.execute(b.db)).rows,
    ], (_k, v) => (v instanceof Uint8Array ? Buffer.from(v).toString("latin1") : v));
    expect(dump).not.toContain(token);
    // The client install id is not stored either.
    expect(dump).not.toContain(clientInstallId);
  });

  it("uv is true only on the passkey path: OTP sessions have uv false", async () => {
    const phoneKey = "k-web-uv";
    await b.http().post("/v1/auth/age-gate").set(attest(phoneKey)).send({ dob: dobYearsAgo(30), device_id_hash: deviceHash(phoneKey) });
    const phone = nextPhone();
    const req = await b.http().post("/v1/auth/otp/request").set(attest(phoneKey)).send({ phone_e164: phone });
    const code = b.sent.filter((s) => s.phoneE164 === phone).at(-1)?.code ?? "";
    const v = await b.http().post("/v1/auth/otp/verify").set(attest(phoneKey)).send({ challenge_id: req.body.challenge_id, code, device: { platform: "ios", install_id: randomUUID() } });
    expect(v.status).toBe(200);
    const sid = claimsOf(v.body.access_token as string).sid;
    const row = await sql<{ uv: boolean }>`select uv from auth_sessions where id = ${sid}::uuid`.execute(b.db);
    expect(row.rows[0]?.uv).toBe(false);
  });

  it("web is refused on every login route except the passkey assertion (deny by default)", async () => {
    const otp = await b.http().post("/v1/auth/otp/verify").send({ challenge_id: randomUUID(), code: "123456", device: { platform: "web", install_id: randomUUID() } });
    expect(otp.status).toBe(400);
    const apple = await b.http().post("/v1/auth/apple").send({ id_token: "x".repeat(40), nonce: "n".repeat(12), device: { platform: "web", install_id: randomUUID() } });
    expect(apple.status).toBe(400);
  });

  it("a second login revokes the previous web device: its refresh fails 401 and its hash is cleared", async () => {
    const u = await userWithPasskey("k-web-rotate");
    b.grants.grant(u.userId);
    const first = await webAssert(u);
    const second = await webAssert(u);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.install_token).not.toBe(first.body.install_token);
    const firstSid = claimsOf(first.body.access_token as string).sid;
    const old = await sql<{ revoked_at: Date | null; hash: Buffer | null }>`
      select s.revoked_at, d.install_secret_hash as hash from auth_sessions s join devices d on d.id = s.device_id where s.id = ${firstSid}::uuid`.execute(b.db);
    expect(old.rows[0]?.revoked_at).not.toBeNull();
    expect(old.rows[0]?.hash).toBeNull();
    const stale = await b.http().post("/v1/auth/refresh").set("X-Admin-Install", first.body.install_token as string).send({ refresh_token: first.body.refresh_token });
    expect(stale.status).toBe(401);
    // The new device still refreshes with its own token and the refreshed access token is admin_api too.
    const fresh = await b.http().post("/v1/auth/refresh").set("X-Admin-Install", second.body.install_token as string).send({ refresh_token: second.body.refresh_token });
    expect(fresh.status).toBe(200);
    expect(claimsOf(fresh.body.access_token as string).aud).toBe("admin_api");
    expect(fresh.body.install_token).toBeUndefined();
  });

  it("refresh with a mismatched, missing or foreign X-Admin-Install is 401 and revokes the family", async () => {
    const u = await userWithPasskey("k-web-mismatch");
    b.grants.grant(u.userId);
    for (const header of [undefined, randomBytes(32).toString("base64url"), "short"]) {
      const s = await webAssert(u);
      const sid = claimsOf(s.body.access_token as string).sid;
      const call = b.http().post("/v1/auth/refresh");
      const r = await (header === undefined ? call : call.set("X-Admin-Install", header)).send({ refresh_token: s.body.refresh_token });
      expect(r.status).toBe(401);
      expect(r.body.code).toBe("invalid_refresh_token");
      const fam = await sql<{ reason: string | null; revoked_at: Date | null }>`
        select f.revoke_reason as reason, s.revoked_at from auth_sessions s join session_families f on f.id = s.family_id where s.id = ${sid}::uuid`.execute(b.db);
      expect(fam.rows[0]?.reason).toBe("device_mismatch");
      expect(fam.rows[0]?.revoked_at).not.toBeNull();
      // The legitimate token no longer works either.
      const again = await b.http().post("/v1/auth/refresh").set("X-Admin-Install", s.body.install_token as string).send({ refresh_token: s.body.refresh_token });
      expect(again.status).toBe(401);
    }
  });

  it("a web refresh token cannot be used with a client-chosen device_install_id instead of the header", async () => {
    const u = await userWithPasskey("k-web-bodyid");
    b.grants.grant(u.userId);
    const s = await webAssert(u);
    const r = await b.http().post("/v1/auth/refresh").send({ refresh_token: s.body.refresh_token, device_install_id: randomUUID() });
    expect(r.status).toBe(401);
  });

  it("mobile refresh keeps working with device_install_id and ignores X-Admin-Install", async () => {
    const keyId = "k-web-mobile";
    await b.http().post("/v1/auth/age-gate").set(attest(keyId)).send({ dob: dobYearsAgo(30), device_id_hash: deviceHash(keyId) });
    const phone = nextPhone();
    const req = await b.http().post("/v1/auth/otp/request").set(attest(keyId)).send({ phone_e164: phone });
    const code = b.sent.filter((s) => s.phoneE164 === phone).at(-1)?.code ?? "";
    const installId = randomUUID();
    const v = await b.http().post("/v1/auth/otp/verify").set(attest(keyId)).send({ challenge_id: req.body.challenge_id, code, device: { platform: "ios", install_id: installId } });
    const ok = await b.http().post("/v1/auth/refresh").set("X-Admin-Install", "x".repeat(43)).send({ refresh_token: v.body.refresh_token, device_install_id: installId });
    expect(ok.status).toBe(200);
    expect(claimsOf(ok.body.access_token as string).aud).toBe("buyer_api");
    const noId = await b.http().post("/v1/auth/refresh").send({ refresh_token: ok.body.refresh_token });
    expect(noId.status).toBe(401);
  });

  describe("log capture", () => {
    const written: string[] = [];
    afterEach(() => vi.restoreAllMocks());

    it("the install token, its hash and the refresh token never reach stdout, stderr or console, on success or failure", async () => {
      const spies = [
        vi.spyOn(process.stdout, "write").mockImplementation((c: unknown) => (written.push(String(c)), true)),
        vi.spyOn(process.stderr, "write").mockImplementation((c: unknown) => (written.push(String(c)), true)),
        vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void written.push(a.map(String).join(" "))),
        vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void written.push(a.map(String).join(" "))),
        vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => void written.push(a.map(String).join(" "))),
      ];
      expect(spies).toHaveLength(5);
      const u = await userWithPasskey("k-web-log");
      b.grants.grant(u.userId);
      const s = await webAssert(u);
      expect(s.status).toBe(200);
      const token = s.body.install_token as string;
      const refresh = s.body.refresh_token as string;
      const bad = await b.http().post("/v1/auth/refresh").set("X-Admin-Install", token.split("").reverse().join("")).send({ refresh_token: refresh });
      expect(bad.status).toBe(401);
      const all = written.join("\n");
      for (const secret of [token, sha256Hex(token), refresh, token.split("").reverse().join("")]) expect(all).not.toContain(secret);
    });
  });
});
