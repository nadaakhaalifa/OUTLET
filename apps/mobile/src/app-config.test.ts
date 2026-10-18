import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

// ADR-0054: iPad support is an owner decision and stays OFF. IOS_SUPPORTS_TABLET only turns it on for a local QA build.
const here = dirname(fileURLToPath(import.meta.url));

async function loadConfig(flag: string | undefined) {
  vi.resetModules();
  vi.stubEnv("IOS_SUPPORTS_TABLET", flag ?? "");
  return (await import("../app.config")).default;
}

afterEach(() => { vi.unstubAllEnvs(); });

describe("app.config iPad flag", () => {
  it("default: iPhone-only, portrait locked, no iPad orientations, no requireFullScreen override", async () => {
    const c = await loadConfig(undefined);
    expect(c.ios?.supportsTablet).toBe(false);
    expect(c.orientation).toBe("portrait");
    expect(c.ios).not.toHaveProperty("requireFullScreen");
    expect(c.ios?.infoPlist).not.toHaveProperty("UISupportedInterfaceOrientations~ipad");
  });
  for (const v of ["false", "0", "TRUE", "yes", "1"]) {
    it(`only the exact string "true" enables it ("${v}" does not)`, async () => {
      expect((await loadConfig(v)).ios?.supportsTablet).toBe(false);
    });
  }
  it("IOS_SUPPORTS_TABLET=true: supportsTablet, requireFullScreen false, all four iPad orientations; iPhone stays portrait", async () => {
    const c = await loadConfig("true");
    expect(c.ios?.supportsTablet).toBe(true);
    expect(c.ios?.requireFullScreen).toBe(false);
    expect(c.orientation).toBe("portrait");
    expect(c.ios?.infoPlist?.["UISupportedInterfaceOrientations~ipad"]).toEqual([
      "UIInterfaceOrientationPortrait", "UIInterfaceOrientationPortraitUpsideDown", "UIInterfaceOrientationLandscapeLeft", "UIInterfaceOrientationLandscapeRight",
    ]);
  });
  it("no EAS profile sets the flag", () => {
    expect(readFileSync(join(here, "../eas.json"), "utf8")).not.toMatch(/IOS_SUPPORTS_TABLET|supportsTablet/);
  });
});
