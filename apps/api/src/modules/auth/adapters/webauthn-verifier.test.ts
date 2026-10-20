import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SimpleWebAuthnVerifier } from "./webauthn-verifier";
import { VirtualAuthenticator } from "../test/virtual-authenticator";

const RP = "outletnk.test";
const ORIGIN = "https://outletnk.test";
const verifier = new SimpleWebAuthnVerifier({ rpId: RP, origins: [ORIGIN] });
const challenge = (): string => randomBytes(32).toString("base64url");
const newAuth = (o: Partial<ConstructorParameters<typeof VirtualAuthenticator>[0]> = {}) => new VirtualAuthenticator({ rpId: RP, origin: ORIGIN, ...o });

async function enrolled(o: Partial<ConstructorParameters<typeof VirtualAuthenticator>[0]> = {}) {
  const a = newAuth(o);
  const c = challenge();
  const reg = await verifier.verifyRegistration({ challenge: c, response: a.register(c) });
  if (!reg.ok) throw new Error(`registration failed: ${reg.reason}`);
  return { a, cred: reg.value };
}

describe("SimpleWebAuthnVerifier: registration", () => {
  it("accepts a valid ES256 'none' attestation and returns credential id, public key, counter and backup flags", async () => {
    const a = newAuth({ backupEligible: true, backedUp: true });
    const c = challenge();
    const r = await verifier.verifyRegistration({ challenge: c, response: a.register(c) });
    expect(r).toMatchObject({ ok: true, value: { credentialId: a.id, signCount: 0, backupEligible: true, backedUp: true } });
    expect(r.ok && r.value.publicKey.length).toBeGreaterThan(40);
  });

  it("rejects: wrong challenge, wrong origin, wrong RP ID, no user verification, garbage", async () => {
    const a = newAuth();
    const c = challenge();
    expect(await verifier.verifyRegistration({ challenge: challenge(), response: a.register(c) })).toEqual({ ok: false, reason: "challenge_mismatch" });
    expect(await verifier.verifyRegistration({ challenge: c, response: a.register(c, { origin: "https://evil.example" }) })).toEqual({ ok: false, reason: "origin_mismatch" });
    expect(await verifier.verifyRegistration({ challenge: c, response: a.register(c, { rpId: "evil.example" }) })).toMatchObject({ ok: false });
    expect(await verifier.verifyRegistration({ challenge: c, response: a.register(c, { userVerified: false }) })).toMatchObject({ ok: false });
    expect(await verifier.verifyRegistration({ challenge: c, response: { nope: true } })).toEqual({ ok: false, reason: "invalid_response" });
    expect(await verifier.verifyRegistration({ challenge: c, response: null })).toEqual({ ok: false, reason: "invalid_response" });
  });
});

describe("SimpleWebAuthnVerifier: assertion", () => {
  it("accepts a valid assertion, advances the counter and reports the user handle", async () => {
    const { a, cred } = await enrolled();
    const c = challenge();
    const uid = randomUUID();
    const r = await verifier.verifyAssertion({ challenge: c, response: a.assert(c, { userHandle: uid }), credential: cred });
    expect(r).toMatchObject({ ok: true, value: { credentialId: a.id, newSignCount: 1, userHandle: uid, backupEligible: false } });
    const none = await verifier.verifyAssertion({ challenge: c, response: a.assert(c, { counter: 5 }), credential: { ...cred, signCount: 1 } });
    expect(none).toMatchObject({ ok: true, value: { userHandle: null } });
  });

  it("rejects: wrong challenge, wrong origin, wrong RP ID, no UV, foreign key signature, other credential id", async () => {
    const { a, cred } = await enrolled();
    const c = challenge();
    expect(await verifier.verifyAssertion({ challenge: challenge(), response: a.assert(c), credential: cred })).toEqual({ ok: false, reason: "challenge_mismatch" });
    expect(await verifier.verifyAssertion({ challenge: c, response: a.assert(c, { origin: "https://evil.example" }), credential: cred })).toEqual({ ok: false, reason: "origin_mismatch" });
    expect(await verifier.verifyAssertion({ challenge: c, response: a.assert(c, { rpId: "evil.example" }), credential: cred })).toMatchObject({ ok: false });
    expect(await verifier.verifyAssertion({ challenge: c, response: a.assert(c, { userVerified: false }), credential: cred })).toMatchObject({ ok: false });
    expect(await verifier.verifyAssertion({ challenge: c, response: a.assert(c, { signWith: VirtualAuthenticator.foreignKey() }), credential: cred })).toEqual({ ok: false, reason: "invalid_response" });
    expect(await verifier.verifyAssertion({ challenge: c, response: a.assert(c), credential: { ...cred, credentialId: "other" } })).toEqual({ ok: false, reason: "unknown_credential" });
  });

  it("detects a rolled-back or repeated signature counter", async () => {
    const { a, cred } = await enrolled();
    const c = challenge();
    const first = await verifier.verifyAssertion({ challenge: c, response: a.assert(c, { counter: 10 }), credential: cred });
    expect(first.ok).toBe(true);
    const stored = { ...cred, signCount: 10 };
    expect(await verifier.verifyAssertion({ challenge: c, response: a.assert(c, { counter: 10 }), credential: stored })).toEqual({ ok: false, reason: "sign_count_regression" });
    expect(await verifier.verifyAssertion({ challenge: c, response: a.assert(c, { counter: 3 }), credential: stored })).toEqual({ ok: false, reason: "sign_count_regression" });
  });

  it("reports the backup flags per assertion so the service can pin BE", async () => {
    const { a, cred } = await enrolled({ backupEligible: true, backedUp: false });
    const c = challenge();
    const r = await verifier.verifyAssertion({ challenge: c, response: a.assert(c, { backedUp: true }), credential: cred });
    expect(r).toMatchObject({ ok: true, value: { backupEligible: true, backedUp: true } });
    const flipped = await verifier.verifyAssertion({ challenge: c, response: a.assert(c, { backupEligible: false }), credential: cred });
    expect(flipped).toMatchObject({ ok: true, value: { backupEligible: false } });
  });
});
