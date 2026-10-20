/** Device guest consent decisions are flushed for brand-new accounts only (an existing member's choices stand). */
export function shouldFlushConsents(isNewAccount: boolean): boolean {
  return isNewAccount;
}

/** A 401 means the session is gone: send the shopper back to sign-in instead of offering checkout without the merge. */
export function offersContinueWithout(status: number): boolean {
  return status !== 401;
}
