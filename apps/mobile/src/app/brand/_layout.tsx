import { Stack } from "expo-router";
import { BrandApplyProvider } from "../../features/brand-apply/context";

/** Brand application flow. `/brand` is the entry; `/brand/status` is the push / deep-link target. */
export default function BrandLayout() {
  return (
    <BrandApplyProvider>
      <Stack screenOptions={{ headerShown: false, animation: "fade_from_bottom", animationDuration: 300 }} />
    </BrandApplyProvider>
  );
}
