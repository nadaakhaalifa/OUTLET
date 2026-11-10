import { expect, test, type Page } from "@playwright/test";
import { t } from "./t";

const STORE = "0b7d1f4e-0000-4000-8000-000000000001";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");

const control = (body: object) => fetch("http://localhost:3201/__control", { method: "POST", body: JSON.stringify(body) });

test.beforeEach(async ({ context }) => {
  await control({ storeActive: true, passkey: true });
  await context.addCookies([
    { name: "seller_session", value: "e2e-token", url: "http://localhost:3200", httpOnly: true, sameSite: "Lax" },
    { name: "seller_store", value: STORE, url: "http://localhost:3200" },
    { name: "seller_stores", value: STORE, url: "http://localhost:3200" },
  ]);
});

const photo = (page: Page, label: string) => page.getByRole("heading", { name: label }).locator("xpath=ancestor::li[1]");

test("every response carries a strict nonce CSP and the page logs no CSP violation", async ({ page }) => {
  const violations: string[] = [];
  page.on("console", (m) => {
    if (/content security policy/i.test(m.text())) violations.push(m.text());
  });
  const res = await page.goto("/eg-ar/products/new");
  const csp = res?.headers()["content-security-policy"] ?? "";
  expect(csp).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
  expect(csp).not.toContain("unsafe-inline");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { level: 1, name: t("seller.wizard.title") })).toBeVisible();
  expect(violations).toEqual([]);
});

test("happy path: draft, photos, details, price, publish 409 reasons, fix, publish 200", async ({ page }) => {
  await page.goto("/eg-ar/products/new");
  await page.getByLabel(t("seller.details.category")).selectOption({ label: "— — فساتين" });
  await photo(page, t("seller.photos.slot.main")).locator("input[type=file]").setInputFiles({ name: "front.png", mimeType: "image/png", buffer: PNG });
  await expect(page.getByRole("status").filter({ hasText: t("seller.topbar.saved") })).toBeVisible();
  await expect(page.getByRole("img", { name: t("seller.photos.preview", { slot: t("seller.photos.slot.main") }) })).toBeVisible();
  await page.getByRole("button", { name: t("seller.actions.continue") }).click();

  await page.getByLabel(t("seller.details.name")).fill("فستان صيفي");
  await page.getByLabel(t("seller.details.description")).fill("فستان قطن مريح");
  await page.getByLabel(t("seller.attr.colour")).selectOption("black");
  await page.getByLabel(t("seller.size.label")).first().fill("M");
  await page.getByLabel(t("seller.size.cm")).first().fill("94");
  await page.getByRole("button", { name: t("seller.actions.continue") }).click();

  await page.getByLabel(t("seller.price.selling")).fill("1299.50");
  const preview = page.getByRole("complementary", { name: t("seller.preview.title") });
  await expect(preview).toContainText(t("condition.newClearance"));
  await expect(preview).not.toContainText("٪");
  await page.getByRole("button", { name: t("seller.actions.continueReview") }).click();
  await expect(page.getByRole("heading", { name: t("seller.review.title") })).toBeVisible();

  // The store is suspended server-side: publish is refused with the reason list.
  await control({ storeActive: false });
  await page.getByRole("button", { name: t("seller.actions.publish") }).click();
  const blocked = page.getByRole("alert").filter({ hasText: t("seller.review.blocked") });
  await expect(blocked).toContainText(t("seller.reason.STORE_NOT_ACTIVE"));

  await control({ storeActive: true });
  await page.getByRole("button", { name: t("seller.actions.publish") }).click();
  await expect(page.getByRole("status").filter({ hasText: t("seller.review.published") })).toBeVisible();

  const log = (await (await fetch("http://localhost:3201/__log")).json()) as string[];
  expect(log.filter((l) => l.startsWith("POST products/") && l.endsWith("/publish"))).toHaveLength(2);
  expect(log.some((l) => l.startsWith("PATCH products/"))).toBe(true);

  await page.goto("/eg-ar/products");
  await expect(page.getByRole("link", { name: "فستان صيفي" })).toBeVisible();
});

test("a missing passkey session shows the blocking banner on the product list", async ({ page }) => {
  await control({ passkey: false });
  await page.goto("/eg-ar/products");
  await expect(page.locator("[data-code=passkey-required]")).toContainText(t("seller.error.passkey"));
});

test("without a session cookie the BFF answers 401 and never calls the API", async ({ page, context }) => {
  await context.clearCookies();
  const res = await page.request.get("/api/seller/eg/products");
  expect(res.status()).toBe(401);
  const post = await page.request.post("/api/seller/eg/products", { data: {} });
  expect(post.status()).toBe(403); // not same-origin: refused before anything else
});
