import { Stack, useSegments } from "expo-router";
import { useGateGuard } from "../../features/checkout-gate";

/** Routes that create an account: only reachable from the Checkout gate or an interrupted sign-up (owner rule R0). */
const ACCOUNT_ROUTES: readonly string[] = ["account", "otp", "consents"];

export default function OnboardingLayout() {
  const segments: readonly string[] = useSegments();
  const guarded = ACCOUNT_ROUTES.includes(segments[segments.length - 1] ?? "");
  const allowed = useGateGuard(guarded);
  // Back gestures are disabled: a refused age check must not be retried by swiping back.
  if (guarded && !allowed) return null;
  return <Stack screenOptions={{ headerShown: false, gestureEnabled: false }} />;
}
