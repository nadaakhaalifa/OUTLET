import { useRouter } from "expo-router";
import { BagScreen } from "../../features/bag/BagScreen";

export default function Screen() {
  const router = useRouter();
  return <BagScreen onCheckout={() => router.push("/checkout")} />;
}
