/**
 * WebAuthn signature counter check (clone detection, spec T5 "counter and clone detection").
 * Authenticators that do not implement a counter always report 0; that is allowed only while the
 * stored value is also 0. Any non-increasing value once a counter has been seen is a rollback.
 */
export type SignCountCheck = { readonly ok: true } | { readonly ok: false; readonly reason: "sign_count_regression" };

export function checkSignCount(storedCount: number, presentedCount: number): SignCountCheck {
  if (storedCount === 0 && presentedCount === 0) return { ok: true };
  return presentedCount > storedCount ? { ok: true } : { ok: false, reason: "sign_count_regression" };
}
