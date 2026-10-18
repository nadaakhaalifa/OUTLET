import { Stack, useLocalSearchParams } from "expo-router";
import { useCheckoutSessionGuard } from "../../features/checkout/sessionGuard";
import { CheckoutSessionProvider, useCheckoutSession } from "../../features/checkout/CheckoutSession";

function Steps() {
  const { locked } = useCheckoutSession();
  // Native edge swipe goes back one step; it is disabled only while the order is being placed.
  return <Stack screenOptions={{ headerShown: false, gestureEnabled: !locked }} />;
}

/** One provider for the whole checkout (ADR-0053): quote, selection, idempotency key and admission token live here. */
export default function CheckoutLayout() {
  const { resume, drop } = useLocalSearchParams<{ resume?: string; drop?: string }>();
  const allowed = useCheckoutSessionGuard();
  if (!allowed) return null;
  return (
    <CheckoutSessionProvider
      {...(typeof resume === "string" && resume.length > 0 ? { resumeOrderGroupId: resume } : {})}
      {...(typeof drop === "string" && drop.length > 0 ? { dropId: drop } : {})}
    >
      <Steps />
    </CheckoutSessionProvider>
  );
}
