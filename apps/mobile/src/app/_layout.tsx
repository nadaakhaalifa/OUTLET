import { useEffect, useState } from "react";
import { Platform } from "react-native";
import { Stack, SplashScreen } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ThemeProvider, ToastProvider, useTheme } from "@outlet/ui-native";
import i18n from "i18next";
import { bootLanguage, initialLocale, setupI18n } from "../i18n";
import { registerBrandMode } from "../features/brand-mode/state";
import { installNativeRandom } from "../platform/native-random";
import { SecureStorage } from "../platform/secure-storage";
import { expoSecureStoreBackend } from "../platform/expo-secure-store-backend";
import { LanguageApplyingOverlay } from "../components/LanguageApplyingOverlay";
import { ServicesProvider } from "../state/services";
import { NotConfiguredScreen } from "../components/NotConfiguredScreen";
import { LuxuryTexture } from "../components/LuxuryTexture";
import { DevBadge } from "../components/DevBadge";
import { DevRouteBridge } from "../components/DevRouteBridge";
import { currentBackendConfig } from "../services/release-guard";
import { apiBaseUrlFromEnv } from "../services/runtime";
import { AppThemeProvider, useAppFonts } from "../theme";

installNativeRandom();
const locale = initialLocale();
setupI18n(locale);
registerBrandMode();

// Hold the splash until fonts are ready (or have failed: then the system font is used).
void SplashScreen.preventAutoHideAsync().catch(() => undefined);

/**
 * Direction gate: the saved (else device) language is read and the native layout direction is settled
 * (one guarded reload on mismatch) BEFORE the app tree renders, so nothing ever lays out in the wrong direction.
 */
const directionGate: Promise<"ready" | "reloading" | "gave_up"> = bootLanguage(locale, new SecureStorage(expoSecureStoreBackend)).catch(() => "ready" as const);

function ThemedStack() {
  const { colors, isDark } = useTheme();
  return (
    <ToastProvider>
      <StatusBar style={isDark ? "light" : "dark"} />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background }, animation: Platform.OS === "ios" ? "default" : "fade_from_bottom", animationDuration: 340 }} />
    </ToastProvider>
  );
}

export default function RootLayout() {
  const fonts = useAppFonts();
  const [direction, setDirection] = useState<"pending" | "ready" | "reloading">("pending");

  useEffect(() => {
    let alive = true;
    void directionGate.then((o) => { if (alive) setDirection(o === "reloading" ? "reloading" : "ready"); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (fonts.ready && direction === "ready") void SplashScreen.hideAsync().catch(() => undefined);
  }, [fonts.ready, direction]);

  // Hold the splash until fonts are loaded and the layout direction matches the language.
  if (!fonts.ready || direction !== "ready") return null;
  // Release build without a usable API URL: block, never fall back to fixture data.
  if (currentBackendConfig(apiBaseUrlFromEnv()).kind === "blocked") {
    return (
      <SafeAreaProvider>
        <ThemeProvider isRTL={i18n.language !== "en"} fontsLoaded={fonts.loaded}>
          <NotConfiguredScreen />
        </ThemeProvider>
      </SafeAreaProvider>
    );
  }
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ServicesProvider>
          <AppThemeProvider fontsLoaded={fonts.loaded}>
            <ThemedStack />
            <LuxuryTexture />
            <LanguageApplyingOverlay />
            <DevBadge />
            {__DEV__ ? <DevRouteBridge /> : null}
          </AppThemeProvider>
        </ServicesProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
