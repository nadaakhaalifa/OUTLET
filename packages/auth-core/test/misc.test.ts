import { describe, expect, it, vi } from "vitest";
import { withTestDb } from "@outlet/db/testing";
import { AesGcmFieldCipher, AuthError, createAuthDeps, Hasher, OTP_PHONE_WINDOW_MS, purgeExpired, PURGE_OTP_GRACE_MS, PURGE_RATE_LIMIT_MS, PURGE_REFRESH_GRACE_MS, InMemoryRateLimiter, oidcLoginDtoSchema, passkeyAssertionDtoSchema, registerDevice, safeEqual } from "../src/index.js";
import { T0, at, hasher, makeUserAndDevice } from "./helpers.js";

describe("crypto", () => {
  it("AES-256-GCM round-trips, uses fresh IVs, and detects tampering", async () => {
    const c = new AesGcmFieldCipher(new Uint8Array(32).fill(1));
    const a = await c.encrypt("+201001234567", "users.phone_ct");
    const b = await c.encrypt("+201001234567", "users.phone_ct");
    expect(safeEqual(a, b)).toBe(false);
    expect(await c.decrypt(a, "users.phone_ct")).toBe("+201001234567");
    const bad = Uint8Array.from(a);
    bad[bad.length - 1] = (bad[bad.length - 1] ?? 0) ^ 1;
    await expect(c.decrypt(bad, "users.phone_ct")).rejects.toThrow();
    expect(() => new AesGcmFieldCipher(new Uint8Array(16))).toThrow();
    expect(() => new Hasher(new Uint8Array(8))).toThrow();
  });
  it("ciphertext swapped between columns fails to decrypt (AAD = column name)", async () => {
    const c = new AesGcmFieldCipher(new Uint8Array(32).fill(1));
    const phone = await c.encrypt("+201001234567", "users.phone_ct");
    await expect(c.decrypt(phone, "users.dob_ct")).rejects.toThrow();
    await expect(c.decrypt(phone, "users.phone_ct")).resolves.toBe("+201001234567");
  });
  it("the local cipher refuses to construct without OUTLET_LOCAL_CIPHER=1", () => {
    vi.stubEnv("OUTLET_LOCAL_CIPHER", "");
    try {
      expect(() => new AesGcmFieldCipher(new Uint8Array(32))).toThrow(/OUTLET_LOCAL_CIPHER/);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(() => new AesGcmFieldCipher(new Uint8Array(32))).not.toThrow();
  });
  it("createAuthDeps refuses a shared HMAC and cipher key", () => {
    const k = new Uint8Array(32).fill(5);
    const cipher = new AesGcmFieldCipher(new Uint8Array(32).fill(6));
    try {
      createAuthDeps({ hmacKey: k, cipherKey: Uint8Array.from(k), cipher });
      throw new Error("expected INSECURE_CONFIG");
    } catch (e) {
      expect((e as AuthError).code).toBe("INSECURE_CONFIG");
    }
    expect(createAuthDeps({ hmacKey: k, cipherKey: new Uint8Array(32).fill(6), cipher }).hasher).toBeInstanceOf(Hasher);
  });
  it("hmac is purpose-separated", () => {
    expect(hasher.hmac("a", "x").equals(hasher.hmac("b", "x"))).toBe(false);
    expect(safeEqual(new Uint8Array(1), new Uint8Array(2))).toBe(false);
  });
});

describe("in-memory limiter", () => {
  it("slides", async () => {
    const l = new InMemoryRateLimiter();
    expect((await l.hit("k", 1, 1000, T0)).allowed).toBe(true);
    expect((await l.hit("k", 1, 1000, at(500))).allowed).toBe(false);
    expect((await l.hit("k", 1, 1000, at(1001))).allowed).toBe(true);
  });
});

describe("devices and DTOs", () => {
  it("registerDevice is idempotent per install id", async () => {
    await withTestDb(async (db) => {
      const a = await registerDevice(db, hasher, { marketId: "EG", platform: "web", installId: "z", now: T0 });
      const b = await registerDevice(db, hasher, { marketId: "EG", platform: "web", installId: "z", now: at(5) });
      expect(a).toBe(b);
    });
  });
  it("validates passkey and oidc DTOs", () => {
    expect(oidcLoginDtoSchema.safeParse({ provider: "apple", idToken: "t", nonce: "n" }).success).toBe(true);
    expect(oidcLoginDtoSchema.safeParse({ provider: "facebook", idToken: "t", nonce: "n" }).success).toBe(false);
    expect(passkeyAssertionDtoSchema.safeParse({}).success).toBe(false);
  });
});

describe("purgeExpired (L5)", () => {
  it("removes only rows past their grace period", async () => {
    await withTestDb(async (db) => {
      const { userId, deviceId } = await makeUserAndDevice(db);
      const iso = (ms: number): string => new Date(T0.getTime() + ms).toISOString();
      const now = at(30 * 86_400_000);
      const chal = (id: string, exp: string): Promise<unknown> =>
        db.query(
          "INSERT INTO otp_challenges (id, market_id, phone_bidx, purpose, code_hash, channel, provider, expires_at, device_id, created_at) VALUES ($1,'EG',$2,'login',$2,'sms','f',$3,$4,$3)",
          [id, Buffer.alloc(32, 1), exp, deviceId],
        );
      await chal("0197c0de-0000-7000-8000-000000000001", new Date(now.getTime() - PURGE_OTP_GRACE_MS - 1).toISOString());
      await chal("0197c0de-0000-7000-8000-000000000002", new Date(now.getTime() - PURGE_OTP_GRACE_MS + 1000).toISOString());
      await db.query("INSERT INTO rate_limit_hits (key, hit_at) VALUES ('k',$1),('k',$2)", [new Date(now.getTime() - PURGE_RATE_LIMIT_MS - 1).toISOString(), new Date(now.getTime() - OTP_PHONE_WINDOW_MS).toISOString()]);
      const f = "0197c0de-0000-7000-8000-0000000000f1";
      await db.query("INSERT INTO session_families (id, user_id, device_id, amr, created_at) VALUES ($1,$2,$3,'{otp}',$4)", [f, userId, deviceId, iso(0)]);
      await db.query(
        "INSERT INTO refresh_tokens (id, family_id, token_hash, rotation_no, issued_at, expires_at) VALUES ('0197c0de-0000-7000-8000-0000000000a1',$1,$2,1,$4,$5),('0197c0de-0000-7000-8000-0000000000a2',$1,$3,2,$4,$6)",
        [f, Buffer.alloc(32, 1), Buffer.alloc(32, 2), iso(0), new Date(now.getTime() - PURGE_REFRESH_GRACE_MS - 1).toISOString(), new Date(now.getTime() - 1000).toISOString()],
      );
      await db.query(
        "INSERT INTO age_blocks (id, market_id, device_hash, dob_hash, blocked_until, created_at) VALUES ('0197c0de-0000-7000-8000-0000000000b1','EG',$1,$1,$2,$3),('0197c0de-0000-7000-8000-0000000000b2','EG',$1,$1,$4,$3)",
        [Buffer.alloc(32, 3), new Date(now.getTime() - 1000).toISOString(), iso(0), new Date(now.getTime() + 86_400_000).toISOString()],
      );
      expect(PURGE_RATE_LIMIT_MS).toBe(48 * 3_600_000);
      expect(await purgeExpired(db, now)).toEqual({ otpChallenges: 1, rateLimitHits: 1, refreshTokens: 1, ageBlocks: 1 });
      expect(await purgeExpired(db, now)).toEqual({ otpChallenges: 0, rateLimitHits: 0, refreshTokens: 0, ageBlocks: 0 });
    });
  });
});
