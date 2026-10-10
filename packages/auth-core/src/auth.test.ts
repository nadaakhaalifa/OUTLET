import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  OTP_POLICY, MS, sha256Hex, hmacSha256, toHex, utf8, generateOtp, createOtpChallenge, verifyOtp,
  evaluateOtpSend, resendDelayMs, isCountryAllowed, flagPrefixAnomaly, phonePrefix,
  issueFamily, rotateRefreshToken, buildAccessClaims, checkAccessClaims, evaluateRecycledNumber,
  checkMergePreconditions, sendWithFailover, canRequestOtp, InvalidPhoneError,
  type RefreshFamily, type OtpSender, type Csprng,
} from "./index";
import { seededRng } from "./test-helpers";

const PEPPER = utf8("test-pepper");
const PHONE = "+201001234567";

describe("crypto", () => {
  it("sha256 vectors", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex("a".repeat(1000))).toBe("41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3");
  });
  it("hmac vector (RFC 4231 case 2)", () => {
    expect(toHex(hmacSha256(utf8("Jefe"), utf8("what do ya want for nothing?")))).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
  });
});

describe("OTP generation", () => {
  it("is always 6 digits", () => {
    fc.assert(fc.property(fc.integer(), (seed) => /^\d{6}$/.test(generateOtp(seededRng(seed)))));
  });
  it("rejects biased bytes (rejection sampling)", () => {
    const seq: Uint8Array[] = [new Uint8Array([255, 255, 255, 255]), new Uint8Array([0, 0, 0, 7])];
    const rng: Csprng = { randomBytes: () => seq.shift() ?? new Uint8Array(4) };
    expect(generateOtp(rng)).toBe("000007");
  });
});

describe("OTP verify", () => {
  const mk = () => createOtpChallenge({ id: "c1", phoneE164: PHONE, rng: seededRng(7), pepper: PEPPER, nowMs: 1_000 });
  it("accepts correct code once, then reports consumed", () => {
    const { challenge, code } = mk();
    const r = verifyOtp(challenge, code, 2_000, PEPPER);
    expect(r.outcome).toBe("ok");
    expect(verifyOtp(r.challenge, code, 2_001, PEPPER).outcome).toBe("already_consumed");
  });
  it("expires after 5 minutes", () => {
    const { challenge, code } = mk();
    expect(verifyOtp(challenge, code, 1_000 + 5 * MS.minute, PEPPER).outcome).toBe("expired");
    expect(verifyOtp(challenge, code, 1_000 + 5 * MS.minute - 1, PEPPER).outcome).toBe("ok");
  });
  it("locks after 5 wrong attempts even if the right code follows", () => {
    const { challenge, code } = mk();
    const wrong = code === "000000" ? "000001" : "000000";
    let c = challenge;
    for (let i = 0; i < 4; i++) {
      const r = verifyOtp(c, wrong, 2_000, PEPPER);
      expect(r.outcome).toBe("wrong_code");
      c = r.challenge;
    }
    expect(verifyOtp(c, wrong, 2_000, PEPPER).outcome).toBe("locked");
    const locked = verifyOtp(c, wrong, 2_000, PEPPER).challenge;
    expect(verifyOtp(locked, code, 2_000, PEPPER).outcome).toBe("locked");
  });
  it("hash binds phone", () => {
    const { challenge, code } = mk();
    expect(verifyOtp({ ...challenge, phoneE164: "+201111111111" }, code, 2_000, PEPPER).outcome).toBe("wrong_code");
  });
});

describe("OTP send policy", () => {
  const now = 10 * MS.day;
  it("allows first send, blocks non-EG", () => {
    expect(evaluateOtpSend(PHONE, { phoneSendTimes: [], deviceSendTimes: [] }, now).allowed).toBe(true);
    const d = evaluateOtpSend("+14155550123", { phoneSendTimes: [], deviceSendTimes: [] }, now);
    expect(d).toMatchObject({ allowed: false, reason: "country_not_allowed" });
    expect(isCountryAllowed("+201001234567")).toBe(true);
    expect(() => isCountryAllowed("0100123")).toThrow(InvalidPhoneError);
  });
  it("exponential resend timer", () => {
    expect([1, 2, 3, 4].map((n) => resendDelayMs(n))).toEqual([30_000, 60_000, 120_000, 240_000]);
    expect(resendDelayMs(50)).toBe(OTP_POLICY.resendCapMs);
  });
  it("enforces resend wait then 3 per 15 min", () => {
    const t0 = now - 2 * MS.minute;
    expect(evaluateOtpSend(PHONE, { phoneSendTimes: [t0], deviceSendTimes: [] }, t0 + 10_000)).toMatchObject({ reason: "resend_too_soon" });
    const three = [t0 - 6 * MS.minute, t0 - 3 * MS.minute, t0];
    const d = evaluateOtpSend(PHONE, { phoneSendTimes: three, deviceSendTimes: [] }, now);
    expect(d).toMatchObject({ allowed: false, reason: "phone_rate_limited" });
    if (!d.allowed) expect(d.retryAfterMs).toBe(three[0]! + 15 * MS.minute - now);
  });
  it("enforces 10 per day per device", () => {
    const times = Array.from({ length: 10 }, (_, i) => now - (i + 1) * MS.hour);
    expect(evaluateOtpSend(PHONE, { phoneSendTimes: [], deviceSendTimes: times }, now)).toMatchObject({ reason: "device_daily_limit" });
  });
  it("prefix anomaly", () => {
    expect(phonePrefix(PHONE)).toBe("201001");
    expect(flagPrefixAnomaly({ prefix: "x", sends: 5, verified: 0 }).flagged).toBe(false);
    expect(flagPrefixAnomaly({ prefix: "x", sends: 40, verified: 2 })).toEqual({ flagged: true, reason: "low_conversion" });
    expect(flagPrefixAnomaly({ prefix: "x", sends: 501, verified: 500 })).toEqual({ flagged: true, reason: "budget_exceeded" });
  });
});

describe("refresh token rotation", () => {
  const fresh = (rng: Csprng = seededRng(1)) => issueFamily({ familyId: "f", userId: "u", deviceId: "d", recordId: "r0", rng, nowMs: 0 });

  it("rotates and old token becomes reuse trigger revoking everything", () => {
    const { family, token } = fresh();
    const rng = seededRng(2);
    const r1 = rotateRefreshToken({ family, presentedToken: token, presentingDeviceId: "d", newRecordId: "r1", rng, nowMs: 1000 });
    if (r1.outcome !== "rotated") throw new Error("expected rotated");
    const reuse = rotateRefreshToken({ family: r1.family, presentedToken: token, presentingDeviceId: "d", newRecordId: "r2", rng, nowMs: 2000 });
    expect(reuse.outcome).toBe("reuse_detected");
    expect(reuse.family.records.every((r) => r.status === "revoked")).toBe(true);
    const after = rotateRefreshToken({ family: reuse.family, presentedToken: r1.token, presentingDeviceId: "d", newRecordId: "r3", rng, nowMs: 3000 });
    expect(after.outcome).toBe("revoked");
  });
  it("device mismatch revokes family; expiry at 30 days; unknown token", () => {
    const { family, token } = fresh();
    const rng = seededRng(3);
    expect(rotateRefreshToken({ family, presentedToken: token, presentingDeviceId: "other", newRecordId: "x", rng, nowMs: 5 }).outcome).toBe("device_mismatch");
    expect(rotateRefreshToken({ family, presentedToken: token, presentingDeviceId: "d", newRecordId: "x", rng, nowMs: 30 * MS.day }).outcome).toBe("expired");
    expect(rotateRefreshToken({ family, presentedToken: "nope", presentingDeviceId: "d", newRecordId: "x", rng, nowMs: 5 }).outcome).toBe("unknown_token");
  });

  type Op = { kind: "latest" } | { kind: "stale"; pick: number } | { kind: "advance"; ms: number };
  const opArb: fc.Arbitrary<Op> = fc.oneof(
    fc.constant<Op>({ kind: "latest" }),
    fc.nat(20).map<Op>((pick) => ({ kind: "stale", pick })),
    fc.integer({ min: 0, max: 3 * MS.day }).map<Op>((ms) => ({ kind: "advance", ms })),
  );

  it("property: invariants hold across arbitrary rotation/reuse sequences", () => {
    fc.assert(
      fc.property(fc.integer(), fc.array(opArb, { maxLength: 40 }), (seed, ops) => {
        const rng = seededRng(seed);
        const first = fresh(rng);
        let family: RefreshFamily = first.family;
        let latest = first.token;
        const stale: string[] = [];
        let now = 0;
        let n = 0;
        let dead = false;
        for (const op of ops) {
          if (op.kind === "advance") { now += op.ms; continue; }
          const presented = op.kind === "latest" ? latest : stale[op.pick % Math.max(1, stale.length)];
          if (presented === undefined) continue;
          const r = rotateRefreshToken({ family, presentedToken: presented, presentingDeviceId: "d", newRecordId: `n${++n}`, rng, nowMs: now });
          const active = r.family.records.filter((x) => x.status === "active").length;
          expect(active).toBeLessThanOrEqual(1);
          if (dead) {
            // once revoked, nothing is ever accepted again
            expect(r.outcome).not.toBe("rotated");
          } else if (op.kind === "stale" && presented !== latest) {
            expect(r.outcome).toBe("reuse_detected");
            expect(r.family.records.every((x) => x.status === "revoked")).toBe(true);
            dead = true;
          } else if (r.outcome === "rotated") {
            stale.push(latest);
            latest = r.token;
          } else {
            expect(r.outcome).toBe("expired"); // latest presented after its 30-day expiry
          }
          family = r.family;
        }
      }),
    );
  });
});

describe("access token claims", () => {
  const base = { issuer: "outlet", userId: "u1", audience: "buyer_api" as const, sessionId: "s1", jti: "j1", amr: ["otp_sms" as const], nowMs: 1_000_000 };
  it("builds 10 minute audience-scoped claims with amr", () => {
    const c = buildAccessClaims(base);
    expect(c.exp - c.iat).toBe(600);
    expect(c.amr).toEqual(["otp_sms"]);
  });
  it("rejects empty amr; checks audience and expiry", () => {
    expect(() => buildAccessClaims({ ...base, amr: [] })).toThrow();
    const c = buildAccessClaims(base);
    expect(checkAccessClaims(c, "buyer_api", base.nowMs).ok).toBe(true);
    expect(checkAccessClaims(c, "seller_api", base.nowMs)).toMatchObject({ reason: "wrong_audience" });
    expect(checkAccessClaims(c, "buyer_api", base.nowMs + 600_000)).toMatchObject({ reason: "expired" });
    expect(checkAccessClaims({ ...c, exp: c.iat + 3600 }, "buyer_api", base.nowMs)).toMatchObject({ reason: "malformed" });
  });
});

describe("recycled number", () => {
  const now = 1000 * MS.day;
  const base = { nowMs: now, hasVerifiedEmail: true, hasPasskey: false };
  it("requires second factor only for stale account on new device", () => {
    expect(evaluateRecycledNumber({ ...base, lastUsedAtMs: now - 181 * MS.day, deviceKnownToAccount: false })).toMatchObject({
      secondFactorRequired: true, storedValueVisible: false, acceptableFactors: ["email_link"] });
    expect(evaluateRecycledNumber({ ...base, lastUsedAtMs: now - 180 * MS.day, deviceKnownToAccount: false }).secondFactorRequired).toBe(false);
    expect(evaluateRecycledNumber({ ...base, lastUsedAtMs: now - 400 * MS.day, deviceKnownToAccount: true }).secondFactorRequired).toBe(false);
  });
  it("no factor available hides stored value", () => {
    const d = evaluateRecycledNumber({ nowMs: now, lastUsedAtMs: null, deviceKnownToAccount: false, hasVerifiedEmail: false, hasPasskey: false });
    expect(d).toMatchObject({ storedValueVisible: false, reason: "stale_account_no_factor_available" });
  });
});

describe("account merge", () => {
  const p = (o: Partial<Parameters<typeof checkMergePreconditions>[0]> = {}) => ({
    userId: "a", status: "active" as const, verifiedIdentities: ["phone" as const], unverifiedIdentities: [],
    dobHash: "h", freshlyAuthenticated: true, ...o });
  it("ok when both verified", () => {
    expect(checkMergePreconditions(p(), p({ userId: "b", verifiedIdentities: ["apple"] }))).toEqual({ ok: true });
  });
  it("reports every violation", () => {
    const r = checkMergePreconditions(p(), p({ unverifiedIdentities: ["apple"], dobHash: "x", freshlyAuthenticated: false, status: "blocked" }));
    expect(r).toEqual({ ok: false, violations: expect.arrayContaining(["same_user", "user_not_active", "identity_not_verified", "not_freshly_authenticated", "provider_conflict", "dob_mismatch"]) });
  });
});

describe("failover and attestation gate", () => {
  const sender = (id: string, channel: "sms" | "whatsapp", ok: boolean, throws = false): OtpSender => ({
    id, channel,
    send: async () => {
      if (throws) throw new Error("boom");
      return ok ? { ok: true, providerMessageId: `${id}-1` } : { ok: false, retryable: true, reason: "down" };
    },
  });
  const req = { phoneE164: PHONE, code: "123456", locale: "ar" as const, idempotencyKey: "k" };
  it("falls through sms1 -> sms2 -> whatsapp", async () => {
    const r = await sendWithFailover([sender("s1", "sms", false, true), sender("s2", "sms", false), sender("wa", "whatsapp", true)], req);
    expect(r).toMatchObject({ ok: true, senderId: "wa" });
    expect(r.attempts).toHaveLength(3);
  });
  it("reports total failure", async () => {
    expect((await sendWithFailover([sender("s1", "sms", false)], req)).ok).toBe(false);
  });
  it("only verified devices may request OTP", () => {
    expect(canRequestOtp({ attestStatus: "verified" })).toBe(true);
    expect(canRequestOtp({ attestStatus: "unknown" })).toBe(false);
  });
});
