import { test, expect } from "@playwright/test";
import { APP, checkPage, setLocaleOnly, signIn, probe } from "./helpers";

test.skip(APP !== "seller", "seller only");
const PAGES = ["/dashboard", "/catalog", "/catalog/new", "/catalog/import", "/orders", "/ads", "/drops", "/resale", "/insights", "/channels", "/forecasts", "/media", "/hub", "/returns", "/finance", "/marketing", "/price-trust", "/team", "/settings"];
// Pages without gateway fixtures answer the real API's 401/403/404; the UI must show its error state (allowed below).
const ALLOW = [401, 403, 404];

for (const locale of ["en", "ar"] as const) {
  test.describe(locale, () => {
    test(`login renders ${locale}`, async ({ page, context }, info) => {
      await setLocaleOnly(context, locale);
      await checkPage(page, info, "/login", locale);
      await expect(page.locator("main h1").first()).toBeVisible();
    });
    for (const p of PAGES) {
      test(`page ${p} ${locale}`, async ({ page, context }, info) => {
        await signIn(context, locale);
        await checkPage(page, info, p, locale, { allow: ALLOW });
      });
    }
    test(`forecasts show ranges, stale flag and no bare estimate ${locale}`, async ({ page, context }) => {
      await signIn(context, locale);
      await page.goto("/forecasts");
      await page.waitForLoadState("networkidle");
      const main = page.locator("main");
      await expect(main.getByText(locale === "ar" ? /للاسترشاد/ : /advice only/i).first()).toBeVisible();
      await expect(main.locator("[role=alert].banner.error")).toHaveCount(1);
      await expect(main.getByText(/[4٤] \/ [9٩] \/ (15|١٥)/).first()).toBeVisible();
      await expect(main.getByText(locale === "ar" ? /لا توجد بيانات كافية/ : /Not enough data/).first()).toBeVisible();
    });
    test(`photo cutouts compare before/after and show honest quality ${locale}`, async ({ page, context }) => {
      await signIn(context, locale);
      const p = probe(page);
      await page.goto("/media");
      await page.waitForLoadState("networkidle");
      const main = page.locator("main");
      await expect(main.locator("article")).toHaveCount(3);
      await expect(main.getByText(locale === "ar" ? /أبيض على أبيض/ : /White on white/).first()).toBeVisible();
      await expect(main.getByText(locale === "ar" ? /القص تلقائي/ : /automatic and can miss/i).first()).toBeVisible();
      const first = main.locator("article").first();
      await first.getByRole("button", { name: locale === "ar" ? "الأصلية" : "Original" }).first().click();
      await expect(first.locator(".media-frame.checker")).toHaveCount(0);
      await first.getByRole("button", { name: locale === "ar" ? "بعد القص" : "Cutout" }).first().click();
      await expect(first.locator(".media-frame.checker")).toHaveCount(1);
      await expect(first.locator("img")).toHaveJSProperty("complete", true);
      expect(p.errors).toEqual([]);
    });
    test(`dashboard shows k-anonymity suppression ${locale}`, async ({ page, context }) => {
      await signIn(context, locale);
      await page.goto("/dashboard");
      await expect(page.getByText(/50/).first()).toBeVisible();
    });
    test(`product editor requires Arabic title ${locale}`, async ({ page, context }) => {
      await signIn(context, locale);
      await page.goto("/catalog/new");
      await page.waitForLoadState("networkidle");
      await expect(async () => {
        await page.locator("main form button[type=submit]").first().click({ timeout: 3000 });
        await expect(page.locator("[role=alert], .err").first()).toBeVisible({ timeout: 2000 });
      }).toPass({ timeout: 30_000 });
    });
    test(`csv dry-run reports row errors ${locale}`, async ({ page, context }) => {
      await signIn(context, locale);
      await page.goto("/catalog/import");
      await page.setInputFiles("input[type=file]", { name: "x.csv", mimeType: "text/csv", buffer: Buffer.from("title_ar,category\n,bad\n") });
      await expect(page.locator("[role=status] p").first()).toBeVisible();
    });
    test(`orders show accept countdown ${locale}`, async ({ page, context }) => {
      await signIn(context, locale);
      const p = probe(page);
      await page.goto("/orders");
      await expect(page.locator(".pill").first()).toBeVisible();
      expect(p.errors).toEqual([]);
    });
  });
}
