import { generateKeyPairSync, createSign, randomUUID } from "node:crypto";
import { SignJWT, exportJWK, generateKeyPair, importJWK } from "jose";
import { beforeEach, describe, expect, it } from "vitest";
import { buildAccessClaims, issueFamily, type AccessClaims, type Audience } from "@outlet/auth-core";
import { ProviderNotConfiguredError, unconfigured } from "../../../production/unconfigured";
import { InMemorySessionRepository, InMemoryUserDirectory } from "./in-memory";
import { JoseTokenService, StaticTokenKeySource, generateTokenKey, type TokenKeySource } from "./token-service";
import { rng } from "../test/stores-contract";

const ISS = "outlet-nk-api";
const T0 = 1_800_000_000_000;
let now = T0;
const clock = { nowMs: () => now };

interface World {
  svc: JoseTokenService;
  source: StaticTokenKeySource;
  sessions: InMemorySessionRepository;
  userId: string;
  sessionId: string;
  claims: (over?: Partial<{ aud: Audience; sid: string; sub: string; nowMs: number }>) => AccessClaims;
}

async function world(): Promise<World> {
  now = T0;
  const k = await generateTokenKey("k1");
  const source = new StaticTokenKeySource({ activeKid: "k1", keys: [k] });
  const sessions = new InMemorySessionRepository();
  const users = new InMemoryUserDirectory();
  const user = await users.findOrCreateByPhone({ phoneE164: "+201000000009", language: "ar", newId: randomUUID(), nowMs: T0 });
  const sessionId = randomUUID();
  const { family } = issueFamily({ familyId: randomUUID(), userId: user.id, deviceId: "dev", recordId: randomUUID(), rng, nowMs: T0 });
  await sessions.insert({
    platform: "ios",
    family,
    session: { id: sessionId, userId: user.id, deviceId: "dev", familyId: family.familyId, amr: ["otp_sms"], createdAtMs: T0, lastUsedAtMs: T0, revokedAtMs: null },
  });
  const svc = new JoseTokenService({ source, sessions, users, clock, issuer: ISS, keyRefreshMs: 1000 });
  return {
    svc,
    source,
    sessions,
    userId: user.id,
    sessionId,
    claims: (o = {}) =>
      buildAccessClaims({ issuer: ISS, userId: o.sub ?? user.id, audience: o.aud ?? "buyer_api", sessionId: o.sid ?? sessionId, jti: randomUUID(), amr: ["otp_sms"], nowMs: o.nowMs ?? now }),
  };
}

const b64u = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");

describe("JoseTokenService", () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  });

  it("issues an EdDSA at+jwt with kid, 10 minute lifetime, audience and amr, and authenticates it", async () => {
    const token = await w.svc.issue(w.claims());
    const [h, p] = token.split(".") as [string, string];
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ alg: "EdDSA", kid: "k1", typ: "at+jwt" });
    const payload = JSON.parse(Buffer.from(p, "base64url").toString()) as AccessClaims;
    expect(payload.aud).toBe("buyer_api");
    expect(payload.exp - payload.iat).toBe(600);
    expect(payload.amr).toEqual(["otp_sms"]);
    const auth = await w.svc.authenticate(token, now);
    expect(auth?.actor.id).toBe(w.userId);
    expect(auth?.claims.sid).toBe(w.sessionId);
  });

  it("refuses a lifetime above 10 minutes at issue time", async () => {
    await expect(w.svc.issue({ ...w.claims(), exp: w.claims().iat + 601 })).rejects.toThrow();
  });

  it("rejects an expired token and one from the future", async () => {
    const token = await w.svc.issue(w.claims());
    expect(await w.svc.authenticate(token, now + 601_000 + 31_000)).toBeNull();
    const future = await w.svc.issue(w.claims({ nowMs: now + 3_600_000 }));
    expect(await w.svc.authenticate(future, now)).toBeNull();
  });

  it("rejects a token for another audience even when correctly signed", async () => {
    for (const aud of ["seller_api", "admin_api"] as const) {
      const token = await w.svc.issue(w.claims({ aud }));
      expect(await w.svc.authenticate(token, now)).toBeNull();
      expect((await w.svc.verifyClaims(token, aud, now))?.claims.aud).toBe(aud);
    }
  });

  it("rejects alg=none, an empty signature and a stripped signature", async () => {
    const claims = w.claims();
    const none = `${b64u({ alg: "none", typ: "at+jwt", kid: "k1" })}.${b64u(claims)}.`;
    expect(await w.svc.authenticate(none, now)).toBeNull();
    const real = await w.svc.issue(claims);
    const [h, p] = real.split(".") as [string, string];
    expect(await w.svc.authenticate(`${h}.${p}.`, now)).toBeNull();
    expect(await w.svc.authenticate(`${h}.${p}`, now)).toBeNull();
    expect(await w.svc.authenticate("garbage", now)).toBeNull();
    expect(await w.svc.authenticate("", now)).toBeNull();
  });

  it("rejects a token signed by a different key that claims the right kid", async () => {
    const other = await generateKeyPair("EdDSA", { crv: "Ed25519" });
    const forged = await new SignJWT({ ...w.claims() }).setProtectedHeader({ alg: "EdDSA", kid: "k1", typ: "at+jwt" }).sign(other.privateKey);
    expect(await w.svc.authenticate(forged, now)).toBeNull();
  });

  it("rejects kid confusion: unknown kid, and algorithm switching (HS256 keyed with the public key, RS256)", async () => {
    const other = await generateKeyPair("EdDSA", { crv: "Ed25519" });
    const unknownKid = await new SignJWT({ ...w.claims() }).setProtectedHeader({ alg: "EdDSA", kid: "k2", typ: "at+jwt" }).sign(other.privateKey);
    expect(await w.svc.authenticate(unknownKid, now)).toBeNull();
    // HS256 with the (public) x value as the HMAC secret: the classic key confusion.
    const jwks = await w.svc.jwks();
    const x = Buffer.from(String(jwks.keys[0]?.["x"]), "base64url");
    const hs = await new SignJWT({ ...w.claims() }).setProtectedHeader({ alg: "HS256", kid: "k1", typ: "at+jwt" }).sign(x);
    expect(await w.svc.authenticate(hs, now)).toBeNull();
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const signingInput = `${b64u({ alg: "RS256", kid: "k1", typ: "at+jwt" })}.${b64u(w.claims())}`;
    const sig = createSign("RSA-SHA256").update(signingInput).sign(rsa.privateKey).toString("base64url");
    expect(await w.svc.authenticate(`${signingInput}.${sig}`, now)).toBeNull();
  });

  it("rejects embedded key headers (jwk, jku, x5u) and a wrong typ", async () => {
    const k = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
    const jwk = await exportJWK(k.publicKey);
    const withJwk = await new SignJWT({ ...w.claims() }).setProtectedHeader({ alg: "EdDSA", kid: "k1", typ: "at+jwt", jwk }).sign(k.privateKey);
    expect(await w.svc.authenticate(withJwk, now)).toBeNull();
    const withJku = await new SignJWT({ ...w.claims() }).setProtectedHeader({ alg: "EdDSA", kid: "k1", typ: "at+jwt", jku: "https://evil.example/jwks" }).sign(k.privateKey);
    expect(await w.svc.authenticate(withJku, now)).toBeNull();
    const wrongTyp = await new SignJWT({ ...w.claims() }).setProtectedHeader({ alg: "EdDSA", kid: "k1", typ: "JWT" }).sign(k.privateKey);
    expect(await w.svc.authenticate(wrongTyp, now)).toBeNull();
  });

  it("rejects a tampered payload and a token with another issuer", async () => {
    const token = await w.svc.issue(w.claims());
    const [h, , s] = token.split(".") as [string, string, string];
    const evil = b64u({ ...w.claims(), sub: randomUUID() });
    expect(await w.svc.authenticate(`${h}.${evil}.${s}`, now)).toBeNull();
    const k = await generateTokenKey("k9");
    const foreign = new JoseTokenService({ source: new StaticTokenKeySource({ activeKid: "k9", keys: [k] }), sessions: w.sessions, users: new InMemoryUserDirectory(), clock, issuer: "someone-else" });
    expect(await w.svc.authenticate(await foreign.issue(w.claims()), now)).toBeNull();
  });

  it("revocation is immediate: a revoked session's still-valid token stops working", async () => {
    const token = await w.svc.issue(w.claims());
    expect(await w.svc.authenticate(token, now)).not.toBeNull();
    const s = await w.sessions.find(w.sessionId);
    if (s === null) throw new Error("missing session");
    await w.sessions.save({ ...s, session: { ...s.session, revokedAtMs: now } });
    expect(await w.svc.authenticate(token, now)).toBeNull();
  });

  it("rejects a token whose sid belongs to another user, and an unknown session", async () => {
    const stranger = randomUUID();
    expect(await w.svc.authenticate(await w.svc.issue(w.claims({ sub: stranger })), now)).toBeNull();
    expect(await w.svc.authenticate(await w.svc.issue(w.claims({ sid: randomUUID() })), now)).toBeNull();
  });

  it("key rotation: new tokens use the new kid, old tokens verify until the old key is dropped", async () => {
    const oldToken = await w.svc.issue(w.claims());
    const k1 = (await w.source.load()).keys[0];
    const k2 = await generateTokenKey("k2");
    if (k1 === undefined) throw new Error("no key");
    w.source.replace({ activeKid: "k2", keys: [k1, k2] });
    now += 2000; // past keyRefreshMs
    const newToken = await w.svc.issue(w.claims());
    expect(JSON.parse(Buffer.from(newToken.split(".")[0] ?? "", "base64url").toString()).kid).toBe("k2");
    expect(await w.svc.authenticate(oldToken, now)).not.toBeNull();
    expect(await w.svc.authenticate(newToken, now)).not.toBeNull();
    expect((await w.svc.jwks()).keys.map((k) => k.kid)).toEqual(["k1", "k2"]);
    w.source.replace({ activeKid: "k2", keys: [k2] });
    now += 2000;
    expect(await w.svc.authenticate(oldToken, now)).toBeNull();
    expect(await w.svc.authenticate(newToken, now)).not.toBeNull();
  });

  it("the JWKS exposes public OKP keys only", async () => {
    const jwks = await w.svc.jwks();
    for (const k of jwks.keys) {
      expect(k).toMatchObject({ kty: "OKP", crv: "Ed25519", use: "sig", alg: "EdDSA" });
      expect(k["d"]).toBeUndefined();
    }
    expect(JSON.stringify(jwks)).not.toContain('"d"');
  });

  it("rejects malformed key material (no private part for the active key, duplicate kid)", async () => {
    const k = await generateTokenKey("a");
    const { privateJwk: _drop, ...publicOnly } = k;
    const svc = (material: unknown) =>
      new JoseTokenService({ source: { load: async () => material as never }, sessions: w.sessions, users: new InMemoryUserDirectory(), clock, issuer: ISS });
    await expect(svc({ activeKid: "a", keys: [publicOnly] }).issue(w.claims())).rejects.toThrow();
    await expect(svc({ activeKid: "a", keys: [k, k] }).issue(w.claims())).rejects.toThrow();
    const rsaJwk = { kid: "a", publicJwk: { kty: "RSA", n: "x", e: "AQAB" } };
    await expect(svc({ activeKid: "a", keys: [rsaJwk] }).issue(w.claims())).rejects.toThrow();
  });

  it("fails closed when the key source is Unconfigured: issue throws provider_not_configured, nothing authenticates", async () => {
    const svc = new JoseTokenService({
      source: unconfigured<TokenKeySource>("secrets.manager"),
      sessions: w.sessions,
      users: new InMemoryUserDirectory(),
      clock,
      issuer: ISS,
    });
    await expect(svc.issue(w.claims())).rejects.toBeInstanceOf(ProviderNotConfiguredError);
    const good = await w.svc.issue(w.claims());
    expect(await svc.authenticate(good, now)).toBeNull();
  });

  it("keeps serving the last good keys when the source fails transiently after a successful load", async () => {
    const k = await generateTokenKey("k1");
    let fail = false;
    const svc = new JoseTokenService({
      source: { load: async () => { if (fail) throw new Error("kms down"); return { activeKid: "k1", keys: [k] }; } },
      sessions: w.sessions,
      users: new InMemoryUserDirectory(),
      clock,
      issuer: ISS,
      keyRefreshMs: 10,
    });
    const t = await svc.issue(w.claims());
    fail = true;
    now += 1000;
    await expect(svc.issue(w.claims())).resolves.toBeTypeOf("string");
    expect(typeof t).toBe("string");
    const imported = await importJWK(k.publicJwk, "EdDSA");
    expect(imported).toBeDefined();
  });
});
