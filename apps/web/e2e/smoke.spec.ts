import { expect, test } from "@playwright/test";

test("/eg-ar renders an RTL header with search, Account and Bag", async ({ page }) => {
  const response = await page.goto("/eg-ar");
  expect(response?.headers()["content-security-policy"]).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  await expect(page.getByRole("search")).toBeVisible();
  await expect(page.locator('a[href="/eg-ar/bag"]')).toBeVisible();
  await expect(page.locator('a[href="/eg-ar/account"]')).toBeVisible();
});

test("robots.txt allows search bots and blocks training bots", async ({ request }) => {
  const body = await (await request.get("/robots.txt")).text();
  expect(body).toMatch(/User-Agent: OAI-SearchBot\s+Allow: \//i);
  expect(body).toMatch(/User-Agent: GPTBot\s+Disallow: \//i);
  expect(body).toMatch(/User-Agent: ClaudeBot\s+Disallow: \//i);
});

test("an unknown segment is a 404", async ({ request }) => {
  expect((await request.get("/zz-ar")).status()).toBe(404);
});
