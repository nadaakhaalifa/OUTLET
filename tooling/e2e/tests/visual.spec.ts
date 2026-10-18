import { expect, test } from "@playwright/test";
import { APP, setLocaleOnly, signIn } from "./helpers";

// Visual regression baselines (opt-in project `visual`, E2E_VISUAL=1). Tolerant: see playwright.config.ts.
// Update baselines deliberately: E2E_VISUAL=1 tooling/e2e/run.sh <app> --update-snapshots
test.skip(APP === "shopper", "shopper has its own spec");
const BARE = APP === "seller" ? ["/login"] : ["/login"];
const AUTHED = APP === "seller" ? ["/dashboard", "/settings"] : ["/"];

for (const locale of ["en", "ar"] as const) {
  for (const scheme of ["light", "dark"] as const) {
    for (const p of [...BARE, ...AUTHED]) {
      test(`visual ${APP} ${p} ${locale} ${scheme}`, async ({ page, context }) => {
        await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
        if (BARE.includes(p)) await setLocaleOnly(context, locale); else await signIn(context, locale);
        await page.goto(p);
        await page.waitForLoadState("networkidle");
        const slug = p.replace(/\W+/g, "_").replace(/^_|_$/g, "") || "root";
        await expect(page).toHaveScreenshot(`${APP}-${slug}-${locale}-${scheme}.png`, { fullPage: true });
      });
    }
  }
}
