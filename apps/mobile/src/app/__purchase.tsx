// DEV-ONLY preview of the purchase screens with forced language/theme: /__purchase?s=bag&lang=ar&theme=dark
import { useEffect } from "react";
import { Redirect, useLocalSearchParams } from "expo-router";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { ThemeProvider, useTheme } from "@outlet/ui-native";
import { BagScreen } from "../features/bag/BagScreen";
import { CheckoutSessionProvider } from "../features/checkout/CheckoutSession";
import { DeliveryStep } from "../features/checkout/DeliveryStep";
import { PaymentStep } from "../features/checkout/PaymentStep";
import { ReviewStep } from "../features/checkout/ReviewStep";
import { OrdersScreen } from "../features/orders/OrdersScreen";
import { ReturnsScreen } from "../features/returns/ReturnsScreen";
import { WishlistsScreen } from "../features/wishlists/WishlistsScreen";

function PurchasePreviewDev() {
  const parent = useTheme();
  const { i18n } = useTranslation();
  const q = useLocalSearchParams<{ s?: string; lang?: string; theme?: string }>();
  const lang = q.lang === "ar" ? "ar" : q.lang === "en" ? "en" : parent.isRTL ? "ar" : "en";
  useEffect(() => {
    void i18n.changeLanguage(lang);
  }, [i18n, lang]);
  useEffect(() => {
    if (q.theme === "light" || q.theme === "dark" || q.theme === "system") parent.setPreference(q.theme);
  }, [q.theme]);
  const s = q.s ?? "bag";
  return (
    <ThemeProvider preference={parent.preference} onPreferenceChange={parent.setPreference} isRTL={lang === "ar"} fontsLoaded={parent.fontsLoaded}>
      <View style={{ flex: 1, direction: lang === "ar" ? "rtl" : "ltr" }}>
        {s === "bag" ? <BagScreen onCheckout={() => undefined} onShop={() => undefined} /> : null}
        {s === "checkout" ? <CheckoutSessionProvider><DeliveryStep /></CheckoutSessionProvider> : null}
        {s === "checkout-payment" ? <CheckoutSessionProvider><PaymentStep /></CheckoutSessionProvider> : null}
        {s === "checkout-review" ? <CheckoutSessionProvider><ReviewStep /></CheckoutSessionProvider> : null}
        {s === "success" ? <CheckoutSessionProvider resumeOrderGroupId="og-1"><DeliveryStep /></CheckoutSessionProvider> : null}
        {s === "orders" ? <OrdersScreen /> : null}
        {s === "returns" ? <ReturnsScreen orderLineId="l9" /> : null}
        {s === "wishlists" ? <WishlistsScreen /> : null}
      </View>
    </ThemeProvider>
  );
}

/** Dev-only route: in a production bundle nothing below the gate mounts (no effects run) and the user is sent home. */
export default function PurchasePreview() {
  if (typeof __DEV__ !== "undefined" && !__DEV__) return <Redirect href="/" />;
  return <PurchasePreviewDev />;
}
