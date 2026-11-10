import { randomInt } from "node:crypto";
import { contextClient, narrowContext } from "@outlet/db";
import type { SqlClient } from "@outlet/db";
import { uuidv7 } from "@outlet/ids";
import { z } from "zod";
import { assessAge } from "./age.js";
import { DEFAULT_MARKET_POLICIES, type AuthDeps, type MarketAuthPolicy } from "./config.js";
import { safeEqual } from "./crypto.js";
import { AuthError } from "./errors.js";
import type { RateLimiter, SmsSender } from "./ports.js";

export const OTP_TTL_MS = 5 * 60_000;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_PHONE_LIMIT = 3;
export const OTP_PHONE_WINDOW_MS = 15 * 60_000;
export const OTP_DEVICE_LIMIT = 10;
export const OTP_DEVICE_WINDOW_MS = 24 * 60 * 60_000;
export const AGE_BLOCK_MS = 30 * 24 * 60 * 60_000;

const e164 = z.string().regex(/^\+[1-9]\d{7,14}$/);
const uuid = z.uuid();

export interface OtpRequestInput {
  phoneE164: string;
  deviceId: string;
  marketId: string;
  now: Date;
  purpose?: "login" | "verify_phone" | "step_up";
}

export interface OtpVerifyInput {
  challengeId: string;
  /** Market the challenge was requested in (from the request context); it pins the RLS context. */
  marketId: string;
  phoneE164: string;
  code: string;
  /** Must be the device the challenge was requested from. */
  deviceId: string;
  /** YYYY-MM-DD; required when the phone has no account yet. */
  dob?: string;
  now: Date;
}

export interface VerifiedUser {
  readonly userId: string;
  readonly isNew: boolean;
  readonly marketId: string;
}

interface ChallengeRow {
  id: string;
  market_id: string;
  phone_bidx: Buffer;
  code_hash: Buffer;
  attempts: number;
  expires_at: Date;
  verified_at: Date | null;
  device_id: string;
}

type Outcome =
  | { kind: "fail"; code: "OTP_NOT_FOUND" | "INVALID_DEVICE" | "OTP_EXPIRED" | "OTP_INVALID" | "OTP_LOCKED" | "OTP_CONSUMED"; msg: string }
  | { kind: "user"; user: VerifiedUser }
  | { kind: "underage" };

const rateLimited = (msg: string, retryAfterMs?: number): AuthError =>
  new AuthError("RATE_LIMITED", msg, retryAfterMs === undefined ? {} : { retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) });

export class OtpService {
  constructor(
    private readonly db: SqlClient,
    private readonly deps: AuthDeps,
    private readonly limiter: RateLimiter,
    private readonly sms: SmsSender,
    private readonly policies: Readonly<Record<string, MarketAuthPolicy>> = DEFAULT_MARKET_POLICIES,
  ) {}

  /** Auth-role context for one request: market pin plus the lookup keys the pre-auth policies match on. */
  private scoped(marketId: string, phoneBidx: Buffer, deviceId: string): SqlClient {
    return contextClient(this.db, {
      kind: "auth",
      marketId,
      auth: { phoneBidx: phoneBidx.toString("hex"), deviceId, deviceHash: this.deps.hasher.hmac("device", deviceId).toString("hex") },
    });
  }

  private codeHash(challengeId: string, code: string): Buffer {
    return this.deps.hasher.hmac("otp-code", `${challengeId}:${code}`);
  }

  /**
   * Requests a code. `deviceId` must be a registered, non-revoked device of the same market
   * (see registerDevice): a client-supplied id is never trusted on its own.
   * Known limit: the under-18 device block keys on that device id, so the real gate is device
   * registration (App Attest / Play Integrity at the HTTP layer, one device per install). A caller
   * that can register unlimited devices can still dodge the soft block.
   * Anti-pumping: a request consumes phone and device quota BEFORE the SMS is sent, and the quota is
   * deliberately not refunded when the provider fails, so repeated provider errors cannot be used to
   * probe or burn SMS spend without limit. RATE_LIMITED errors carry `retryAfterSeconds`.
   */
  async request(input: OtpRequestInput): Promise<{ challengeId: string; expiresAt: Date }> {
    const policy = this.policies[input.marketId];
    if (!policy) throw new AuthError("UNKNOWN_MARKET", "unknown market");
    if (!e164.safeParse(input.phoneE164).success) throw new AuthError("INVALID_PHONE", "phone must be E.164");
    if (!policy.allowedPhonePrefixes.some((p) => input.phoneE164.startsWith(p))) {
      throw new AuthError("UNSUPPORTED_COUNTRY", "phone country is not enabled in this market");
    }
    if (!policy.phonePattern.test(input.phoneE164)) throw new AuthError("INVALID_PHONE", "phone number is not valid for this market");
    if (!uuid.safeParse(input.deviceId).success) throw new AuthError("INVALID_DEVICE", "unknown device");
    const phoneBidx = this.deps.hasher.hmac("phone", `${input.marketId}:${input.phoneE164}`);
    const db = this.scoped(input.marketId, phoneBidx, input.deviceId);
    const dev = await db.query(
      "SELECT 1 FROM devices WHERE id = $1 AND market_id = $2 AND revoked_at IS NULL",
      [input.deviceId, input.marketId],
    );
    if (dev.rows.length === 0) throw new AuthError("INVALID_DEVICE", "unknown device");
    const byPhone = await this.limiter.hit(`otp:phone:${phoneBidx.toString("hex")}`, OTP_PHONE_LIMIT, OTP_PHONE_WINDOW_MS, input.now);
    if (!byPhone.allowed) throw rateLimited("too many codes requested for this phone", byPhone.retryAfterMs);
    const byDevice = await this.limiter.hit(`otp:device:${input.deviceId}`, OTP_DEVICE_LIMIT, OTP_DEVICE_WINDOW_MS, input.now);
    if (!byDevice.allowed) throw rateLimited("too many codes requested from this device", byDevice.retryAfterMs);

    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const id = uuidv7(input.now.getTime());
    const expiresAt = new Date(input.now.getTime() + OTP_TTL_MS);
    await db.query(
      `INSERT INTO otp_challenges (id, market_id, phone_bidx, purpose, code_hash, channel, provider, attempts, expires_at, device_id, created_at)
       VALUES ($1,$2,$3,$4,$5,'sms',$6,0,$7,$8,$9)`,
      [id, input.marketId, phoneBidx, input.purpose ?? "login", this.codeHash(id, code), this.sms.provider, expiresAt.toISOString(), input.deviceId, input.now.toISOString()],
    );
    try {
      await this.sms.send({ phoneE164: input.phoneE164, code, channel: "sms" });
    } catch {
      await db.query("DELETE FROM otp_challenges WHERE id = $1", [id]);
      throw new AuthError("OTP_SEND_FAILED", "could not deliver the code");
    }
    return { challengeId: id, expiresAt };
  }

  async verify(input: OtpVerifyInput): Promise<VerifiedUser> {
    if (!uuid.safeParse(input.deviceId).success) throw new AuthError("INVALID_DEVICE", "unknown device");
    const phoneBidx = this.deps.hasher.hmac("phone", `${input.marketId}:${input.phoneE164}`);
    const result = await this.scoped(input.marketId, phoneBidx, input.deviceId).transaction(async (tx): Promise<Outcome> => {
      const r = await tx.query<ChallengeRow>("SELECT * FROM otp_challenges WHERE id = $1 FOR UPDATE", [input.challengeId]);
      const row = r.rows[0];
      if (!row) return { kind: "fail", code: "OTP_NOT_FOUND", msg: "unknown challenge" };
      if (!safeEqual(phoneBidx, row.phone_bidx)) return { kind: "fail", code: "OTP_NOT_FOUND", msg: "unknown challenge" };
      if (row.verified_at) return { kind: "fail", code: "OTP_CONSUMED", msg: "code already used" };
      if (row.attempts >= OTP_MAX_ATTEMPTS) return { kind: "fail", code: "OTP_LOCKED", msg: "too many wrong codes" };
      if (row.expires_at.getTime() <= input.now.getTime()) return { kind: "fail", code: "OTP_EXPIRED", msg: "code expired" };
      if (row.device_id !== input.deviceId) {
        // A challenge is bound to the device it was requested from; a mismatch burns an attempt.
        await tx.query("UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = $1", [row.id]);
        return { kind: "fail", code: "INVALID_DEVICE", msg: "challenge belongs to another device" };
      }
      // The auth device-lookup policy only shows the presented device, which equals row.device_id here.
      const devOk = await tx.query("SELECT 1 FROM devices WHERE id = $1 AND revoked_at IS NULL", [row.device_id]);
      if (devOk.rows.length === 0) return { kind: "fail", code: "INVALID_DEVICE", msg: "device is not active" };
      if (!safeEqual(this.codeHash(row.id, input.code), row.code_hash)) {
        await tx.query("UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = $1", [row.id]);
        return { kind: "fail", code: "OTP_INVALID", msg: "wrong code" };
      }

      const existing = await tx.query<{ id: string; status: string }>(
        "SELECT id, status FROM users WHERE market_id = $1 AND phone_bidx = $2",
        [row.market_id, phoneBidx],
      );
      const u = existing.rows[0];
      if (u) {
        if (u.status !== "active" && u.status !== "deletion_pending") return { kind: "fail", code: "OTP_NOT_FOUND", msg: "account unavailable" };
        await narrowContext(tx, { userId: u.id });
        await tx.query("UPDATE otp_challenges SET verified_at = $2 WHERE id = $1", [row.id, input.now.toISOString()]);
        await tx.query("UPDATE users SET phone_verified_at = COALESCE(phone_verified_at, $2), updated_at = $2 WHERE id = $1", [u.id, input.now.toISOString()]);
        return { kind: "user", user: { userId: u.id, isNew: false, marketId: row.market_id } };
      }
      if (!input.dob) throw new AuthError("DOB_REQUIRED", "date of birth is required to register");
      const age = assessAge(input.dob, input.now);
      const deviceHash = this.deps.hasher.hmac("device", row.device_id);
      if (age.ageBand === "under_18_blocked") {
        // Only hashes are kept: no phone, no dob, no user row.
        const blockedUntil = new Date(input.now.getTime() + AGE_BLOCK_MS);
        await tx.query(
          "INSERT INTO age_blocks (id, market_id, device_hash, dob_hash, blocked_until, created_at) VALUES ($1,$2,$3,$4,$5,$6)",
          [uuidv7(input.now.getTime()), row.market_id, deviceHash, this.deps.hasher.hmac("dob", input.dob), blockedUntil.toISOString(), input.now.toISOString()],
        );
        await tx.query("UPDATE otp_challenges SET verified_at = $2 WHERE id = $1", [row.id, input.now.toISOString()]);
        return { kind: "underage" };
      }
      const blocked = await tx.query(
        "SELECT 1 FROM age_blocks WHERE device_hash = $1 AND blocked_until > $2 LIMIT 1",
        [deviceHash, input.now.toISOString()],
      );
      if (blocked.rows.length > 0) throw new AuthError("AGE_BLOCKED", "registration is blocked on this device");

      const userId = uuidv7(input.now.getTime());
      const ts = input.now.toISOString();
      await tx.query(
        `INSERT INTO users (id, market_id, status, phone_ct, phone_bidx, dob_ct, age_band, limited_capacity, locale, phone_verified_at, created_at, updated_at)
         VALUES ($1,$2,'active',$3,$4,$5,$6,$7,'ar-EG',$8,$8,$8)`,
        [userId, row.market_id, await this.deps.cipher.encrypt(input.phoneE164, "users.phone_ct"), phoneBidx, await this.deps.cipher.encrypt(input.dob, "users.dob_ct"), age.ageBand, age.limitedCapacity, ts],
      );
      await narrowContext(tx, { userId });
      await tx.query(
        "INSERT INTO age_attestations (id, user_id, market_id, attested_18_at, policy_version, method, created_at) VALUES ($1,$2,$3,$4,1,'self_attest',$4)",
        [uuidv7(input.now.getTime()), userId, row.market_id, ts],
      );
      await tx.query("UPDATE otp_challenges SET verified_at = $2 WHERE id = $1", [row.id, ts]);
      return { kind: "user", user: { userId, isNew: true, marketId: row.market_id } };
    });

    if (result.kind === "fail") throw new AuthError(result.code, result.msg);
    if (result.kind === "underage") throw new AuthError("UNDER_AGE", "you must be 18 or older");
    return result.user;
  }
}
