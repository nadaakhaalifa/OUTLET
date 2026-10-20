import { describe, expect, it } from "vitest";
import { storeTheme } from "@outlet/domain";
import { ThemeDocumentSchema, parseThemeDocument } from "./store-theme";

const good = {
  schemaVersion: 1,
  presetKey: "soft_pastel",
  light: { background: "#FFFFFF", surface: "#F5F5F5", text: "#111111", textMuted: "#4A4A4A", accent: "#1F4FD8", onAccent: "#FFFFFF", border: "#6B6B6B", heroScrim: { hex: "#000000", alpha: 0.4 } },
  dark: null, schemePolicy: "follow_system", pairingId: "soft_rounded", displayScale: "standard",
  displayWeight: "medium", radius: "soft", grid: "regular", motion: "calm", cardAspect: "4:5",
  imageBackdrop: "none", logoAssetId: null, wordmarkAssetId: null, coverAssetId: null,
  tagline: { ar: "أزياء هادئة", en: "Calm fashion" },
  sections: [{ kind: "hero" }, { kind: "lookbook", assetIds: ["0190b9a0-0000-7000-8000-000000000001"] }],
};
const bad = (patch: Record<string, unknown>) => parseThemeDocument({ ...good, ...patch }).ok;

describe("ThemeDocumentSchema", () => {
  it("accepts a valid document and it publishes cleanly", () => {
    const r = parseThemeDocument(good);
    expect(r.ok).toBe(true);
    if (r.ok) expect(storeTheme.validateThemeForPublish(r.theme).ok).toBe(true);
  });
  it("rejects bad shapes", () => {
    expect(bad({ pairingId: "Comic Sans" })).toBe(false);
    expect(bad({ pairingId: "editorial_serif", displayWeight: "semibold" })).toBe(false);
    expect(bad({ light: { ...good.light, accent: "red" } })).toBe(false);
    expect(bad({ light: { ...good.light, heroScrim: { hex: "#000000", alpha: 0.9 } } })).toBe(false);
    expect(bad({ extra: 1 })).toBe(false);
    expect(bad({ schemaVersion: 2 })).toBe(false);
    expect(bad({ radius: "blob" })).toBe(false);
    expect(bad({ sections: Array.from({ length: 9 }, () => ({ kind: "hero" })) })).toBe(false);
    expect(bad({ sections: [{ kind: "lookbook", assetIds: [] }] })).toBe(false);
    expect(bad({ sections: [{ kind: "hero", css: "x" }] })).toBe(false);
    expect(bad({ logoAssetId: "https://evil.example/x.png" })).toBe(false);
  });
  it("rejects bad taglines (length, urls, control chars, empty Arabic)", () => {
    expect(bad({ tagline: { ar: "ا".repeat(81), en: "x" } })).toBe(false);
    expect(bad({ tagline: { ar: "زوروا example.com", en: "x" } })).toBe(false);
    expect(bad({ tagline: { ar: "ok‮", en: "x" } })).toBe(false);
    expect(bad({ tagline: { ar: "  ", en: "x" } })).toBe(false);
    expect(bad({ tagline: null })).toBe(true);
  });
  it("exposes a schema usable with safeParse", () => {
    expect(ThemeDocumentSchema.safeParse(null).success).toBe(false);
    const r = parseThemeDocument(null);
    expect(r.ok).toBe(false);
  });
});
