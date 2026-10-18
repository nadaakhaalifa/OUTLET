import { useEffect, useState } from "react";
import { useRouter, type Href } from "expo-router";
import { useServices } from "../../state/services";
import { resolveGateAccess } from "./access";

/**
 * Runtime guard for every route that creates an account. Returns true once access is confirmed (sticky for the life
 * of the screen); otherwise redirects to the tabs and returns false, so render nothing while it is false.
 * Pass `enabled = false` for routes that do not create accounts.
 */
export function useGateGuard(enabled = true, mergePhase = false): boolean {
  const router = useRouter();
  const services = useServices();
  const [allowed, setAllowed] = useState(!enabled);
  useEffect(() => {
    if (!enabled || allowed) return;
    let alive = true;
    void resolveGateAccess({
      hasSession: async () => (await services.tokens.load()) !== null,
      isOnboardingDone: () => services.isOnboardingDone(),
      otpInProgress: () => services.session.phoneE164 !== null,
      mergePhase,
    }).then((ok) => {
      if (!alive) return;
      if (ok) setAllowed(true);
      else router.replace("/(tabs)" as Href);
    }, () => { if (alive) router.replace("/(tabs)" as Href); });
    return () => { alive = false; };
  }, [enabled, allowed, mergePhase, router, services]);
  return allowed;
}
