export const ADMISSION_TTL_MS = 15 * 60_000;
export const HEARTBEAT_TTL_MS = 30_000;

export interface AdmissionClaims {
  readonly jti: string;
  readonly dropId: string;
  readonly userId: string;
  readonly deviceHash: string;
  readonly iatMs: number;
  readonly expMs: number;
}

export type ClaimsVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "expired" | "not_yet_valid" | "wrong_drop" | "wrong_user" | "wrong_device" | "bad_lifetime" };

/** Token binding (spec: bound to user+device+drop, 15 min). Server time only. */
export function checkAdmissionClaims(
  c: AdmissionClaims,
  expected: { readonly dropId: string; readonly userId: string; readonly deviceHash: string },
  nowMs: number,
): ClaimsVerdict {
  if (c.expMs - c.iatMs !== ADMISSION_TTL_MS) return { ok: false, code: "bad_lifetime" };
  if (nowMs >= c.expMs) return { ok: false, code: "expired" };
  if (nowMs < c.iatMs) return { ok: false, code: "not_yet_valid" };
  if (c.dropId !== expected.dropId) return { ok: false, code: "wrong_drop" };
  if (c.userId !== expected.userId) return { ok: false, code: "wrong_user" };
  if (c.deviceHash !== expected.deviceHash) return { ok: false, code: "wrong_device" };
  return { ok: true };
}

export interface BotConfig {
  readonly blockAtOrAbove: number;
  readonly challengeAtOrAbove: number;
}
export const DEFAULT_BOT_CONFIG: BotConfig = { blockAtOrAbove: 80, challengeAtOrAbove: 60 };

/** Score 0 (human) .. 100 (bot). An invalid score fails closed. */
export function decideBot(score: number, c: BotConfig = DEFAULT_BOT_CONFIG): "allow" | "challenge" | "block" {
  if (!Number.isFinite(score) || score < 0 || score > 100) return "block";
  if (score >= c.blockAtOrAbove) return "block";
  if (score >= c.challengeAtOrAbove) return "challenge";
  return "allow";
}
