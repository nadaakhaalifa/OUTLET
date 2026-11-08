import { withTestDb } from "@outlet/db/testing";
import { SignJWT, exportSPKI, generateKeyPair } from "jose";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ACCESS_TTL_S, AuthError, SessionService } from "../src/index.js";
import { T0, at, makeSessions, makeUserAndDevice } from "./helpers.js";

const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "none";
  } catch (e) {
    return e instanceof AuthError ? e.code : "other";
  }
};

describe("access tokens", () => {
  it("verifies, carries amr/sid, and expires after 10 minutes", async () => {
    await withTestDb(async (db) => {
      const s = await makeSessions(db);
      const { userId, deviceId } = await makeUserAndDevice(db);
      const sess = await s.issue(userId, deviceId, { now: T0, amr: ["otp", "passkey"] });
      const c = await s.verifyAccessToken(sess.accessToken, at(1000));
      expect(c).toMatchObject({ userId, sessionId: sess.sessionId, amr: ["otp", "passkey"] });
      expect(sess.accessExpiresAt.getTime() - T0.getTime()).toBe(ACCESS_TTL_S * 1000);
      expect(await code(s.verifyAccessToken(sess.accessToken, at(ACCESS_TTL_S * 1000 + 1000)))).toBe("ACCESS_TOKEN_INVALID");
    });
  });

  it("rejects wrong key, wrong audience, garbage and malformed claims", async () => {
    await withTestDb(async (db) => {
      const s = await makeSessions(db);
      const other = await generateKeyPair("ES256");
      const forge = (claims: Record<string, unknown>, aud = "outlet-app") =>
        new SignJWT(claims).setProtectedHeader({ alg: "ES256" }).setIssuer("https://api.outlet.test").setAudience(aud)
          .setSubject("u").setIssuedAt(Math.floor(T0.getTime() / 1000)).setExpirationTime(Math.floor(T0.getTime() / 1000) + 600).sign(other.privateKey);
      expect(await code(s.verifyAccessToken(await forge({ amr: [], sid: "x" }), T0))).toBe("ACCESS_TOKEN_INVALID");
      expect(await code(s.verifyAccessToken("garbage", T0))).toBe("ACCESS_TOKEN_INVALID");
      const own = await generateKeyPair("ES256");
      const s2 = new SessionService(db, { issuer: "https://api.outlet.test", audience: "outlet-app", kid: "k", privateKey: own.privateKey, publicKey: own.publicKey });
      const badAud = await new SignJWT({ amr: [], sid: "x" }).setProtectedHeader({ alg: "ES256" }).setIssuer("https://api.outlet.test").setAudience("other").setSubject("u").setExpirationTime("10m").sign(own.privateKey);
      expect(await code(s2.verifyAccessToken(badAud))).toBe("ACCESS_TOKEN_INVALID");
      const noAmr = await new SignJWT({ sid: "x" }).setProtectedHeader({ alg: "ES256" }).setIssuer("https://api.outlet.test").setAudience("outlet-app").setSubject("u").setExpirationTime("10m").sign(own.privateKey);
      expect(await code(s2.verifyAccessToken(noAmr))).toBe("ACCESS_TOKEN_INVALID");
    });
  });
});

describe("refresh tokens", () => {
  it("stores only a SHA-256 hash, rotates, and the new token works", async () => {
    await withTestDb(async (db) => {
      const s = await makeSessions(db);
      const { userId, deviceId } = await makeUserAndDevice(db);
      const a = await s.issue(userId, deviceId, { now: T0 });
      const rows = await db.query<{ token_hash: Buffer }>("SELECT token_hash FROM refresh_tokens");
      expect(rows.rows[0]?.token_hash.toString("base64url")).not.toBe(a.refreshToken);
      expect(Buffer.from(a.refreshToken, "base64url")).toHaveLength(32);
      const b = await s.refresh(a.refreshToken, deviceId, at(1000));
      expect(b.refreshToken).not.toBe(a.refreshToken);
      expect(b.sessionId).toBe(a.sessionId);
      await expect(s.refresh(b.refreshToken, deviceId, at(2000))).resolves.toBeDefined();
    });
  });

  it("reuse of a rotated token revokes the whole family", async () => {
    await withTestDb(async (db) => {
      const s = await makeSessions(db);
      const { userId, deviceId } = await makeUserAndDevice(db);
      const a = await s.issue(userId, deviceId, { now: T0 });
      const b = await s.refresh(a.refreshToken, deviceId, at(1000));
      expect(await code(s.refresh(a.refreshToken, deviceId, at(2000)))).toBe("REFRESH_REUSE");
      expect(await s.listSessions(userId)).toHaveLength(0);
      expect(await code(s.refresh(b.refreshToken, deviceId, at(3000)))).toBe("SESSION_REVOKED");
      const f = await db.query<{ revoke_reason: string }>("SELECT revoke_reason FROM session_families");
      expect(f.rows[0]?.revoke_reason).toBe("reuse_detected");
    });
  });

  it("rejects unknown and expired tokens", async () => {
    await withTestDb(async (db) => {
      const s = await makeSessions(db);
      const { userId, deviceId } = await makeUserAndDevice(db);
      const a = await s.issue(userId, deviceId, { now: T0 });
      expect(await code(s.refresh("nope", deviceId, at(1)))).toBe("REFRESH_INVALID");
      expect(await code(s.refresh(a.refreshToken, deviceId, new Date(T0.getTime() + 31 * 86_400_000)))).toBe("REFRESH_EXPIRED");
      await expect(s.refresh(a.refreshToken, deviceId, at(5))).resolves.toBeDefined();
    });
  });

  it("a known unused token presented from another device revokes the family, answers opaquely (M1)", async () => {
    await withTestDb(async (db) => {
      const s = await makeSessions(db);
      const { userId, deviceId } = await makeUserAndDevice(db);
      const other = await makeUserAndDevice(db, 2);
      const a = await s.issue(userId, deviceId, { now: T0 });
      expect(await code(s.refresh(a.refreshToken, other.deviceId, at(1)))).toBe("REFRESH_INVALID");
      const f = await db.query<{ revoke_reason: string | null }>("SELECT revoke_reason FROM session_families WHERE id=$1", [a.sessionId]);
      expect(f.rows[0]?.revoke_reason).toBe("reuse_detected");
      expect(await s.listSessions(userId)).toHaveLength(0);
      // the legitimate device is now logged out too: the token is considered compromised
      expect(await code(s.refresh(a.refreshToken, deviceId, at(5)))).toBe("SESSION_REVOKED");
    });
  });

  it("issuing a session binds the device to the user (L5)", async () => {
    await withTestDb(async (db) => {
      const s = await makeSessions(db);
      const { userId, deviceId } = await makeUserAndDevice(db);
      await s.issue(userId, deviceId, { now: T0 });
      const d = await db.query<{ user_id: string | null }>("SELECT user_id FROM devices WHERE id=$1", [deviceId]);
      expect(d.rows[0]?.user_id).toBe(userId);
    });
  });
});

describe("absolute refresh cap (M2)", () => {
  const DAY = 86_400_000;
  it("revokes the family and returns REFRESH_EXPIRED after 90 days, however often it rotated", async () => {
    await withTestDb(async (db) => {
      const s = await makeSessions(db);
      const { userId, deviceId } = await makeUserAndDevice(db);
      let cur = await s.issue(userId, deviceId, { now: T0 });
      for (const d of [29, 58, 87]) cur = await s.refresh(cur.refreshToken, deviceId, at(d * DAY));
      // the last rotation is capped at the absolute end, not 30 days out
      expect(cur.refreshExpiresAt.getTime()).toBe(T0.getTime() + 90 * DAY);
      expect(await code(s.refresh(cur.refreshToken, deviceId, at(90 * DAY)))).toBe("REFRESH_EXPIRED");
      const f = await db.query<{ revoke_reason: string }>("SELECT revoke_reason FROM session_families WHERE id=$1", [cur.sessionId]);
      expect(f.rows[0]?.revoke_reason).toBe("absolute_expiry");
      expect(await code(s.refresh(cur.refreshToken, deviceId, at(90 * DAY + 1)))).toBe("SESSION_REVOKED");
    });
  });

  it("caps the initial refresh expiry at created_at + absoluteMaxDays", async () => {
    await withTestDb(async (db) => {
      const { privateKey, publicKey } = await generateKeyPair("ES256");
      const s = new SessionService(db, { issuer: "i", audience: "a", kid: "k", privateKey, publicKey, absoluteMaxDays: 7 });
      const { userId, deviceId } = await makeUserAndDevice(db);
      const a = await s.issue(userId, deviceId, { now: T0 });
      expect(a.refreshExpiresAt.getTime()).toBe(T0.getTime() + 7 * DAY);
      const stored = await db.query<{ expires_at: Date }>("SELECT expires_at FROM refresh_tokens WHERE family_id=$1", [a.sessionId]);
      expect(stored.rows[0]?.expires_at.getTime()).toBe(T0.getTime() + 7 * DAY);
    });
  });

  it("honours a configured cap", async () => {
    await withTestDb(async (db) => {
      const { privateKey, publicKey } = await generateKeyPair("ES256");
      const s = new SessionService(db, { issuer: "i", audience: "a", kid: "k", privateKey, publicKey, absoluteMaxDays: 10 });
      const { userId, deviceId } = await makeUserAndDevice(db);
      const a = await s.issue(userId, deviceId, { now: T0 });
      expect(await code(s.refresh(a.refreshToken, deviceId, at(10 * DAY)))).toBe("REFRESH_EXPIRED");
    });
  });
});

describe("access token negatives (L2)", () => {
  const setupKeys = async (db: Parameters<Parameters<typeof withTestDb>[0]>[0]) => {
    const keys = await generateKeyPair("ES256");
    const cfg = { issuer: "https://api.outlet.test", audience: "outlet-app", kid: "k1", privateKey: keys.privateKey, publicKey: keys.publicKey };
    return { keys, s: new SessionService(db, cfg), cfg };
  };
  const nowS = Math.floor(T0.getTime() / 1000);
  const claims = { amr: ["otp"], sid: "sid" };
  const b64 = (o: object): string => Buffer.from(JSON.stringify(o)).toString("base64url");

  it("rejects alg none", async () => {
    await withTestDb(async (db) => {
      const { s } = await setupKeys(db);
      const tok = `${b64({ alg: "none", kid: "k1" })}.${b64({ ...claims, sub: "u", iss: "https://api.outlet.test", aud: "outlet-app", exp: nowS + 600 })}.`;
      expect(await code(s.verifyAccessToken(tok, T0))).toBe("ACCESS_TOKEN_INVALID");
    });
  });

  it("rejects HS256 signed with the public key bytes (algorithm confusion)", async () => {
    await withTestDb(async (db) => {
      const { s, keys } = await setupKeys(db);
      const pem = await exportSPKI(keys.publicKey);
      const tok = await new SignJWT(claims).setProtectedHeader({ alg: "HS256", kid: "k1" }).setIssuer("https://api.outlet.test")
        .setAudience("outlet-app").setSubject("u").setIssuedAt(nowS).setExpirationTime(nowS + 600).sign(new TextEncoder().encode(pem));
      expect(await code(s.verifyAccessToken(tok, T0))).toBe("ACCESS_TOKEN_INVALID");
    });
  });

  it("rejects wrong aud, wrong iss, expired and missing or wrong kid", async () => {
    await withTestDb(async (db) => {
      const { s, keys } = await setupKeys(db);
      const mk = (o: { aud?: string; iss?: string; exp?: number; kid?: string | null }) => {
        const header = o.kid === null ? { alg: "ES256" } : { alg: "ES256", kid: o.kid ?? "k1" };
        return new SignJWT(claims).setProtectedHeader(header).setIssuer(o.iss ?? "https://api.outlet.test").setAudience(o.aud ?? "outlet-app")
          .setSubject("u").setIssuedAt(nowS).setExpirationTime(o.exp ?? nowS + 600).sign(keys.privateKey);
      };
      expect(await code(s.verifyAccessToken(await mk({}), T0))).toBe("none"); // control: the helper itself is valid
      expect(await code(s.verifyAccessToken(await mk({ aud: "other" }), T0))).toBe("ACCESS_TOKEN_INVALID");
      expect(await code(s.verifyAccessToken(await mk({ iss: "https://evil.test" }), T0))).toBe("ACCESS_TOKEN_INVALID");
      expect(await code(s.verifyAccessToken(await mk({ exp: nowS - 1 }), T0))).toBe("ACCESS_TOKEN_INVALID");
      expect(await code(s.verifyAccessToken(await mk({ kid: null }), T0))).toBe("ACCESS_TOKEN_INVALID");
      expect(await code(s.verifyAccessToken(await mk({ kid: "k2" }), T0))).toBe("ACCESS_TOKEN_INVALID");
    });
  });
});

describe("revoke and list", () => {
  it("lists active sessions, revokes only for the owner, idempotently", async () => {
    await withTestDb(async (db) => {
      const s = await makeSessions(db);
      const u1 = await makeUserAndDevice(db, 1);
      const u2 = await makeUserAndDevice(db, 2);
      const a = await s.issue(u1.userId, u1.deviceId, { now: T0 });
      await s.issue(u1.userId, u1.deviceId, { now: at(10) });
      expect(await s.listSessions(u1.userId)).toHaveLength(2);
      expect(await s.revoke(a.sessionId, u2.userId, at(20))).toBe(false);
      expect(await s.revoke(a.sessionId, u1.userId, at(20))).toBe(true);
      expect(await s.revoke(a.sessionId, u1.userId, at(30))).toBe(false);
      expect(await s.listSessions(u1.userId)).toHaveLength(1);
      expect(await code(s.refresh(a.refreshToken, u1.deviceId, at(40)))).toBe("SESSION_REVOKED");
    });
  });
});

describe("property: rotation chain", () => {
  it("never has two valid refresh tokens at once, and old tokens are never accepted", async () => {
    await withTestDb(async (db) => {
      const s = await makeSessions(db);
      let n = 0;
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 1, max: 6 }), async (steps) => {
          n += 1;
          const { userId, deviceId } = await makeUserAndDevice(db, n);
          const first = await s.issue(userId, deviceId, { now: T0 });
          let cur = first;
          const old: string[] = [];
          for (let i = 0; i < steps; i++) {
            old.push(cur.refreshToken);
            cur = await s.refresh(cur.refreshToken, deviceId, at((i + 1) * 1000));
            const live = await db.query<{ n: string }>(
              "SELECT count(*)::text n FROM refresh_tokens WHERE family_id=$1 AND used_at IS NULL",
              [first.sessionId],
            );
            expect(live.rows[0]?.n).toBe("1");
          }
          const victim = old[Math.floor(old.length / 2)] ?? "";
          expect(await code(s.refresh(victim, deviceId, at(100_000)))).toBe("REFRESH_REUSE");
          const live = await db.query("SELECT 1 FROM session_families WHERE id=$1 AND revoked_at IS NULL", [first.sessionId]);
          expect(live.rows).toHaveLength(0);
        }),
        { numRuns: 12 },
      );
    });
  });
});
