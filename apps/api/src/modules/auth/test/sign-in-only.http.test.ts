/**
 * G-9 (ADR-0055): POST /v1/auth/otp/verify with mode "existing_only" never creates anything.
 * New number: 404 no_account, no user, no session, no tokens, OTP consumed. Existing number: a normal session.
 * Default (mode omitted): create-on-verify is unchanged (the checkout sign-up). Guest-specific, so it fails
 * closed (404) while flag.guest_browsing is blocked.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

  // TODO(blocker before real users, spec section 1 "Recycled numbers"): NOT IMPLEMENTED in either mode. A number unused
  // for more than 180 days that signs in on a NEW device must get step_up_required (email link or passkey) before any
  // stored value is shown; tokens must not unlock wallet or orders until the second factor passes.
  it.skip("VR-GUEST-06: recycled number (180 days idle) on a new device returns step_up_required", () => {
    expect(true).toBe(false);
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
