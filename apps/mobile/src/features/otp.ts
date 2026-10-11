import { OTP_POLICY, resendDelayMs } from "../workspace";
import { toAsciiDigits } from "./phone";

export function sanitizeOtp(input: string): string {
  return toAsciiDigits(input).replace(/\D/g, "").slice(0, OTP_POLICY.digits);
}

export function isCompleteOtp(code: string): boolean {
  return code.length === OTP_POLICY.digits && /^\d+$/.test(code);
}

/** Whole seconds until a resend is allowed (0 = now). `sendsSoFar` includes the send that just happened. */
export function resendRemainingSeconds(sendsSoFar: number, lastSentAtMs: number, nowMs: number): number {
  const waitMs = resendDelayMs(sendsSoFar) - (nowMs - lastSentAtMs);
  return waitMs <= 0 ? 0 : Math.ceil(waitMs / 1000);
}

/** Client mirror of the per-phone cap so the UI stops offering resend; the server enforces it too. */
export function resendExhausted(sendsSoFar: number): boolean {
  return sendsSoFar >= OTP_POLICY.maxSendsPerPhonePerWindow;
}
