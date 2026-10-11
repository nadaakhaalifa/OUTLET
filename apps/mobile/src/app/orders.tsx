import { useRouter } from "expo-router";
import { OrdersScreen } from "../features/orders/OrdersScreen";

export default function Route() {
  const router = useRouter();
  return (
    <OrdersScreen
      onResumePayment={(id) => router.push({ pathname: "/checkout", params: { resume: id } })}
      onReturnLine={(lineId) => router.push({ pathname: "/returns", params: { line: lineId } })}
    />
  );
}
