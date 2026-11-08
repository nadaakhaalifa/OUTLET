import { expect, test } from "@playwright/test";

test("village renders RTL with the honest empty state (no directory route yet)", async ({ page }) => {
  await page.goto("/eg-ar");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("اختر متجرًا. اكتشف صفقة.");
  await expect(page.getByRole("status")).toBeVisible();
  await expect(page.getByRole("link", { name: "اكتشف العروض" })).toBeVisible();
});

test("deals page shows no band without verified evidence", async ({ page }) => {
  await page.goto("/eg-en/deals");
  await expect(page.getByText("No verified discounts yet")).toBeVisible();
  await expect(page.getByText(/OFF/)).toHaveCount(0);
});

test("store page: shelf wall, keyboard carousel in RTL, URL-addressable quick view", async ({ page }) => {
  await page.goto("/eg-ar/stores/nile-outlet");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("نيل أوتليت");
  const shelves = page.locator('[aria-roledescription="carousel"]');
  await expect(shelves).toHaveCount(3);
  const viewport = shelves.first().locator("ul").first();
  await viewport.focus();
  const before = await viewport.evaluate((el) => el.scrollLeft);
  await page.keyboard.press("ArrowLeft"); // RTL: visual left = next slide
  await expect.poll(() => viewport.evaluate((el) => el.scrollLeft)).toBeLessThan(before);

  await page.goto("/eg-ar/stores/nile-outlet?p=prod2");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/\/eg-ar\/stores\/nile-outlet$/);
});
