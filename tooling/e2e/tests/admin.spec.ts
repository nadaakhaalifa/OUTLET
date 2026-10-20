import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { APP, checkPage, setLocaleOnly, signIn } from "./helpers";

test.skip(APP !== "admin", "admin only");
const PAGES = ["/", "/flags", "/approvals", "/privacy", "/sellers", "/finance", "/engineering", "/tax", "/suspensions", "/elevation", "/creators", "/ranking", "/plus"];
const ALLOW = [401, 403, 404];

for (const locale of ["en", "ar"] as const) {
  test.describe(locale, () => {
    test(`sign-in ${locale}`, async ({ page, context }, info) => {
      await setLocaleOnly(context, locale);
      await checkPage(page, info, "/login", locale);
    });
    for (const p of PAGES) {
      test(`page ${p} ${locale}`, async ({ page, context }, info) => {
        await signIn(context, locale);
        await checkPage(page, info, p, locale, { allow: ALLOW });
      });
    }
    test(`kill switches all Allowed/Blocked ${locale}`, async ({ page, context }) => {
      await signIn(context, locale);
      await page.goto("/flags");
      const rows = page.locator("main table tbody tr");
      const registry = readFileSync(path.resolve(__dirname, "../../../packages/feature-flags/src/registry.ts"), "utf8");
      const expected = new Set([...registry.matchAll(/^\s*"(kill\.[a-z0-9._]+)":\s*\{\s*description/gm)].map((m) => m[1])).size;
      expect(expected).toBeGreaterThanOrEqual(53);
      expect(await rows.count()).toBe(expected);
      const txt = await rows.allInnerTexts();
      const ok = txt.filter((t) => /Allowed|Blocked|مسموح|محظور|متوقف/i.test(t)).length;
      expect(ok).toBe(txt.length);
    });
    test(`creator payouts are disabled while Blocked ${locale}`, async ({ page, context }) => {
      await signIn(context, locale);
      await page.goto("/creators");
      await page.waitForLoadState("networkidle");
      const sendBtn = page.locator("main form button[type=submit]").filter({ hasText: locale === "ar" ? "إرسال الصرف" : "Send payout" });
      await expect(sendBtn.first()).toBeDisabled();
      await expect(page.locator("main [role=status]").first()).toBeVisible();
    });
    test(`dora sample loads ${locale}`, async ({ page, context }) => {
      await signIn(context, locale);
      await page.goto("/engineering");
      await page.setInputFiles("input[type=file]", path.resolve(__dirname, "../dora-report.sample.json"));
      await expect(page.locator("main table").first()).toBeVisible();
    });
  });
}
