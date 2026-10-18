import { FSI, PDI, resources } from "@outlet/i18n";
import i18next from "i18next";
import { describe, expect, it } from "vitest";
import { installBidiIsolates } from "./bidi-install";

describe("central bidi isolation", () => {
  it("isolates interpolated values in Arabic and not in English", async () => {
    const i = i18next.createInstance();
    await i.init({ lng: "ar", resources: { ar: { translation: resources.ar }, en: { translation: resources.en } },
      interpolation: { escapeValue: false, alwaysFormat: true, defaultVariables: { product: "Z-OUTLET" } } });
    installBidiIsolates(i);
    expect(i.t("roleChooser.heading", { lng: "ar" })).toContain(`${FSI}Z-OUTLET${PDI}`);
    expect(i.t("roleChooser.heading", { lng: "en" })).not.toContain(FSI);
  });
});
