import { useEffect, useState } from "react";
import { useRouter, type Href } from "expo-router";
import { useServices } from "../../state/services";
import { resolveCheckoutAccess } from "./sessionAccess";

/**
 * Guard for every /checkout/* route (ADR-0055). A guest deep link goes to the Bag tab, never to sign-up: account
 * creation is offered only by the Bag's Checkout tap. Returns true once access is confirmed (sticky); render nothing
 * while false so no checkout content flashes.
 */
export function useCheckoutSessionGuard(): boolean {
  const router = useRouter();
  const services = useServices();
  const [allowed, setAllowed] = useState(false);
  useEffect(() => {
    if (allowed) return;
    let alive = true;
    const toBag = () => { if (alive) router.replace("/(tabs)/bag" as Href); };
    void resolveCheckoutAccess({
      hasSession: async () => (await services.tokens.load()) !== null,
      isOnboardingDone: () => services.isOnboardingDone(),
    }).then((ok) => { if (!alive) return; if (ok) setAllowed(true); else toBag(); }, toBag);
    return () => { alive = false; };
  }, [allowed, router, services]);
  return allowed;
}
