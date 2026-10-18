import { useEffect, useState } from "react";
import { useFonts } from "expo-font";
import { IBMPlexSansArabic_300Light } from "@expo-google-fonts/ibm-plex-sans-arabic/300Light";
import { IBMPlexSansArabic_400Regular } from "@expo-google-fonts/ibm-plex-sans-arabic/400Regular";
import { IBMPlexSansArabic_500Medium } from "@expo-google-fonts/ibm-plex-sans-arabic/500Medium";
import { IBMPlexSansArabic_600SemiBold } from "@expo-google-fonts/ibm-plex-sans-arabic/600SemiBold";

// Display (Playfair Display, Amiri) and UI text (Inter) are bundled as local assets: OFL licences sit next to the files in assets/fonts.
/* eslint-disable @typescript-eslint/no-require-imports */
const LOCAL_FONTS = {
  PlayfairDisplay_400Regular: require("../../assets/fonts/PlayfairDisplay_400Regular.ttf") as number,
  PlayfairDisplay_500Medium: require("../../assets/fonts/PlayfairDisplay_500Medium.ttf") as number,
  PlayfairDisplay_600SemiBold: require("../../assets/fonts/PlayfairDisplay_600SemiBold.ttf") as number,
  PlayfairDisplay_400Regular_Italic: require("../../assets/fonts/PlayfairDisplay_400Regular_Italic.ttf") as number,
  Inter_400Regular: require("../../assets/fonts/Inter_400Regular.ttf") as number,
  Inter_500Medium: require("../../assets/fonts/Inter_500Medium.ttf") as number,
  Inter_600SemiBold: require("../../assets/fonts/Inter_600SemiBold.ttf") as number,
  Amiri_400Regular: require("../../assets/fonts/Amiri_400Regular.ttf") as number,
  Amiri_700Bold: require("../../assets/fonts/Amiri_700Bold.ttf") as number,
};
/* eslint-enable @typescript-eslint/no-require-imports */

const FONT_MAP = {
  ...LOCAL_FONTS,
  IBMPlexSansArabic_300Light, IBMPlexSansArabic_400Regular, IBMPlexSansArabic_500Medium, IBMPlexSansArabic_600SemiBold,
};

/** Hard stop so a stuck font load can never hold the splash forever. */
const FONT_TIMEOUT_MS = 4000;

export interface AppFonts {
  /** True once loading finished (success, failure or timeout): safe to hide the splash. */
  readonly ready: boolean;
  /** True only when every font actually loaded; otherwise text uses the system font. */
  readonly loaded: boolean;
}

export function useAppFonts(): AppFonts {
  const [loaded, error] = useFonts(FONT_MAP);
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setTimedOut(true), FONT_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, []);
  return { ready: loaded || error !== null || timedOut, loaded };
}
