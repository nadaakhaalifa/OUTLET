/**
 * G-9 (ADR-0055): POST /v1/auth/otp/verify with mode "existing_only" never creates anything.
 * New number: 404 no_account, no user, no session, no tokens, OTP consumed. Existing number: a normal session.
 * Default (mode omitted): create-on-verify is unchanged (the checkout sign-up). Guest-specific, so it fails
 * closed (404) while flag.guest_browsing is blocked.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DEV_ATTESTATION_PREFIX } from "../index";
import { GUEST_BROWSING_GATE } from "../../../platform/tokens";
import { createHarness, INSTALL_ID, login, type Harness } from "../../../test/harness";
import type { InMemorySessionRepository, InMemoryUserDirectory } from "../adapters/in-memory";

let h: Harness;
let blocked: Harness;
let seq = 0;
const phone = (): string => `+2010088${String(20_000 + ++seq)}`;
const attestFor = (p: string) => ({ "X-App-Attest": `${DEV_ATTESTATION_PREFIX}key-${p.slice(-8)}`, "X-Client-Platform": "ios" });
const deps = (x: Harness) => x.app.get<{ users: InMemoryUserDirectory; sessions: InMemorySessionRepository }>("AUTH_DEPS", { strict: false });

async function otp(x: Harness, p: string) {
  x.clock.advance(180_000); // past the resend timer of a number used a moment ago
  const a = attestFor(p);
  x.grantAgeGate(a["X-App-Attest"].slice(DEV_ATTESTATION_PREFIX.length));
  const sent = await x.http().post("/v1/auth/otp/request").set(a).send({ phone_e164: p });
  expect(sent.status).toBe(202);
  return { challenge_id: sent.body.challenge_id as string, code: x.mailbox.last(p)?.code as string, a };
}
const verify = (x: Harness, o: Awaited<ReturnType<typeof otp>>, extra: object = {}, code = o.code) =>
  x.http().post("/v1/auth/otp/verify").set(o.a).send({ challenge_id: o.challenge_id, code, device: { platform: "ios", install_id: INSTALL_ID }, ...extra });

beforeAll(async () => {
  h = await createHarness({ customise: (b) => b.overrideProvider(GUEST_BROWSING_GATE).useValue({ enabled: async () => true }) });
  blocked = await createHarness();
}, 60_000);
afterAll(async () => {
  await h.close();
  await blocked.close();
});

describe("existing_only", () => {
  it("a new number answers 404 no_account and creates no user, no session and no tokens", async () => {
    const p = phone();
    const users0 = deps(h).users.size;
    const sess0 = deps(h).sessions.size;
    const o = await otp(h, p);
    const r = await verify(h, o, { mode: "existing_only" });
    expect(r.status).toBe(404);
    expect(r.body.code).toBe("no_account");
    expect(JSON.stringify(r.body)).not.toMatch(/access_token|refresh_token/);
    expect(deps(h).users.size).toBe(users0);
    expect(deps(h).sessions.size).toBe(sess0);
    expect(await deps(h).users.findByPhone(p)).toBeNull();
  });

  it("consumes the OTP: replaying the same code (in either mode) is invalid and still creates nothing", async () => {
    const p = phone();
    const o = await otp(h, p);
    expect((await verify(h, o, { mode: "existing_only" })).status).toBe(404);
    const again = await verify(h, o, {});
    expect(again.status).toBe(422);
    expect(again.body.code).toBe("otp_invalid");
    expect(await deps(h).users.findByPhone(p)).toBeNull();
  });

  it("an existing number signs in normally (session and tokens)", async () => {
    const p = phone();
    const first = await login(h, p);
    const sess0 = deps(h).sessions.size;
    const o = await otp(h, p);
    const r = await verify(h, o, { mode: "existing_only" });
    expect(r.status).toBe(200);
    expect(r.body.user.id).toBe(first.userId);
    expect(r.body.access_token).toBeTruthy();
    expect(deps(h).sessions.size).toBe(sess0 + 1);
  });

  it("no enumeration oracle without the code: a wrong code answers the same 422 for known and unknown numbers", async () => {
    const known = phone();
    await login(h, known);
    const unknown = phone();
    const a = await otp(h, known);
    const b = await otp(h, unknown);
    const ra = await verify(h, a, { mode: "existing_only" }, "000000");
    const rb = await verify(h, b, { mode: "existing_only" }, "000000");
    expect(ra.status).toBe(rb.status);
    const strip = (x: Record<string, unknown>) => { const { request_id: _r, ...rest } = x; return rest; };
    expect(strip(ra.body)).toEqual(strip(rb.body));
    // The OTP REQUEST is identical too (it never consults accounts).
    h.clock.advance(180_000);
    const q1 = await h.http().post("/v1/auth/otp/request").set(attestFor(known)).send({ phone_e164: known });
    const q2 = await h.http().post("/v1/auth/otp/request").set(attestFor(unknown)).send({ phone_e164: unknown });
    expect(q1.status).toBe(q2.status);
  });

  it("the attempt limit still applies (5 wrong codes lock the challenge)", async () => {
    const o = await otp(h, phone());
    const codes: number[] = [];
    for (let i = 0; i < 6; i += 1) codes.push((await verify(h, o, { mode: "existing_only" }, "000000")).status);
    expect(codes.slice(0, 4).every((c) => c === 422)).toBe(true);
    expect(codes.slice(-1)[0]).toBe(429);
  });

  it("an unknown mode is a 400; the body stays strict", async () => {
    const o = await otp(h, phone());
    expect((await verify(h, o, { mode: "anything" })).status).toBe(400);
    expect((await verify(h, o, { extra: 1 })).status).toBe(400);
  });

  it("fails closed (404, nothing consumed or created) while flag.guest_browsing is blocked", async () => {
    const p = phone();
    const before = deps(blocked).users.size;
    const o = await otp(blocked, p);
    const r = await verify(blocked, o, { mode: "existing_only" });
    expect(r.status).toBe(404);
    expect(r.body.code).not.toBe("no_account");
    expect(deps(blocked).users.size).toBe(before);
    // The code was not consumed: the default mode still works for the same challenge.
    expect((await verify(blocked, o, {})).status).toBe(200);
  });
});

describe("races, suspended accounts, contract", () => {
  it("two concurrent existing_only verifies on ONE challenge: exactly one consumes the code", async () => {
    const p = phone();
    await login(h, p);
    const o = await otp(h, p);
    const [a, b] = await Promise.all([verify(h, o, { mode: "existing_only" }), verify(h, o, { mode: "existing_only" })]);
    expect([a.status, b.status].sort()).toEqual([200, 422]);
    expect(deps(h).users.size).toBeGreaterThan(0);
  });

  it("a suspended account answers no_account in existing_only (nothing created, no session)", async () => {
    const p = phone();
    const first = await login(h, p);
    deps(h).users.suspendForTest(first.userId);
    const sess0 = deps(h).sessions.size;
    const users0 = deps(h).users.size;
    const o = await otp(h, p);
    const r = await verify(h, o, { mode: "existing_only" });
    expect(r.status).toBe(404);
    expect(r.body.code).toBe("no_account");
    expect(deps(h).sessions.size).toBe(sess0);
    expect(deps(h).users.size).toBe(users0);
  });

  it("is_new_account: true only when create mode just created the user; false for a returning number and existing_only", async () => {
    const p = phone();
    const o1 = await otp(h, p);
    const first = await verify(h, o1);
    expect(first.status).toBe(200);
    expect(first.body.is_new_account).toBe(true);
    const o2 = await otp(h, p);
    const again = await verify(h, o2);
    expect(again.status).toBe(200);
    expect(again.body.is_new_account).toBe(false);
    const o3 = await otp(h, p);
    const quiet = await verify(h, o3, { mode: "existing_only" });
    expect(quiet.status).toBe(200);
    expect(quiet.body.is_new_account).toBe(false);
  });

  it("create mode on a suspended number answers a clean 403 account_unavailable and creates nothing", async () => {
    const p = phone();
    const first = await login(h, p);
    deps(h).users.suspendForTest(first.userId);
    const sess0 = deps(h).sessions.size;
    const users0 = deps(h).users.size;
    const o = await otp(h, p);
    const r = await verify(h, o);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("account_unavailable");
    expect(r.body.access_token).toBeUndefined();
    expect(deps(h).sessions.size).toBe(sess0);
    expect(deps(h).users.size).toBe(users0);
  });

  it("the OpenAPI mode enum matches the controller (create, existing_only)", () => {
    const spec = readFileSync(resolve(__dirname, "../../../../../../docs/api/openapi.yaml"), "utf8");
    const block = spec.slice(spec.indexOf("    OtpVerifyRequest:"), spec.indexOf("    DeviceInfo:"));
    const values = [...block.slice(block.indexOf("mode:")).matchAll(/^\s+- (\w+)$/gm)].map((m) => m[1]);
    expect(values).toEqual(["create", "existing_only"]);
  });
});

describe("default mode is unchanged", () => {
  it("omitted and 'create' both create the account on a new number", async () => {
    const p1 = phone();
    const o1 = await otp(h, p1);
    const r1 = await verify(h, o1);
    expect(r1.status).toBe(200);
    expect(await deps(h).users.findByPhone(p1)).not.toBeNull();
    const p2 = phone();
    const o2 = await otp(h, p2);
    expect((await verify(h, o2, { mode: "create" })).status).toBe(200);
    expect(await deps(h).users.findByPhone(p2)).not.toBeNull();
  });
});

/**
 * VR-GUEST-06 (spec section 1 "Recycled numbers"): a correct OTP on a number whose account was idle for more than
 * 180 days, from an install that never held one of its sessions, issues NO tokens. Both modes answer a typed
 * 403 step_up_required with an account-bound passkey challenge; only that account's passkey completes it.
 */
describe("VR-GUEST-06 recycled-number step-up", () => {
  const DAY = 86_400_000;
  const NEW_INSTALL = "0192f3a4-5b6c-4d8e-9f01-23456789ffff";
  const ORIGIN = "https://outletnk.invalid";
  let su: Harness;
  beforeAll(async () => {
    su = await createHarness({ customise: (b) => b.overrideProvider(GUEST_BROWSING_GATE).useValue({ enabled: async () => true }) });
  }, 60_000);
  afterAll(async () => su.close());

  const verifyOn = (o: Awaited<ReturnType<typeof otp>>, installId: string, extra: object = {}, code = o.code) =>
    su.http().post("/v1/auth/otp/verify").set(o.a).send({ challenge_id: o.challenge_id, code, device: { platform: "ios", install_id: installId }, ...extra });

  /** An account last used `idleDays` ago on INSTALL_ID, with a registered passkey. */
  async function staleAccount(idleDays: number) {
    const p = phone();
    const first = await login(su, p);
    const bearer = { Authorization: `Bearer ${first.accessToken}` };
    const opts = await su.http().post("/v1/auth/passkey/register/options").set(bearer).send({});
    const credentialId = `cred-su-${p.slice(-6)}`;
    const reg = await su.http().post("/v1/auth/passkey/register").set(bearer).send({
      challenge_id: opts.body.challenge_id,
      credential: { id: credentialId, credentialId, publicKey: `pk-${credentialId}`, signCount: 0, origin: ORIGIN, challenge: opts.body.challenge },
    });
    expect(reg.status).toBe(204);
    su.clock.advance(idleDays * DAY);
    return { p, userId: first.userId, credentialId };
  }
  const assertStepUp = (challengeId: string, challenge: string, c: { credentialId: string; userId: string }, signCount: number, a: { "X-App-Attest": string; "X-Client-Platform": string }) => {
    su.grantAgeGate(a["X-App-Attest"].slice(DEV_ATTESTATION_PREFIX.length));
    return su.http().post("/v1/auth/passkey/assert").set(a).send({
      challenge_id: challengeId,
      credential: { id: c.credentialId, credentialId: c.credentialId, signCount, userHandle: c.userId, origin: ORIGIN, challenge },
      device: { platform: "ios", install_id: NEW_INSTALL },
    });
  };

  it.each([["create (default)", {}], ["existing_only", { mode: "existing_only" }]])(
    "%s: idle > 180 days on a new install answers 403 step_up_required with no tokens, no session and no account hints",
    async (_name, extra) => {
      const acct = await staleAccount(181);
      const sess0 = deps(su).sessions.size;
      const users0 = deps(su).users.size;
      const o = await otp(su, acct.p);
      const r = await verifyOn(o, NEW_INSTALL, extra);
      expect(r.status).toBe(403);
      expect(r.body.code).toBe("step_up_required");
      expect(r.body.step_up_factors).toBe("passkey");
      expect(r.body.passkey_challenge_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(typeof r.body.passkey_challenge).toBe("string");
      expect(r.body.passkey_rp_id).toBeTruthy();
      const text = JSON.stringify(r.body);
      expect(text).not.toMatch(/access_token|refresh_token|"user"/);
      expect(text).not.toContain(acct.userId);
      expect(text).not.toContain(acct.p.slice(-4));
      expect(deps(su).sessions.size).toBe(sess0);
      expect(deps(su).users.size).toBe(users0);
      // The code was consumed: replaying it does not fall through to a session.
      expect((await verifyOn(o, NEW_INSTALL, extra)).status).toBe(422);
    },
  );

  it("the account's own passkey completes the step-up (200, same account); the challenge is single use", async () => {
    const acct = await staleAccount(200);
    const o = await otp(su, acct.p);
    const r = await verifyOn(o, NEW_INSTALL);
    expect(r.status).toBe(403);
    const done = await assertStepUp(r.body.passkey_challenge_id, r.body.passkey_challenge, acct, 1, o.a);
    expect(done.status).toBe(200);
    expect(done.body.user.id).toBe(acct.userId);
    expect(done.body.access_token).toBeTruthy();
    expect((await assertStepUp(r.body.passkey_challenge_id, r.body.passkey_challenge, acct, 2, o.a)).status).toBe(401);
    // Once the new install holds a session, it is a known device: OTP alone works there from now on.
    expect((await verifyOn(await otp(su, acct.p), NEW_INSTALL)).status).toBe(200);
  });

  it("another account's passkey cannot satisfy the account-bound challenge (401, no session)", async () => {
    const victim = await staleAccount(0);
    const attacker = await staleAccount(181); // advances the clock: the victim is now idle too
    const o = await otp(su, victim.p);
    const r = await verifyOn(o, NEW_INSTALL);
    expect(r.status).toBe(403);
    const sess0 = deps(su).sessions.size;
    const bad = await assertStepUp(r.body.passkey_challenge_id, r.body.passkey_challenge, attacker, 1, o.a);
    expect(bad.status).toBe(401);
    expect(bad.body.code).toBe("invalid_passkey_assertion");
    expect(deps(su).sessions.size).toBe(sess0);
  });

  it("no step-up on the account's known install, within 180 days, or for a brand-new account", async () => {
    const known = await staleAccount(400);
    expect((await verifyOn(await otp(su, known.p), INSTALL_ID)).status).toBe(200);
    const recent = await staleAccount(179);
    expect((await verifyOn(await otp(su, recent.p), NEW_INSTALL)).status).toBe(200);
    const fresh = await verifyOn(await otp(su, phone()), NEW_INSTALL);
    expect(fresh.status).toBe(200);
    expect(fresh.body.is_new_account).toBe(true);
  });

  it("no enumeration oracle: a wrong code on a recycled number answers exactly like a wrong code on an unknown number", async () => {
    const acct = await staleAccount(181);
    const a = await otp(su, acct.p);
    const b = await otp(su, phone());
    const ra = await verifyOn(a, NEW_INSTALL, { mode: "existing_only" }, "000000");
    const rb = await verifyOn(b, NEW_INSTALL, { mode: "existing_only" }, "000000");
    const strip = (x: Record<string, unknown>) => { const { request_id: _r, ...rest } = x; return rest; };
    expect(ra.status).toBe(422);
    expect(strip(ra.body)).toEqual(strip(rb.body));
  });

  it("fails closed: if the activity lookup fails, no tokens are issued", async () => {
    const acct = await staleAccount(1);
    const o = await otp(su, acct.p);
    const spy = vi.spyOn(deps(su).sessions, "listByUser").mockRejectedValueOnce(new Error("db down"));
    const sess0 = deps(su).sessions.size;
    try {
      const r = await verifyOn(o, INSTALL_ID);
      expect(r.status).toBeGreaterThanOrEqual(500);
      expect(JSON.stringify(r.body)).not.toMatch(/access_token|refresh_token/);
      expect(deps(su).sessions.size).toBe(sess0);
    } finally {
      spy.mockRestore();
    }
  });
});
