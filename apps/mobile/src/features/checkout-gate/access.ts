import { peekReturnTarget } from "../flow";

export interface GateAccessFacts {
  /** Set by the Bag's Checkout tap (or by the merge phase). */
  readonly returnTarget: string | null;
  readonly hasSession: boolean;
  readonly onboardingDone: boolean;
  /** An OTP was requested in this process (in-flight sign-up). */
  readonly otpInProgress: boolean;
  /** The merge step right after sign-up: the account is finished by then, and only the return target keeps it open. */
  readonly mergePhase?: boolean;
}

/**
 * Who may see a create-account route (owner rule R0). A deep link, push payload or outlet:// URL must not land a guest
 * on sign-up. Allowed: the Checkout gate is open (return target set), a sign-up is in flight in this process, or a
 * signed-up account has not finished onboarding (an interrupted sign-up always resumes, never trapped).
 * Denied: a guest with none of these, and a fully onboarded account.
 */
export function gateAccessAllowed(f: GateAccessFacts): boolean {
  // A fully onboarded member has no reason to see a create-account route, even if an in-flight marker is still set.
  if (f.hasSession && f.onboardingDone) return f.mergePhase === true && f.returnTarget !== null;
  // The merge phase needs a live session: without one it is not reachable.
  if (f.mergePhase === true && !f.hasSession) return false;
  return f.returnTarget !== null || f.otpInProgress || (f.hasSession && !f.onboardingDone);
}

export interface GateAccessDeps {
  hasSession(): Promise<boolean>;
  isOnboardingDone(): Promise<boolean>;
  otpInProgress(): boolean;
  mergePhase?: boolean;
}

export async function resolveGateAccess(deps: GateAccessDeps): Promise<boolean> {
  const hasSession = await deps.hasSession();
  const onboardingDone = hasSession ? await deps.isOnboardingDone() : false;
  return gateAccessAllowed({ returnTarget: peekReturnTarget(), hasSession, onboardingDone, otpInProgress: deps.otpInProgress(), mergePhase: deps.mergePhase === true });
}
