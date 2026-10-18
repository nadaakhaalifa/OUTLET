import { useCallback } from "react";
import { useRouter, type Href } from "expo-router";
import { useServices } from "../../state/services";
import { openCheckoutGate } from "./model";

/** What the Bag's Checkout button calls. */
export function useCheckoutEntry(): () => void {
  const router = useRouter();
  const services = useServices();
  return useCallback(() => {
    void openCheckoutGate({
      hasSession: async () => (await services.tokens.load()) !== null,
      isOnboardingDone: () => services.isOnboardingDone(),
      push: (href) => router.push(href as Href),
    });
  }, [router, services]);
}
