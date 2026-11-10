import { createHmac, randomBytes } from "node:crypto";
import { contextClient, narrowContext } from "@outlet/db";
import type { SqlClient } from "@outlet/db";
import { uuidv7 } from "@outlet/ids";
import { SignJWT, jwtVerify } from "jose";
import { sha256 } from "./crypto.js";
import { AuthError } from "./errors.js";

export const ACCESS_TTL_S = 10 * 60;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60_000;
export const DEFAULT_ABSOLUTE_MAX_DAYS = 90;

export type Amr = "otp" | "apple" | "google" | "passkey";

export interface SessionConfig {
  /** Market this service instance runs in; it pins the database context (ADR-0011). */
  readonly marketId: string;
  readonly issuer: string;
  readonly audience: string;
  readonly kid: string;
  readonly privateKey: CryptoKey;
  readonly publicKey: CryptoKey;
  /** Hard cap on a session family's lifetime, however often it rotates. Default 90. */
  readonly absoluteMaxDays?: number;
  /** Server key for the 10 s refresh grace window (successor token is re-derived, never stored raw). Absent: no grace, every reuse revokes. */
  readonly refreshGraceKey?: Uint8Array;
}

/** A rotated refresh token may be presented once more within this window and gets the same successor pair back (cross-instance race). */
export const REFRESH_GRACE_MS = 10_000;

export interface IssuedSession {
  readonly sessionId: string;
  readonly accessToken: string;
  readonly accessExpiresAt: Date;
  readonly refreshToken: string;
  readonly refreshExpiresAt: Date;
}

export interface AccessClaims {
  readonly userId: string;
  readonly sessionId: string;
  readonly amr: readonly string[];
  readonly expiresAt: Date;
}

export interface SessionSummary {
  readonly id: string;
  readonly deviceId: string;
  readonly amr: string[];
  readonly createdAt: Date;
}

const newRefreshToken = (): { token: string; hash: Buffer } => {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: sha256(token) };
};

interface Row {
  id: string;
  token_hash: Buffer;
  successor_hash: Buffer | null;
  grace_used_at: Date | null;
  family_id: string;
  rotation_no: number;
  used_at: Date | null;
  expires_at: Date;
  user_id: string;
  device_id: string;
  amr: string[];
  revoked_at: Date | null;
  family_created_at: Date;
}

interface GraceOk { kind: "ok"; userId: string; amr: string[]; familyId: string; exp: Date; rt: string; iat: Date; jti?: string }

type Tx = Parameters<Parameters<SqlClient["transaction"]>[0]>[0];

export class SessionService {
  constructor(private readonly db: SqlClient, private readonly cfg: SessionConfig) {}

  /** Auth-role context for this market with the given lookup keys (and optionally the known user). */
  private scoped(auth: { deviceId?: string; tokenHash?: Buffer }, userId?: string): SqlClient {
    return contextClient(this.db, {
      kind: "auth",
      marketId: this.cfg.marketId,
      ...(userId !== undefined ? { userId } : {}),
      auth: {
        ...(auth.deviceId !== undefined ? { deviceId: auth.deviceId } : {}),
        ...(auth.tokenHash !== undefined ? { tokenHash: auth.tokenHash.toString("hex") } : {}),
      },
    });
  }

  private async signAccess(userId: string, familyId: string, amr: readonly string[], now: Date, jti?: string): Promise<{ jwt: string; exp: Date }> {
    const iat = Math.floor(now.getTime() / 1000);
    const jwt = await new SignJWT({ amr: [...amr], sid: familyId })
      .setProtectedHeader({ alg: "ES256", kid: this.cfg.kid })
      .setSubject(userId)
      .setIssuer(this.cfg.issuer)
      .setAudience(this.cfg.audience)
      .setIssuedAt(iat)
      .setExpirationTime(iat + ACCESS_TTL_S)
      .setJti(jti ?? uuidv7(now.getTime()))
      .sign(this.cfg.privateKey);
    return { jwt, exp: new Date((iat + ACCESS_TTL_S) * 1000) };
  }

  async issue(userId: string, deviceId: string, opts: { amr?: readonly Amr[]; now?: Date } = {}): Promise<IssuedSession> {
    const now = opts.now ?? new Date();
    const amr = opts.amr ?? ["otp"];
    const familyId = uuidv7(now.getTime());
    const rt = newRefreshToken();
    const absoluteEnd = now.getTime() + (this.cfg.absoluteMaxDays ?? DEFAULT_ABSOLUTE_MAX_DAYS) * 86_400_000;
    const refreshExpiresAt = new Date(Math.min(now.getTime() + REFRESH_TTL_MS, absoluteEnd));
    await this.scoped({ deviceId }).transaction(async (tx) => {
      // The user is known (the caller verified them): bind it, then act. The device filter keeps the new family visible.
      await narrowContext(tx, { userId });
      await tx.query(
        "INSERT INTO session_families (id, user_id, device_id, amr, created_at) VALUES ($1,$2,$3,$4,$5)",
        [familyId, userId, deviceId, amr, now.toISOString()],
      );
      // The device now belongs to the last user who signed in on it.
      await tx.query("UPDATE devices SET user_id = $1, last_seen_at = $3 WHERE id = $2", [userId, deviceId, now.toISOString()]);
      await tx.query(
        "INSERT INTO refresh_tokens (id, family_id, token_hash, rotation_no, issued_at, expires_at) VALUES ($1,$2,$3,1,$4,$5)",
        [uuidv7(now.getTime()), familyId, rt.hash, now.toISOString(), refreshExpiresAt.toISOString()],
      );
    });
    const a = await this.signAccess(userId, familyId, amr, now);
    return { sessionId: familyId, accessToken: a.jwt, accessExpiresAt: a.exp, refreshToken: rt.token, refreshExpiresAt };
  }

  /** Rotates the refresh token. A token that was already used revokes the whole family. */
  async refresh(token: string, deviceId: string, now: Date = new Date()): Promise<IssuedSession> {
    const hash = sha256(token);
    const outcome = await this.scoped({ deviceId, tokenHash: hash }).transaction(async (tx: Tx): Promise<
      { kind: "err"; code: "REFRESH_INVALID" | "REFRESH_EXPIRED" | "REFRESH_REUSE" | "SESSION_REVOKED" } | { kind: "ok"; userId: string; amr: string[]; familyId: string; exp: Date; rt: string; iat: Date; jti?: string }
    > => {
      const r = await tx.query<Row>(
        `SELECT t.id, t.token_hash, t.successor_hash, t.grace_used_at, t.family_id, t.rotation_no, t.used_at, t.expires_at, f.user_id, f.device_id, f.amr, f.revoked_at, f.created_at AS family_created_at
         FROM refresh_tokens t JOIN session_families f ON f.id = t.family_id
         WHERE t.token_hash = $1 FOR UPDATE OF t`,
        [hash],
      );
      const row = r.rows[0];
      if (!row) return { kind: "err", code: "REFRESH_INVALID" };
      await narrowContext(tx, { userId: row.user_id });
      if (row.device_id !== deviceId) {
        // A real token on the wrong device means the token leaked: kill the family, answer opaquely.
        await this.revokeFamily(tx, row.family_id, "reuse_detected", now);
        return { kind: "err", code: "REFRESH_INVALID" };
      }
      if (row.revoked_at) return { kind: "err", code: "SESSION_REVOKED" };
      if (row.used_at) {
        const graced = await this.grace(tx, row, now);
        if (graced !== null) return graced;
        await this.revokeFamily(tx, row.family_id, "reuse_detected", now);
        return { kind: "err", code: "REFRESH_REUSE" };
      }
      const absoluteEnd = row.family_created_at.getTime() + (this.cfg.absoluteMaxDays ?? DEFAULT_ABSOLUTE_MAX_DAYS) * 86_400_000;
      if (now.getTime() >= absoluteEnd) {
        await this.revokeFamily(tx, row.family_id, "absolute_expiry", now);
        return { kind: "err", code: "REFRESH_EXPIRED" };
      }
      if (row.expires_at.getTime() <= now.getTime()) return { kind: "err", code: "REFRESH_EXPIRED" };
      const rt = this.successorToken(row.token_hash) ?? newRefreshToken();
      await tx.query("UPDATE refresh_tokens SET used_at = $2, successor_hash = $3 WHERE id = $1", [row.id, now.toISOString(), rt.hash]);
      const exp = new Date(Math.min(now.getTime() + REFRESH_TTL_MS, absoluteEnd));
      await tx.query(
        "INSERT INTO refresh_tokens (id, family_id, token_hash, rotation_no, issued_at, expires_at) VALUES ($1,$2,$3,$4,$5,$6)",
        [uuidv7(now.getTime()), row.family_id, rt.hash, row.rotation_no + 1, now.toISOString(), exp.toISOString()],
      );
      return { kind: "ok", userId: row.user_id, amr: row.amr, familyId: row.family_id, exp, rt: rt.token, iat: now };
    });
    if (outcome.kind === "err") throw new AuthError(outcome.code, `refresh failed: ${outcome.code}`);
    const a = await this.signAccess(outcome.userId, outcome.familyId, outcome.amr, outcome.iat, outcome.jti);
    return { sessionId: outcome.familyId, accessToken: a.jwt, accessExpiresAt: a.exp, refreshToken: outcome.rt, refreshExpiresAt: outcome.exp };
  }

  /** Deterministic successor refresh token for a predecessor hash (null when no grace key is configured). */
  private successorToken(predecessor: Buffer): { token: string; hash: Buffer } | null {
    const key = this.cfg.refreshGraceKey;
    if (key === undefined) return null;
    const token = createHmac("sha256", key).update("refresh-successor:").update(predecessor).digest("base64url");
    return { token, hash: sha256(token) };
  }

  /**
   * A used token presented within REFRESH_GRACE_MS of its rotation, for the first time since, gets the SAME successor pair
   * (same refresh token, same access claims). Anything else (late, second grace use, no key, hash mismatch) is reuse.
   */
  private async grace(tx: Tx, row: Row, now: Date): Promise<Extract<GraceOk, { kind: "ok" }> | null> {
    const succ = this.successorToken(row.token_hash);
    if (succ === null || row.used_at === null || row.successor_hash === null || row.grace_used_at !== null) return null;
    if (!Buffer.from(row.successor_hash).equals(succ.hash)) return null;
    const age = now.getTime() - row.used_at.getTime();
    if (age < 0 || age > REFRESH_GRACE_MS) return null;
    await tx.query("UPDATE refresh_tokens SET grace_used_at = $2 WHERE id = $1", [row.id, now.toISOString()]);
    const absoluteEnd = row.family_created_at.getTime() + (this.cfg.absoluteMaxDays ?? DEFAULT_ABSOLUTE_MAX_DAYS) * 86_400_000;
    const h = succ.hash.toString("hex");
    return {
      kind: "ok", userId: row.user_id, amr: row.amr, familyId: row.family_id, rt: succ.token, iat: row.used_at,
      exp: new Date(Math.min(row.used_at.getTime() + REFRESH_TTL_MS, absoluteEnd)),
      jti: `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`,
    };
  }

  /**
   * Logout without a valid access token: revokes the family that owns the presented refresh token (any device, any state).
   * Idempotent; the caller answers 204 whether or not the token was known.
   */
  async revokeByRefreshToken(token: string, deviceId: string, now: Date = new Date()): Promise<boolean> {
    const hash = sha256(token);
    const r = await this.scoped({ deviceId, tokenHash: hash }).query(
      `UPDATE session_families SET revoked_at = $2, revoke_reason = 'logout'
        WHERE id IN (SELECT family_id FROM refresh_tokens WHERE token_hash = $1) AND revoked_at IS NULL RETURNING id`,
      [hash, now.toISOString()],
    );
    return r.rows.length > 0;
  }

  private async revokeFamily(tx: Tx, familyId: string, reason: string, now: Date): Promise<void> {
    await tx.query(
      "UPDATE session_families SET revoked_at = $2, revoke_reason = $3 WHERE id = $1 AND revoked_at IS NULL",
      [familyId, now.toISOString(), reason],
    );
  }

  /** Idempotent logout. Scoped to the owner so one user cannot revoke another's session. */
  async revoke(sessionId: string, userId: string, now: Date = new Date()): Promise<boolean> {
    const r = await this.scoped({}, userId).query(
      "UPDATE session_families SET revoked_at = $3, revoke_reason = 'logout' WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id",
      [sessionId, userId, now.toISOString()],
    );
    return r.rows.length > 0;
  }

  async listSessions(userId: string): Promise<SessionSummary[]> {
    const r = await this.scoped({}, userId).query<{ id: string; device_id: string; amr: string[]; created_at: Date }>(
      "SELECT id, device_id, amr, created_at FROM session_families WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC",
      [userId],
    );
    return r.rows.map((x) => ({ id: x.id, deviceId: x.device_id, amr: x.amr, createdAt: x.created_at }));
  }

  async verifyAccessToken(jwt: string, now: Date = new Date()): Promise<AccessClaims> {
    try {
      const { payload, protectedHeader } = await jwtVerify(jwt, this.cfg.publicKey, {
        issuer: this.cfg.issuer,
        audience: this.cfg.audience,
        algorithms: ["ES256"],
        currentDate: now,
        requiredClaims: ["sub", "exp", "sid"],
      });
      if (protectedHeader.kid !== this.cfg.kid) throw new AuthError("ACCESS_TOKEN_INVALID", "unexpected key id");
      const amr = payload.amr;
      const sid = payload.sid;
      if (typeof payload.sub !== "string" || typeof sid !== "string" || !Array.isArray(amr) || payload.exp === undefined) {
        throw new AuthError("ACCESS_TOKEN_INVALID", "malformed claims");
      }
      return { userId: payload.sub, sessionId: sid, amr: amr.map(String), expiresAt: new Date(payload.exp * 1000) };
    } catch (e) {
      if (e instanceof AuthError) throw e;
      throw new AuthError("ACCESS_TOKEN_INVALID", "access token rejected");
    }
  }
}
