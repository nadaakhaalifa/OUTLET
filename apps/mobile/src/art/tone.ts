import { useTheme } from "@outlet/ui-native";
import { DEEP, INK, PAPER, SAND, TEAL, type ArtTone } from "./palette";

export interface ToneColors {
  readonly ink: string;
  readonly paper: string;
  /** Sand: decorative hairlines. */
  readonly gold: string;
  /** Signature accent (teal on paper, sand on deep): monogram dot and wordmark hyphen. */
  readonly brand: string;
}

export function toneColors(tone: ArtTone): ToneColors {
  // On a dark surface the "ink" strokes become paper-coloured and vice versa.
  return tone === "light" ? { ink: INK, paper: PAPER, gold: SAND, brand: TEAL } : { ink: PAPER, paper: DEEP, gold: SAND, brand: SAND };
}

/** Resolve an explicit tone prop or fall back to the system colour scheme. */
export function useArtTone(tone?: ArtTone): ArtTone {
  // Follow the APP theme (manual override included), not just the OS scheme.
  const { isDark } = useTheme();
  return tone ?? (isDark ? "dark" : "light");
}
