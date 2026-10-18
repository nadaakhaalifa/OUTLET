import { useRouter } from "expo-router";
import { AutoBuyScreen } from "../features/auto-buy/AutoBuyScreen";
import { GuestGate } from "../features/me/GuestGate";

export default function Route() {
  const router = useRouter();
  return (
    <GuestGate feature="autoBuy">
      {() => (
        <AutoBuyScreen
          onBack={() => (router.canGoBack() ? router.back() : router.replace("/"))}
          onOpenProduct={(id) => router.push({ pathname: "/product/[id]", params: { id } })}
        />
      )}
    </GuestGate>
  );
}
