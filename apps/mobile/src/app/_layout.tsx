import { useEffect } from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { applyDirection, initialLocale, setupI18n } from "../i18n";
import { ServicesProvider } from "../state/services";

const locale = initialLocale();
setupI18n(locale);

export default function RootLayout() {
  useEffect(() => {
    void applyDirection(locale);
  }, []);

  return (
    <ServicesProvider>
      <StatusBar style="auto" />
      <Stack screenOptions={{ headerShown: false }} />
    </ServicesProvider>
  );
}
