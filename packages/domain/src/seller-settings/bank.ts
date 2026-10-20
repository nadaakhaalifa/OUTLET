export const PAYOUT_ACCOUNT_COOLING_MS = 48 * 3_600_000;
/** A bank change needs a strong factor verified within this window (step-up, T5). */
export const BANK_CHANGE_STRONG_FACTOR_MAX_AGE_SEC = 300;

export const PAYOUT_ACCOUNT_STATES = ["ACTIVE", "SUPERSEDED"] as const;
export type PayoutAccountState = (typeof PAYOUT_ACCOUNT_STATES)[number];

/** First account is usable at once; a replacement is held for 48 h so a hijacked session cannot redirect funds quickly. */
export function activationTimeFor(nowMs: number, hasExistingAccount: boolean): number {
  return hasExistingAccount ? nowMs + PAYOUT_ACCOUNT_COOLING_MS : nowMs;
}

export interface PayoutHoldView {
  readonly held: boolean;
  readonly untilMs: number | null;
}
export function payoutHold(activatesAtMs: number, nowMs: number): PayoutHoldView {
  return nowMs < activatesAtMs ? { held: true, untilMs: activatesAtMs } : { held: false, untilMs: null };
}

/** Never more than the last four characters of an IBAN leave the server. */
export function maskIban(last4: string): string {
  return `EG** **** **** **** **** **** ${last4}`;
}
