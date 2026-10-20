export interface CheckoutAccessDeps {
  hasSession(): Promise<boolean>;
  isOnboardingDone(): Promise<boolean>;
}

/** Same definition of "signed in" as the Bag's Checkout tap: a stored session AND a finished first sign-up. */
export async function resolveCheckoutAccess(deps: CheckoutAccessDeps): Promise<boolean> {
  if (!(await deps.hasSession())) return false;
  return deps.isOnboardingDone();
}
