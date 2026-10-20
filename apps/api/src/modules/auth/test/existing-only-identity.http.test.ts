/**
 * G-9 (ADR-0055) for Apple, Google and passkey assertion: mode "existing_only" never creates an account, and a
 * suspended account answers a typed 403 account_unavailable in create mode (was an unhandled 500).
 * Guest-specific, so existing_only fails closed (404) while flag.guest_browsing is blocked.
 */
import { createSign, generateKeyPairSync, type JsonWebKey, type KeyObject } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEV_ATTESTATION_PREFIX, JWKS_KEY_FETCHER, type JwksKeyFetcher } from "../index";
import { GUEST_BROWSING_GATE } from "../../../platform/tokens";
import { createHarness, INSTALL_ID, type Harness } from "../../../test/harness";
import type { InMemorySessionRepository, InMemoryUserDirectory } from "../adapters/in-memory";

const ORIGIN = "https://outletnk.invalid";
const KEY = "key-existing-only-1";
const attest = { "X-App-Attest": `${DEV_ATTESTATION_PREFIX}${KEY}`, "X-Client-Platform": "ios" };
const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString("base64url");

interface TestKey { readonly kid: string; readonly privateKey: KeyObject; readonly jwk: JsonWebKey }
function makeKey(kid: string): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { kid, privateKey, jwk: publicKey.export({ format: "jwk" }) };
}
function signJwt(key: TestKey, claims: Record<string, unknown>): string {
  const data = `${b64({ alg: "RS256", kid: key.kid, typ: "JWT" })}.${b64(claims)}`;
  return `${data}.${createSign("RSA-SHA256").update(data).sign(key.privateKey).toString("base64url")}`;
}
const appleKey = makeKey("apple-eo-1");
const googleKey = makeKey("google-eo-1");
const jwks: JwksKeyFetcher = {
  async getKey(provider, kid) {
    if (provider === "apple" && kid === appleKey.kid) return appleKey.jwk;
    if (provider === "google" && kid === googleKey.kid) return googleKey.jwk;
    return null;
  },
};

let h: Harness;
let blocked: Harness;
let seq = 0;
const deps = (x: Harness) => x.app.get<{ users: InMemoryUserDirectory; sessions: InMemorySessionRepository }>("AUTH_DEPS", { strict: false });

function token(x: Harness, provider: "apple" | "google", sub: string, nonce: string): string {
  const now = Math.floor(x.clock.nowMs() / 1000);
  return provider === "apple"
    ? signJwt(appleKey, { iss: "https://appleid.apple.com", aud: "com.outletnk.app", sub, iat: now, exp: now + 600, nonce })
    : signJwt(googleKey, { iss: "https://accounts.google.com", aud: "outletnk-ios.apps.googleusercontent.com", sub, iat: now, exp: now + 600, nonce, email_verified: false });
}
function social(x: Harness, provider: "apple" | "google", sub: string, extra: object = {}, nonce = `nonce-eo-${++seq}`) {
  x.grantAgeGate(KEY);
  return x
    .http()
    .post(`/v1/auth/${provider}`)
    .set(attest)
    .send({ id_token: token(x, provider, sub, nonce), nonce, device: { platform: "ios", install_id: INSTALL_ID }, ...extra });
}
const subject = (): string => `sub-eo-${++seq}`;

beforeAll(async () => {
  h = await createHarness({
    customise: (b) => b.overrideProvider(JWKS_KEY_FETCHER).useValue(jwks).overrideProvider(GUEST_BROWSING_GATE).useValue({ enabled: async () => true }),
  });
  blocked = await createHarness({ customise: (b) => b.overrideProvider(JWKS_KEY_FETCHER).useValue(jwks) });
}, 60_000);
afterAll(async () => {
  await h.close();
  await blocked.close();
});

describe.each(["apple", "google"] as const)("POST /v1/auth/%s", (provider) => {
  it("existing_only with an unknown identity answers 404 no_account and creates no user, session or token", async () => {
    const users0 = deps(h).users.size;
    const sess0 = deps(h).sessions.size;
    const r = await social(h, provider, subject(), { mode: "existing_only" });
    expect(r.status).toBe(404);
    expect(r.body.code).toBe("no_account");
    expect(JSON.stringify(r.body)).not.toMatch(/access_token|refresh_token/);
    expect(deps(h).users.size).toBe(users0);
    expect(deps(h).sessions.size).toBe(sess0);
  });

  it("existing_only with a known identity signs in to the same account; omitted and create still create", async () => {
    const sub = subject();
    const created = await social(h, provider, sub, { mode: "create" });
    expect(created.status).toBe(200);
    const quiet = await social(h, provider, sub, { mode: "existing_only" });
    expect(quiet.status).toBe(200);
    expect(quiet.body.user.id).toBe(created.body.user.id);
    expect((await social(h, provider, subject())).status).toBe(200);
  });

  it("a suspended account: create mode answers 403 account_unavailable (not 500), existing_only answers 404 no_account; nothing created", async () => {
    const sub = subject();
    const first = await social(h, provider, sub);
    expect(first.status).toBe(200);
    deps(h).users.suspendForTest(first.body.user.id as string);
    const users0 = deps(h).users.size;
    const sess0 = deps(h).sessions.size;
    const create = await social(h, provider, sub);
    expect(create.status).toBe(403);
    expect(create.body.code).toBe("account_unavailable");
    expect(create.body.access_token).toBeUndefined();
    const quiet = await social(h, provider, sub, { mode: "existing_only" });
    expect(quiet.status).toBe(404);
    expect(quiet.body.code).toBe("no_account");
    expect(deps(h).users.size).toBe(users0);
    expect(deps(h).sessions.size).toBe(sess0);
  });

  it("existing_only fails closed (404, nonce not consumed, nothing created) while flag.guest_browsing is blocked", async () => {
    const sub = subject();
    const nonce = `nonce-eo-blocked-${++seq}`;
    const users0 = deps(blocked).users.size;
    const r = await social(blocked, provider, sub, { mode: "existing_only" }, nonce);
    expect(r.status).toBe(404);
    expect(r.body.code).not.toBe("no_account");
    expect(deps(blocked).users.size).toBe(users0);
    // The gate runs before token verification, so the same nonce still works in the default mode.
    expect((await social(blocked, provider, sub, {}, nonce)).status).toBe(200);
  });

  it("an unknown mode is a 400", async () => {
    expect((await social(h, provider, subject(), { mode: "sign_up" })).status).toBe(400);
  });
});

describe("POST /v1/auth/passkey/assert mode", () => {
  async function registered(x: Harness) {
    const signIn = await social(x, "google", subject());
    expect(signIn.status).toBe(200);
    const bearer = { Authorization: `Bearer ${signIn.body.access_token as string}` };
    const opts = await x.http().post("/v1/auth/passkey/register/options").set(bearer).send({});
    const credentialId = `cred-eo-${++seq}`;
    const reg = await x.http().post("/v1/auth/passkey/register").set(bearer).send({
      challenge_id: opts.body.challenge_id,
      credential: { id: credentialId, credentialId, publicKey: `pk-${credentialId}`, signCount: 0, origin: ORIGIN, challenge: opts.body.challenge },
    });
    expect(reg.status).toBe(204);
    return { credentialId, userId: signIn.body.user.id as string };
  }
  async function assertWith(x: Harness, c: { credentialId: string; userId: string }, signCount: number, extra: object = {}) {
    x.grantAgeGate(KEY);
    const opts = await x.http().post("/v1/auth/passkey/assert/options").send({});
    return x.http().post("/v1/auth/passkey/assert").set(attest).send({
      challenge_id: opts.body.challenge_id,
      credential: { id: c.credentialId, credentialId: c.credentialId, signCount, userHandle: c.userId, origin: ORIGIN, challenge: opts.body.challenge },
      device: { platform: "ios", install_id: INSTALL_ID },
      ...extra,
    });
  }

  it("existing_only is accepted and signs in (assertion never creates an account)", async () => {
    const c = await registered(h);
    const users0 = deps(h).users.size;
    const r = await assertWith(h, c, 1, { mode: "existing_only" });
    expect(r.status).toBe(200);
    expect(r.body.user.id).toBe(c.userId);
    expect(deps(h).users.size).toBe(users0);
  });

  it("existing_only fails closed (404) while flag.guest_browsing is blocked; the default mode still works", async () => {
    const c = await registered(blocked);
    const r = await assertWith(blocked, c, 1, { mode: "existing_only" });
    expect(r.status).toBe(404);
    expect((await assertWith(blocked, c, 2)).status).toBe(200);
  });

  it("a suspended account's passkey opens no session (401, indistinguishable from an unknown credential)", async () => {
    const c = await registered(h);
    deps(h).users.suspendForTest(c.userId);
    const sess0 = deps(h).sessions.size;
    const r = await assertWith(h, c, 1);
    expect(r.status).toBe(401);
    expect(r.body.code).toBe("invalid_passkey_assertion");
    expect(deps(h).sessions.size).toBe(sess0);
  });
});
