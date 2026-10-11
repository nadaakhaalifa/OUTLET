import { useLocalSearchParams, useRouter } from "expo-router";
import { CheckoutScreen } from "../features/checkout/CheckoutScreen";

export default function Route() {
  const router = useRouter();
  const { resume, drop } = useLocalSearchParams<{ resume?: string; drop?: string }>();
  return (
    <CheckoutScreen
      {...(typeof resume === "string" && resume.length > 0 ? { resumeOrderGroupId: resume } : {})}
      {...(typeof drop === "string" && drop.length > 0 ? { dropId: drop } : {})}
      onViewOrders={() => router.replace("/orders")}
    />
  );
}
