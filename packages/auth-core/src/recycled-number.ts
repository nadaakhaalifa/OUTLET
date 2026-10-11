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

/**
 * OTP login on a number unused for more than 180 days on a device not previously linked to
 * the account needs a second factor (email link or passkey) before any stored value is shown.
 * lastUsedAtMs null (never recorded) is treated as stale. With no factor enrolled the user may
 * proceed but sees no stored value; support recovery is a product decision (see report).
 */
export function evaluateRecycledNumber(input: {
  lastUsedAtMs: number | null;
  nowMs: number;
  deviceKnownToAccount: boolean;
  hasVerifiedEmail: boolean;
  hasPasskey: boolean;
}): RecycledNumberDecision {
  const stale = input.lastUsedAtMs === null || input.nowMs - input.lastUsedAtMs > RECYCLED_NUMBER_THRESHOLD_MS;
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
