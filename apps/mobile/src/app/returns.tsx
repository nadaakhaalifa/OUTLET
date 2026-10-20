import { useLocalSearchParams, useRouter } from "expo-router";
import { ReturnsScreen } from "../features/returns/ReturnsScreen";
import { GuestGate } from "../features/me/GuestGate";

export default function Route() {
  const router = useRouter();
  const { line } = useLocalSearchParams<{ line?: string }>();
  return (
    <GuestGate feature="returns">
      {() => (
        <ReturnsScreen
          orderLineId={typeof line === "string" ? line : ""}
          onBack={() => router.back()}
          onViewOrders={() => router.replace("/orders")}
        />
      )}
    </GuestGate>
  );
}
