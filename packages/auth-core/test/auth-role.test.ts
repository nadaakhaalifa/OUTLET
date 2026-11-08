import { contextClient } from "@outlet/db";
import type { SqlClient } from "@outlet/db";
import { createTestClient, roleClient } from "@outlet/db/testing";
import { uuidv7 } from "@outlet/ids";
import { generateKeyPair } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthError, InMemoryRateLimiter, OtpService, PgRateLimiter, SessionService, registerDevice } from "../src/index.js";
import { FakeSms, T0, at, deps, hasher } from "./helpers.js";

// Everything here runs as the real outlet_auth role under FORCE RLS: the contexts built by the services are what grants access.
const DOB = "1995-05-05";
const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "none";
  } catch (e) {
    return e instanceof AuthError ? e.code : String(e);
  }
};

let admin: SqlClient;
let auth: SqlClient;
let close: () => Promise<void>;
let sessions: SessionService;
const sms = new FakeSms();
let otp: OtpService;
let n = 0;

beforeAll(async () => {
  ({ client: admin, close } = await createTestClient());
  auth = roleClient(admin, "outlet_auth");
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  sessions = new SessionService(auth, { marketId: "EG", issuer: "i", audience: "a", kid: "k", privateKey, publicKey });
  otp = new OtpService(auth, deps, new PgRateLimiter(auth, "EG"), sms);
});
afterAll(async () => {
  await close();
});

const device = (): Promise<string> => registerDevice(auth, hasher, { marketId: "EG", platform: "ios", installId: `role-${String((n += 1))}`, now: T0 });
const phone = (): string => `+2010${String(10_000_000 + (n += 1)).padStart(8, "0")}`;
const login = async (deviceId: string, p: string, dob?: string, now = T0) => {
  const c = await otp.request({ phoneE164: p, deviceId, marketId: "EG", now });
  return otp.verify({ challengeId: c.challengeId, marketId: "EG", phoneE164: p, code: sms.last(), deviceId, ...(dob ? { dob } : {}), now: at(now.getTime() - T0.getTime() + 1000) });
};

describe("auth services under the outlet_auth role (ADR-0011 contexts)", () => {
  it("requests an OTP", async () => {
    const d = await device();
    const c = await otp.request({ phoneE164: phone(), deviceId: d, marketId: "EG", now: T0 });
    expect(c.challengeId).toBeTruthy();
    expect((await admin.query("SELECT 1 FROM otp_challenges WHERE id = $1", [c.challengeId])).rows).toHaveLength(1);
  });

  it("verify creates a new user (user, attestation) and finds an existing one", async () => {
    const d = await device();
    const p = phone();
    const created = await login(d, p, DOB);
    expect(created.isNew).toBe(true);
    const att = await admin.query("SELECT 1 FROM age_attestations WHERE user_id = $1", [created.userId]);
    expect(att.rows).toHaveLength(1);
    const again = await login(d, p, undefined, at(120_000));
    expect(again).toMatchObject({ userId: created.userId, isNew: false });
  });

  it("issue binds the device and refresh rotates the token", async () => {
    const d = await device();
    const u = await login(d, phone(), DOB);
    const s1 = await sessions.issue(u.userId, d, { now: T0 });
    const bound = await admin.query<{ user_id: string; last_seen_at: Date }>("SELECT user_id, last_seen_at FROM devices WHERE id = $1", [d]);
    expect(bound.rows[0]?.user_id).toBe(u.userId);
    const s2 = await sessions.refresh(s1.refreshToken, d, at(1000));
    expect(s2.refreshToken).not.toBe(s1.refreshToken);
    expect(await code(sessions.refresh(s1.refreshToken, d, at(2000)))).toBe("REFRESH_REUSE");
    const fam = await admin.query<{ revoke_reason: string }>("SELECT revoke_reason FROM session_families WHERE id = $1", [s1.sessionId]);
    expect(fam.rows[0]?.revoke_reason).toBe("reuse_detected");
  });

  it("a real token presented from the wrong device still revokes its family", async () => {
    const d1 = await device();
    const d2 = await device();
    const u = await login(d1, phone(), DOB);
    const s = await sessions.issue(u.userId, d1, { now: T0 });
    expect(await code(sessions.refresh(s.refreshToken, d2, at(1000)))).toBe("REFRESH_INVALID");
    const fam = await admin.query<{ revoked_at: Date | null; revoke_reason: string | null }>("SELECT revoked_at, revoke_reason FROM session_families WHERE id = $1", [s.sessionId]);
    expect(fam.rows[0]?.revoke_reason).toBe("reuse_detected");
    expect(fam.rows[0]?.revoked_at).not.toBeNull();
  });

  it("under-18 block round trip: the block row is written and then matched on the same device", async () => {
    const d = await device();
    const p = phone();
    const c = await otp.request({ phoneE164: p, deviceId: d, marketId: "EG", now: T0 });
    expect(await code(otp.verify({ challengeId: c.challengeId, marketId: "EG", phoneE164: p, code: sms.last(), deviceId: d, dob: "2012-01-01", now: at(1000) }))).toBe("UNDER_AGE");
    expect((await admin.query("SELECT 1 FROM age_blocks WHERE device_hash = $1", [hasher.hmac("device", d)])).rows).toHaveLength(1);
    const p2 = phone();
    const c2 = await otp.request({ phoneE164: p2, deviceId: d, marketId: "EG", now: at(2000) });
    expect(await code(otp.verify({ challengeId: c2.challengeId, marketId: "EG", phoneE164: p2, code: sms.last(), deviceId: d, dob: DOB, now: at(3000) }))).toBe("AGE_BLOCKED");
  });

  it("B1: a returning device already bound to another user is accepted pre-auth, and rebinding works at issue", async () => {
    const installId = `shared-${uuidv7()}`;
    const reg = () => registerDevice(auth, hasher, { marketId: "EG", platform: "ios", installId, now: T0 });
    const d = await reg();
    const a = await login(d, phone(), DOB);
    await sessions.issue(a.userId, d, { now: T0 });
    expect(await reg()).toBe(d); // bound to A, still accepted
    const b = await login(d, phone(), DOB);
    await sessions.issue(b.userId, d, { now: at(5000) });
    const row = await admin.query<{ user_id: string }>("SELECT user_id FROM devices WHERE id = $1", [d]);
    expect(row.rows[0]?.user_id).toBe(b.userId);
  });

  it("B3: the auth role cannot plant a refresh token in a family of another device", async () => {
    const d1 = await device();
    const d2 = await device();
    const u = await login(d2, phone(), DOB);
    const fam = uuidv7();
    await admin.query("INSERT INTO session_families (id, user_id, device_id, amr, created_at) VALUES ($1,$2,$3,'{otp}',$4)", [fam, u.userId, d2, T0.toISOString()]);
    const insert = (deviceId: string) =>
      contextClient(auth, { kind: "auth", marketId: "EG", auth: { deviceId } }).query(
        "INSERT INTO refresh_tokens (id, family_id, token_hash, rotation_no, issued_at, expires_at) VALUES ($1,$2,$3,1,$4,$4)",
        [uuidv7(), fam, Buffer.alloc(32, 7), T0.toISOString()],
      );
    await expect(insert(d1)).rejects.toThrow(/row-level security/);
    await insert(d2);
  });

  it("keeps the in-memory limiter path working with the same services", async () => {
    const svc = new OtpService(auth, deps, new InMemoryRateLimiter(), sms);
    const d = await device();
    await expect(svc.request({ phoneE164: phone(), deviceId: d, marketId: "EG", now: T0 })).resolves.toBeDefined();
  });
});
