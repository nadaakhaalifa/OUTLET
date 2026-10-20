import { useRouter } from "expo-router";
import { OrdersScreen } from "../features/orders/OrdersScreen";
import { GuestGate } from "../features/me/GuestGate";

export default function Route() {
  const router = useRouter();
  return (
    <GuestGate feature="orders">
      {() => (
        <OrdersScreen
          onResumePayment={(id) => router.push({ pathname: "/checkout", params: { resume: id } })}
          onReturnLine={(lineId) => router.push({ pathname: "/returns", params: { line: lineId } })}
          onShop={() => router.navigate("/")}
          onBack={() => (router.canGoBack() ? router.back() : router.replace("/(tabs)/me"))}
        />
      )}
    </GuestGate>
  );
}
