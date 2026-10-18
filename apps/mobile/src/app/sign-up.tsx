import { useLocalSearchParams } from "expo-router";
import { CheckoutGateScreen, useGateGuard } from "../features/checkout-gate";

/** The Checkout gate route (ADR-0055 R0). A direct open (deep link, push, outlet://) without a Checkout tap is sent to the tabs. */
export default function Route() {
  const { phase } = useLocalSearchParams<{ phase?: string }>();
  const allowed = useGateGuard(true, phase === "merge");
  if (!allowed) return null;
  return <CheckoutGateScreen phase={typeof phase === "string" ? phase : undefined} />;
}
