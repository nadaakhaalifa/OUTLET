import { useRouter } from "expo-router";
import { VisualSearchScreen } from "../features/visual-search/VisualSearchScreen";
import { GuestGate } from "../features/me/GuestGate";

export default function Route() {
  const router = useRouter();
  return (
    <GuestGate feature="visualSearch">
      {() => (
        <VisualSearchScreen
          onBack={() => (router.canGoBack() ? router.back() : router.replace("/"))}
          onOpenProduct={(id) => router.push({ pathname: "/product/[id]", params: { id } })}
        />
      )}
    </GuestGate>
  );
}
