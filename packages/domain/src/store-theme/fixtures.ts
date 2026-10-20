import type { Palette, ThemeDocument } from "./types";

export const LIGHT_OK: Palette = {
  background: "#FFFFFF",
  surface: "#F5F5F5",
  text: "#111111",
  textMuted: "#4A4A4A",
  accent: "#1F4FD8",
  onAccent: "#FFFFFF",
  border: "#6B6B6B",
  heroScrim: { hex: "#000000", alpha: 0.4 },
};

export function makeTheme(over: Partial<ThemeDocument> = {}): ThemeDocument {
  return {
    schemaVersion: 1,
    presetKey: null,
    light: LIGHT_OK,
    dark: null,
    schemePolicy: "follow_system",
    pairingId: "soft_rounded",
    displayScale: "standard",
    displayWeight: "medium",
    radius: "soft",
    grid: "regular",
    motion: "calm",
    cardAspect: "4:5",
    imageBackdrop: "none",
    logoAssetId: null,
    wordmarkAssetId: null,
    coverAssetId: null,
    tagline: { ar: "أزياء هادئة وأنيقة", en: "Calm, considered fashion" },
    sections: [{ kind: "hero" }, { kind: "product_grid", sort: "newest" }],
    ...over,
  };
}
