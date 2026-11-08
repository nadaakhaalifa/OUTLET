import { withTestDb } from "@outlet/db/testing";
import { describe, expect, it } from "vitest";
import { AuthError, InMemoryRateLimiter, OtpService, PgRateLimiter, registerDevice, type RateLimiter } from "../src/index.js";
import { FakeSms, T0, at, deps, hasher } from "./helpers.js";

const PHONE = "+201001234567";
const DOB_ADULT = "1995-05-05";

const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "none";
  } catch (e) {
    return e instanceof AuthError ? e.code : "other";
  }
};

const setup = async (db: Parameters<Parameters<typeof withTestDb>[0]>[0], limiter?: RateLimiter) => {
  const sms = new FakeSms();
  const svc = new OtpService(db, deps, limiter ?? new InMemoryRateLimiter(), sms);
  const deviceId = await registerDevice(db, hasher, { marketId: "EG", platform: "ios", installId: "i1", now: T0 });
  const req = (phone = PHONE, now = T0, dev = deviceId) => svc.request({ phoneE164: phone, deviceId: dev, marketId: "EG", now });
  return { sms, svc, deviceId, req };
};

describe("OtpService.request", () => {
  it("stores only an HMAC of the code, expiring in 5 minutes", async () => {
    await withTestDb(async (db) => {
      const { sms, req } = await setup(db);
      const { challengeId, expiresAt } = await req();
      expect(expiresAt.getTime() - T0.getTime()).toBe(300_000);
      expect(sms.last()).toMatch(/^\d{6}$/);
      const r = await db.query<{ code_hash: Buffer }>("SELECT code_hash FROM otp_challenges WHERE id=$1", [challengeId]);
      expect(r.rows[0]?.code_hash.length).toBe(32);
      expect(Buffer.from(r.rows[0]?.code_hash ?? []).toString("utf8")).not.toContain(sms.last());
    });
  });

  it("allows 3 per phone in 15 minutes and blocks the 4th; frees after the window", async () => {
    await withTestDb(async (db) => {
      const { req } = await setup(db);
      for (let i = 0; i < 3; i++) await req(PHONE, at(i * 1000));
      expect(await code(req(PHONE, at(4000)))).toBe("RATE_LIMITED");
      await expect(req(PHONE, at(15 * 60_000 + 1000))).resolves.toBeDefined();
    });
  });

  it("allows 10 per device per day and blocks the 11th (Postgres limiter)", async () => {
    await withTestDb(async (db) => {
      const { req } = await setup(db, new PgRateLimiter(db));
      for (let i = 0; i < 10; i++) await req(`+2010000000${String(i).padStart(2, "0")}`, at(i * 1000));
      expect(await code(req("+201000000099", at(11_000)))).toBe("RATE_LIMITED");
      await expect(req("+201000000099", at(24 * 3600_000 + 20_000))).resolves.toBeDefined();
    });
  });

  it("Postgres limiter applies the per-phone cap too", async () => {
    await withTestDb(async (db) => {
      const { req } = await setup(db, new PgRateLimiter(db));
      for (let i = 0; i < 3; i++) await req(PHONE, at(i));
      expect(await code(req(PHONE, at(10)))).toBe("RATE_LIMITED");
    });
  });

  it("rejects non-EG, malformed and unknown-market requests without SMS", async () => {
    await withTestDb(async (db) => {
      const { sms, req, svc, deviceId } = await setup(db);
      expect(await code(req("+14155550123"))).toBe("UNSUPPORTED_COUNTRY");
      expect(await code(req("01001234567"))).toBe("INVALID_PHONE");
      expect(await code(svc.request({ phoneE164: PHONE, deviceId, marketId: "XX", now: T0 }))).toBe("UNKNOWN_MARKET");
      expect(sms.sent).toHaveLength(0);
    });
  });

  it("rolls back the challenge when the SMS provider fails", async () => {
    await withTestDb(async (db) => {
      const { sms, req } = await setup(db);
      sms.fail = true;
      expect(await code(req())).toBe("OTP_SEND_FAILED");
      const n = await db.query<{ n: string }>("SELECT count(*)::text n FROM otp_challenges");
      expect(n.rows[0]?.n).toBe("0");
    });
  });
});

describe("device binding (H1)", () => {
  it("rejects an unregistered, malformed or revoked device on request, without SMS or quota use", async () => {
    await withTestDb(async (db) => {
      const { sms, req, deviceId } = await setup(db);
      expect(await code(req(PHONE, T0, "0197c0de-0000-7000-8000-00000000dead"))).toBe("INVALID_DEVICE");
      expect(await code(req(PHONE, T0, "not-a-uuid"))).toBe("INVALID_DEVICE");
      await db.query("UPDATE devices SET revoked_at = $2 WHERE id = $1", [deviceId, T0.toISOString()]);
      expect(await code(req())).toBe("INVALID_DEVICE");
      expect(sms.sent).toHaveLength(0);
    });
  });

  it("rejects a device registered in another market", async () => {
    await withTestDb(async (db) => {
      const { req } = await setup(db);
      const other = await registerDevice(db, hasher, { marketId: "AE", platform: "ios", installId: "ae1", now: T0 });
      expect(await code(req(PHONE, T0, other))).toBe("INVALID_DEVICE");
    });
  });

  it("a challenge verified from a different (registered) device is rejected and burns an attempt", async () => {
    await withTestDb(async (db) => {
      const { sms, svc, req } = await setup(db);
      const c = await req();
      const other = await registerDevice(db, hasher, { marketId: "EG", platform: "ios", installId: "i2", now: T0 });
      expect(await code(svc.verify({ deviceId: other, challengeId: c.challengeId, phoneE164: PHONE, code: sms.last(), dob: DOB_ADULT, now: at(1000) }))).toBe("INVALID_DEVICE");
      const a = await db.query<{ attempts: number }>("SELECT attempts FROM otp_challenges WHERE id=$1", [c.challengeId]);
      expect(a.rows[0]?.attempts).toBe(1);
      expect((await db.query("SELECT 1 FROM users")).rows).toHaveLength(0);
    });
  });

  it("the under-18 block cannot be skipped with a made-up device id (a real device registration is the gate)", async () => {
    await withTestDb(async (db) => {
      const { sms, svc, req, deviceId } = await setup(db);
      const c = await req();
      expect(await code(svc.verify({ deviceId, challengeId: c.challengeId, phoneE164: PHONE, code: sms.last(), dob: "2012-01-01", now: at(1000) }))).toBe("UNDER_AGE");
      // a random device id never reaches the age check: the request is refused outright
      expect(await code(req("+201002222222", at(2000), "0197c0de-0000-7000-8000-00000000beef"))).toBe("INVALID_DEVICE");
    });
  });
});

describe("per-market phone shape (M9) and retry hint (L4)", () => {
  it("rejects +2012345678 and accepts +201012345678", async () => {
    await withTestDb(async (db) => {
      const { sms, req } = await setup(db);
      expect(await code(req("+2012345678"))).toBe("INVALID_PHONE");
      expect(await code(req("+201312345678"))).toBe("INVALID_PHONE");
      expect(sms.sent).toHaveLength(0);
      expect(await code(req("+201012345678"))).toBe("none");
    });
  });

  it("RATE_LIMITED carries retryAfterSeconds from both limiters", async () => {
    for (const mk of [() => new InMemoryRateLimiter(), (db: Parameters<Parameters<typeof withTestDb>[0]>[0]) => new PgRateLimiter(db)]) {
      await withTestDb(async (db) => {
        const { req } = await setup(db, mk(db));
        for (let i = 0; i < 3; i++) await req(PHONE, at(i * 1000));
        try {
          await req(PHONE, at(4000));
          throw new Error("expected RATE_LIMITED");
        } catch (e) {
          expect(e).toBeInstanceOf(AuthError);
          expect((e as AuthError).code).toBe("RATE_LIMITED");
          // oldest hit at T0, window 15 min, now T0+4s -> 896 s
          expect((e as AuthError).retryAfterSeconds).toBe(896);
        }
      });
    }
  });

  it("SMS provider failure still consumes quota", async () => {
    await withTestDb(async (db) => {
      const { sms, req } = await setup(db);
      sms.fail = true;
      for (let i = 0; i < 3; i++) expect(await code(req(PHONE, at(i)))).toBe("OTP_SEND_FAILED");
      sms.fail = false;
      expect(await code(req(PHONE, at(10)))).toBe("RATE_LIMITED");
    });
  });
});

describe("OtpService.verify", () => {
  it("creates a user with encrypted phone and returns the same user on re-login", async () => {
    await withTestDb(async (db) => {
      const { sms, svc, req, deviceId } = await setup(db);
      const c1 = await req();
      const u1 = await svc.verify({ deviceId, challengeId: c1.challengeId, phoneE164: PHONE, code: sms.last(), dob: DOB_ADULT, now: at(1000) });
      expect(u1.isNew).toBe(true);
      const row = await db.query<{ phone_ct: Buffer; phone_bidx: Buffer; age_band: string; limited_capacity: boolean }>("SELECT * FROM users WHERE id=$1", [u1.userId]);
      expect(row.rows[0]?.age_band).toBe("21_plus");
      expect(Buffer.from(row.rows[0]?.phone_ct ?? []).toString("utf8")).not.toContain("1001234567");
      expect(await deps.cipher.decrypt(row.rows[0]?.phone_ct ?? new Uint8Array(), "users.phone_ct")).toBe(PHONE);
      expect(Buffer.from(row.rows[0]?.phone_bidx ?? []).equals(hasher.hmac("phone", `EG:${PHONE}`))).toBe(true);
      const c2 = await req(PHONE, at(60_000));
      const u2 = await svc.verify({ deviceId, challengeId: c2.challengeId, phoneE164: PHONE, code: sms.last(), now: at(61_000) });
      expect(u2).toMatchObject({ userId: u1.userId, isNew: false });
    });
  });

  it("flags 18-20 as limited_capacity", async () => {
    await withTestDb(async (db) => {
      const { sms, svc, req, deviceId } = await setup(db);
      const c = await req();
      const u = await svc.verify({ deviceId, challengeId: c.challengeId, phoneE164: PHONE, code: sms.last(), dob: "2006-01-01", now: at(1000) });
      const r = await db.query<{ limited_capacity: boolean; age_band: string }>("SELECT limited_capacity, age_band FROM users WHERE id=$1", [u.userId]);
      expect(r.rows[0]).toEqual({ limited_capacity: true, age_band: "18_20" });
    });
  });

  it("requires dob for new accounts and does not consume the challenge", async () => {
    await withTestDb(async (db) => {
      const { sms, svc, req, deviceId } = await setup(db);
      const c = await req();
      expect(await code(svc.verify({ deviceId, challengeId: c.challengeId, phoneE164: PHONE, code: sms.last(), now: at(1) }))).toBe("DOB_REQUIRED");
      await expect(svc.verify({ deviceId, challengeId: c.challengeId, phoneE164: PHONE, code: sms.last(), dob: DOB_ADULT, now: at(2) })).resolves.toBeDefined();
    });
  });

  it("locks after 5 wrong codes, even for the right code", async () => {
    await withTestDb(async (db) => {
      const { sms, svc, req, deviceId } = await setup(db);
      const c = await req();
      const wrong = sms.last() === "000000" ? "111111" : "000000";
      for (let i = 0; i < 5; i++) {
        expect(await code(svc.verify({ deviceId, challengeId: c.challengeId, phoneE164: PHONE, code: wrong, dob: DOB_ADULT, now: at(i) }))).toBe("OTP_INVALID");
      }
      expect(await code(svc.verify({ deviceId, challengeId: c.challengeId, phoneE164: PHONE, code: sms.last(), dob: DOB_ADULT, now: at(9) }))).toBe("OTP_LOCKED");
    });
  });

  it("rejects expired, consumed, unknown and wrong-phone challenges", async () => {
    await withTestDb(async (db) => {
      const { sms, svc, req, deviceId } = await setup(db);
      const c = await req();
      const good = sms.last();
      expect(await code(svc.verify({ deviceId, challengeId: c.challengeId, phoneE164: PHONE, code: good, dob: DOB_ADULT, now: at(300_000) }))).toBe("OTP_EXPIRED");
      expect(await code(svc.verify({ deviceId, challengeId: c.challengeId, phoneE164: "+201111111111", code: good, dob: DOB_ADULT, now: at(1) }))).toBe("OTP_NOT_FOUND");
      expect(await code(svc.verify({ deviceId, challengeId: "0197c0de-0000-7000-8000-000000000001", phoneE164: PHONE, code: good, now: at(1) }))).toBe("OTP_NOT_FOUND");
      await svc.verify({ deviceId, challengeId: c.challengeId, phoneE164: PHONE, code: good, dob: DOB_ADULT, now: at(2) });
      expect(await code(svc.verify({ deviceId, challengeId: c.challengeId, phoneE164: PHONE, code: good, dob: DOB_ADULT, now: at(3) }))).toBe("OTP_CONSUMED");
    });
  });

  it("lets a deletion_pending user verify (to cancel deletion) but not a deleted one", async () => {
    await withTestDb(async (db) => {
      const { sms, svc, req, deviceId } = await setup(db);
      const c = await req();
      const u = await svc.verify({ deviceId, challengeId: c.challengeId, phoneE164: PHONE, code: sms.last(), dob: DOB_ADULT, now: at(1) });
      await db.query("UPDATE users SET status='deletion_pending' WHERE id=$1", [u.userId]);
      const c2 = await req(PHONE, at(1000));
      expect(await svc.verify({ deviceId, challengeId: c2.challengeId, phoneE164: PHONE, code: sms.last(), now: at(2000) })).toMatchObject({ userId: u.userId });
      await db.query("UPDATE users SET status='deleted' WHERE id=$1", [u.userId]);
      const c3 = await req(PHONE, at(70_000));
      expect(await code(svc.verify({ deviceId, challengeId: c3.challengeId, phoneE164: PHONE, code: sms.last(), now: at(71_000) }))).toBe("OTP_NOT_FOUND");
    });
  });

  it("refuses verify when the device was revoked after the code was requested", async () => {
    await withTestDb(async (db) => {
      const { sms, svc, req, deviceId } = await setup(db);
      const c = await req();
      await db.query("UPDATE devices SET revoked_at = $2 WHERE id = $1", [deviceId, at(500).toISOString()]);
      expect(await code(svc.verify({ deviceId, challengeId: c.challengeId, phoneE164: PHONE, code: sms.last(), dob: DOB_ADULT, now: at(1000) }))).toBe("INVALID_DEVICE");
    });
  });

  it("refuses suspended accounts", async () => {
    await withTestDb(async (db) => {
      const { sms, svc, req, deviceId } = await setup(db);
      const c = await req();
      const u = await svc.verify({ deviceId, challengeId: c.challengeId, phoneE164: PHONE, code: sms.last(), dob: DOB_ADULT, now: at(1) });
      await db.query("UPDATE users SET status='suspended' WHERE id=$1", [u.userId]);
      const c2 = await req(PHONE, at(1000));
      expect(await code(svc.verify({ deviceId, challengeId: c2.challengeId, phoneE164: PHONE, code: sms.last(), now: at(2000) }))).toBe("OTP_NOT_FOUND");
    });
  });

  it("under 18: UNDER_AGE, no user/phone/dob stored, only hashes, device blocked 30 days", async () => {
    await withTestDb(async (db) => {
      const { sms, svc, req, deviceId } = await setup(db);
      const c = await req();
      expect(await code(svc.verify({ deviceId, challengeId: c.challengeId, phoneE164: PHONE, code: sms.last(), dob: "2012-01-01", now: at(1000) }))).toBe("UNDER_AGE");
      expect((await db.query("SELECT 1 FROM users")).rows).toHaveLength(0);
      expect((await db.query("SELECT 1 FROM age_attestations")).rows).toHaveLength(0);
      const b = await db.query("SELECT * FROM age_blocks");
      expect(b.rows).toHaveLength(1);
      expect(Object.keys(b.rows[0] ?? {}).sort()).toEqual(["blocked_until", "created_at", "dob_hash", "device_hash", "id", "market_id"].sort());
      expect(JSON.stringify(b.rows[0])).not.toContain("2012");
      // retry with a different, adult dob on the same device within 30 days is blocked
      const c2 = await req("+201002222222", at(2000));
      expect(await code(svc.verify({ deviceId, challengeId: c2.challengeId, phoneE164: "+201002222222", code: sms.last(), dob: DOB_ADULT, now: at(3000) }))).toBe("AGE_BLOCKED");
      // after the block it works
      const later = at(31 * 24 * 3600_000);
      const c3 = await req("+201002222222", later);
      await expect(svc.verify({ deviceId, challengeId: c3.challengeId, phoneE164: "+201002222222", code: sms.last(), dob: DOB_ADULT, now: at(31 * 24 * 3600_000 + 1000) })).resolves.toMatchObject({ isNew: true });
    });
  });
});
