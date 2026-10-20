import { MS } from "./ports";

export const RECYCLED_NUMBER_THRESHOLD_MS = 180 * MS.day;

export type SecondFactor = "email_link" | "passkey";

export type RecycledNumberDecision = {
  readonly secondFactorRequired: boolean;
  readonly acceptableFactors: readonly SecondFactor[];
  /** Whether wallet, store credit, saved addresses, orders may be shown right after OTP. */
  readonly storedValueVisible: boolean;
  readonly reason: "known_device" | "recently_used" | "stale_account_new_device" | "stale_account_no_factor_available";
};

/** True when the account has no recorded activity or was last used more than 180 days before `nowMs`. */
export function isRecycledNumberStale(lastUsedAtMs: number | null, nowMs: number): boolean {
  return lastUsedAtMs === null || nowMs - lastUsedAtMs > RECYCLED_NUMBER_THRESHOLD_MS;
}

/**
 * Pure domain rule: OTP login on a number unused for more than 180 days on a device not previously linked
 * to the account needs a second factor (email link or passkey) before any stored value is shown.
 * lastUsedAtMs null (never recorded) is treated as stale. In this pure rule, with no factor enrolled the
 * user may proceed but sees no stored value (`storedValueVisible: false`).
 *
 * Production (apps/api RecycledNumberStepUp) is STRICTER: it passes hasVerifiedEmail=false and
 * hasPasskey=false so the answer never depends on the account, and it uses only `secondFactorRequired`:
 * when true, NO session or token is issued until a passkey assertion bound to the account succeeds. It
 * never takes the "proceed but hide stored value" branch. "Device known" there also needs the attested
 * device key to match, not just the install id.
 */
export function evaluateRecycledNumber(input: {
  lastUsedAtMs: number | null;
  nowMs: number;
  deviceKnownToAccount: boolean;
  hasVerifiedEmail: boolean;
  hasPasskey: boolean;
}): RecycledNumberDecision {
  const stale = isRecycledNumberStale(input.lastUsedAtMs, input.nowMs);
  if (input.deviceKnownToAccount) {
    return { secondFactorRequired: false, acceptableFactors: [], storedValueVisible: true, reason: "known_device" };
  }
  if (!stale) {
    return { secondFactorRequired: false, acceptableFactors: [], storedValueVisible: true, reason: "recently_used" };
  }
  const factors: SecondFactor[] = [];
  if (input.hasVerifiedEmail) factors.push("email_link");
  if (input.hasPasskey) factors.push("passkey");
  return {
    secondFactorRequired: true,
    acceptableFactors: factors,
    storedValueVisible: false,
    reason: factors.length === 0 ? "stale_account_no_factor_available" : "stale_account_new_device",
  };
}
