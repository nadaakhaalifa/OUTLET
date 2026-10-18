import { CHECKOUT_STEP_ONE, setReturnTarget } from "../flow";

/** The one sign-up route (spec R0). Only this feature and the onboarding routes may name it. */
export const SIGN_UP_ROUTE = "/sign-up";
export const MERGE_PHASE_ROUTE = "/sign-up?phase=merge";

export interface GateEntryDeps {
  /** A stored session. */
  hasSession(): Promise<boolean>;
  /** The account finished its first sign-up (age, consents). A session without it resumes inside the gate. */
  isOnboardingDone(): Promise<boolean>;
  push(href: string): void;
}

/**
 * Bag "Checkout" tap. Signed-in shoppers go straight to Delivery; a guest (or a half-finished sign-up) gets the gate.
 * Resolves to where the shopper was sent.
 */
export async function openCheckoutGate(deps: GateEntryDeps): Promise<"checkout" | "gate"> {
  const signedIn = (await deps.hasSession()) && (await deps.isOnboardingDone());
  if (signedIn) {
    deps.push(CHECKOUT_STEP_ONE);
    return "checkout";
  }
  setReturnTarget(CHECKOUT_STEP_ONE);
  deps.push(SIGN_UP_ROUTE);
  return "gate";
}


export interface FlushDeps {
  readonly role: { flushFunnel?: () => unknown };
  readonly consent: { flushPending(): Promise<unknown> };
}

/**
 * After sign-up a session exists: send the guest consent decisions and the queued role funnel record. Failures are
 * swallowed (only the error class is logged) and never block checkout.
 */
export async function flushAfterSignUp(d: FlushDeps, log: (cls: string) => void = () => undefined): Promise<void> {
  const note = (e: unknown): void => log(e instanceof Error ? e.name : "unknown");
  try { await d.role.flushFunnel?.(); } catch (e) { note(e); }
  try { await d.consent.flushPending(); } catch (e) { note(e); }
}
