import type { Queryable } from "@outlet/db";

export interface PurgeCounts {
  readonly otpChallenges: number;
  readonly rateLimitHits: number;
  readonly refreshTokens: number;
  readonly ageBlocks: number;
  readonly passkeyChallenges: number;
}

/** Grace periods keep recent rows for support and for reuse detection on just-expired tokens. */
export const PURGE_OTP_GRACE_MS = 24 * 60 * 60_000;
/** Matches retention_policies 'rate_limit_48h' seeded in migration 0004 (keep both in sync). */
export const PURGE_RATE_LIMIT_MS = 48 * 60 * 60_000;
/** Matches migration 0024 (worker policy passkey_challenges__worker_auth_purge). */
export const PURGE_PASSKEY_CHALLENGE_GRACE_MS = 60 * 60_000;
export const PURGE_REFRESH_GRACE_MS = 7 * 24 * 60 * 60_000;

const deleted = async (db: Queryable, table: string, column: string, cutoff: Date): Promise<number> => {
  // table and column are compile-time constants below, never caller input.
  const r = await db.query<{ n: string }>(
    `WITH d AS (DELETE FROM ${table} WHERE ${column} < $1 RETURNING 1) SELECT count(*)::text AS n FROM d`,
    [cutoff.toISOString()],
  );
  return Number(r.rows[0]?.n ?? "0");
};

/**
 * Deletes expired OTP challenges, stale rate-limit hits and long-expired refresh tokens.
 * No scheduler yet: callers (a future worker) invoke it periodically. Idempotent.
 */
export const purgeExpired = async (db: Queryable, now: Date): Promise<PurgeCounts> => ({
  otpChallenges: await deleted(db, "otp_challenges", "expires_at", new Date(now.getTime() - PURGE_OTP_GRACE_MS)),
  rateLimitHits: await deleted(db, "rate_limit_hits", "hit_at", new Date(now.getTime() - PURGE_RATE_LIMIT_MS)),
  refreshTokens: await deleted(db, "refresh_tokens", "expires_at", new Date(now.getTime() - PURGE_REFRESH_GRACE_MS)),
  ageBlocks: await deleted(db, "age_blocks", "blocked_until", now),
  passkeyChallenges: await deleted(db, "passkey_challenges", "expires_at", new Date(now.getTime() - PURGE_PASSKEY_CHALLENGE_GRACE_MS)),
});
