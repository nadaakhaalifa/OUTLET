import { expect, test } from "@playwright/test";

test("village renders RTL with real stores, category chips and a link to the directory", async ({ page }) => {
  await page.goto("/eg-ar");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("اختر متجرًا. اكتشف صفقة.");
  await expect(page.getByRole("link", { name: /نيل أوتليت/ }).first()).toBeVisible();
  await expect(page.getByRole("navigation", { name: "فئات المتاجر" }).getByRole("link", { name: "أزياء" })).toBeVisible();
  await page.getByRole("link", { name: "عرض كل المتاجر" }).click();
  await expect(page).toHaveURL(/\/eg-ar\/stores$/);
});

test("directory filters by world, keyset load-more is a link", async ({ page }) => {
  await page.goto("/eg-en/stores");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("All stores");
  await expect(page.getByRole("link", { name: "Load more stores" })).toBeVisible();
  await page.getByRole("link", { name: "Global", exact: true }).click();
  await expect(page).toHaveURL(/world=global/);
  await expect(page.getByRole("link", { name: /Nile Outlet/ })).toHaveCount(0);
  await page.goto("/eg-en/stores?world=local");
  await expect(page.getByRole("link", { name: /Nile Outlet/ }).first()).toBeVisible();
  await page.goto("/eg-en/stores?world=local&cursor=zzzz");
  await expect(page.getByText("No stores match these filters.")).toBeVisible();
});

test("product page: Arabic legal identity, no % without evidence", async ({ page }) => {
  await page.goto("/eg-ar/p/prod0");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("جاكيت 0");
  await expect(page.getByText("CR-12345")).toBeVisible();
  await expect(page.getByText("TC-67890")).toBeVisible();
  await expect(page.getByText("القاهرة")).toBeVisible();
  await expect(page.getByText("نيل للتجارة ش.م.م")).toBeVisible();
  await expect(page.locator("main").getByText(/[%٪]/)).toHaveCount(0);
  await page.goto("/eg-ar/p/missing1");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});

test("deals page renders only the band that has verified items", async ({ page }) => {
  await page.goto("/eg-en/deals");
  await expect(page.getByText("70%–60% OFF").first()).toBeVisible();
  await expect(page.getByText("59%–50% OFF")).toHaveCount(0);
  await expect(page.getByText("49%–40% OFF")).toHaveCount(0);
  await expect(page.getByText("No verified discounts yet")).toHaveCount(0);
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
