import { test } from "@playwright/test";
import { APP, checkPage, setLocaleOnly, signIn } from "./helpers";

// Design review captures: light/dark x AR/EN, desktop + mobile. Same axe/CSP/overflow gates as the page specs.
test.skip(APP === "shopper", "shopper has its own spec");
const BARE = APP === "seller" ? ["/login", "/start"] : ["/login"];
const AUTHED = APP === "seller"
  ? ["/apply", "/apply/00000000-0000-4000-8000-000000000060", "/apply/00000000-0000-4000-8000-000000000061", "/onboarding", "/settings", "/settings/profile", "/settings/payout", "/dashboard"]
  : ["/", "/brand-applications", "/brand-applications/00000000-0000-4000-8000-000000000060"];
const ALLOW = [401, 403, 404];

for (const locale of ["en", "ar"] as const) {
  for (const scheme of ["light", "dark"] as const) {
    for (const p of [...BARE, ...AUTHED]) {
      test(`design ${p} ${locale} ${scheme}`, async ({ page, context }, info) => {
        await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
        if (BARE.includes(p)) await setLocaleOnly(context, locale); else await signIn(context, locale);
        const slug = (p.replace(/[0-9a-f]{8}(-[0-9a-f]{4}){3}-0+(\d+)/, "id$2").replace(/\W+/g, "_").replace(/^_|_$/g, "")) || "root";
        await checkPage(page, info, p, locale, { allow: ALLOW, shot: `web-${APP}-${slug}-${locale}-${scheme}-${info.project.name}` });
      });
    }
  }
}
