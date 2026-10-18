import { describe, expect, it } from "vitest";
import { isPlaceholderUrl, resolveBackendConfig } from "./release-guard";
import { InMemoryBrandModePort, profileView } from "../features/me/model";

describe("release guard", () => {
  it("blocks a release build with no URL (never fixtures)", () => {
    expect(resolveBackendConfig(null, false)).toEqual({ kind: "blocked", reason: "missing" });
    expect(resolveBackendConfig("   ", false)).toEqual({ kind: "blocked", reason: "missing" });
  });
  it("allows fixtures only in development", () => {
    expect(resolveBackendConfig(null, true)).toEqual({ kind: "fixture" });
  });
  it("treats eas.json placeholders as not configured in release", () => {
    expect(isPlaceholderUrl("https://REPLACE-prod-api.example.invalid")).toBe(true);
    expect(resolveBackendConfig("https://REPLACE-prod-api.example.invalid", false)).toEqual({ kind: "blocked", reason: "placeholder" });
  });
  it("rejects non-https and malformed URLs in release", () => {
    expect(resolveBackendConfig("http://api.z-outlet.app", false)).toEqual({ kind: "blocked", reason: "invalid" });
    expect(resolveBackendConfig("api.z-outlet.app", false)).toEqual({ kind: "blocked", reason: "invalid" });
  });
  it("accepts a real https URL and http localhost in dev", () => {
    expect(resolveBackendConfig("https://api.z-outlet.app", false)).toEqual({ kind: "api", baseUrl: "https://api.z-outlet.app" });
    expect(resolveBackendConfig("http://localhost:3000", true)).toEqual({ kind: "api", baseUrl: "http://localhost:3000" });
  });
});

describe("fixture leaks", () => {
  it("the default brand-mode port offers no brand", async () => {
    expect(await new InMemoryBrandModePort().entry()).toBeNull();
  });
  it("the initial profile is neutral until the API answers", () => {
    const p = profileView({ displayName: null, phoneE164: null, tier: null });
    expect(p).toEqual({ initial: "", title: null, maskedPhone: null, tier: null, displayName: null, email: null, photoUrl: null });
  });
});
