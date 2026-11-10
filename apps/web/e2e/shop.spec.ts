import { expect, test, type Page } from "@playwright/test";

const MOCK = "http://localhost:3101";
// The mock API holds in-memory state (cart, orders, price bump), so these flows run one after another.
test.describe.configure({ mode: "serial" });
test.beforeEach(async ({ request }) => { await request.post(`${MOCK}/__test/reset`); });

async function login(page: Page, next = "/eg-en/bag") {
  await page.goto(`/eg-en/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel("Mobile number").fill("٠١٠١٢٣٤٥٦٧٨");
  await page.getByRole("button", { name: "Send code" }).click();
  await expect(page.getByRole("button", { name: /Resend in \d+ s/ })).toBeDisabled();
  await page.getByLabel(/Verification code/).fill("١٢٣٤٥٦");
  await page.getByRole("button", { name: "Verify" }).click();
}

test("login: phone OTP sets HttpOnly cookies, never exposes tokens to JS, and lands on next", async ({ page, context }) => {
  await login(page);
  await expect(page).toHaveURL(/\/eg-en\/bag$/);
  await expect(page.getByRole("heading", { name: "نيل أوتليت" })).toBeVisible();
  const cookies = await context.cookies();
  const at = cookies.find((c) => c.name === "ox_at");
  const rt = cookies.find((c) => c.name === "ox_rt");
  expect(at?.httpOnly).toBe(true);
  expect(rt?.httpOnly).toBe(true);
  expect(at?.sameSite).toBe("Lax");
  expect(await page.evaluate(() => document.cookie)).not.toContain("ox_");
  expect(await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]))).not.toContain("at-1");
});

test("login: a wrong code is refused, and the Arabic page is RTL", async ({ page }) => {
  await page.goto("/eg-ar/login");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await page.goto("/eg-en/login");
  await page.getByLabel("Mobile number").fill("01012345678");
  await page.getByRole("button", { name: "Send code" }).click();
  await page.getByLabel(/Verification code/).fill("000000");
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.locator("p[role=alert]")).toHaveText("The code is wrong or has expired.");
});

test("registration asks for DOB and the 18+ attestation, then offers unticked consents", async ({ page }) => {
  await page.goto("/eg-en/login");
  await page.getByRole("button", { name: "New here? Create an account" }).click();
  await page.getByLabel("Mobile number").fill("01012345678");
  await page.getByLabel("Date of birth").fill("1995-05-05");
  await page.getByRole("button", { name: "Send code" }).click();
  await expect(page.locator("p[role=alert]")).toHaveText("You must confirm you are 18 or older.");
  await page.getByLabel("I confirm I am 18 or older").check();
  await page.getByRole("button", { name: "Send code" }).click();
  await page.getByLabel(/Verification code/).fill("123456");
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByRole("heading", { name: "Your privacy choices" })).toBeVisible();
  for (const box of await page.getByRole("checkbox").all()) await expect(box).not.toBeChecked();
  await page.getByLabel("Consent: analytics").check();
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page).toHaveURL(/\/eg-en$/);
});

test("bag: signed-out shows a login link; quantity changes and rolls back on refusal; totals come from the server", async ({ page }) => {
  await page.goto("/eg-en/bag");
  await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
  await login(page);
  const subtotal = page.getByText("Items subtotal").locator("xpath=following-sibling::*[1]");
  await expect(subtotal).toHaveText("EGP 800");
  await expect(page.getByText("Price dropped since you added it (was EGP 900)")).toBeVisible();
  await page.getByRole("button", { name: "Increase quantity of Jacket 0" }).click();
  await expect(subtotal).toHaveText("EGP 1,600");
  await expect(page.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "80");
  for (let i = 0; i < 6; i += 1) await page.getByRole("button", { name: "Increase quantity of Jacket 0" }).click();
  await expect(page.locator("output")).toHaveText("8");
  await page.getByRole("button", { name: "Increase quantity of Jacket 0" }).click();
  await expect(page.locator("p[role=alert]")).toHaveText("We could not update the quantity. We restored the previous one.");
  await expect(page.locator("output")).toHaveText("8");
  await page.getByRole("button", { name: "Remove Jacket 0" }).click();
  await expect(page.getByText("Your bag is empty")).toBeVisible();
});

async function addAddress(page: Page) {
  await page.getByLabel("Recipient name").fill("منى");
  await page.getByLabel("Recipient mobile").fill("01012345678");
  await page.getByLabel("Governorate").selectOption("g1");
  await page.getByLabel("City").selectOption("c1");
  await page.getByLabel("Street").fill("شارع النيل");
  await page.getByLabel("Building").fill("12");
  await page.getByLabel(/Landmark/).fill("جنب الصيدلية");
  await page.getByRole("button", { name: "Save address" }).click();
  await expect(page.getByText("Delivery").first()).toBeVisible();
}

test("checkout happy path (card): every fee visible, one order, redirect, then the order page polls to Paid", async ({ page, request }) => {
  await login(page, "/eg-en/checkout");
  await expect(page.getByRole("heading", { name: "Delivery address" })).toBeVisible();
  await addAddress(page);
  await expect(page.getByText("نيل أوتليت: EGP 60 · 2 to 4 days")).toBeVisible();
  const total = page.getByText("Total", { exact: true }).locator("xpath=following-sibling::*[1]");
  await expect(total).toHaveText("EGP 860");
  await expect(page.getByText(/You saved/)).toHaveCount(0);
  await expect(page.getByLabel(/Installments/)).toBeDisabled();
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page).toHaveURL(/\/eg-en\/orders\/.+\?paid=1$/);
  await expect(page.getByRole("heading", { name: "Paid" })).toBeVisible({ timeout: 15_000 });
  const sent = (await (await request.get(`${MOCK}/__test/checkouts`)).json()) as { client_total: { amount_minor: string }; quote_token: string; payment_method: string; idempotency_key: string }[];
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ client_total: { amount_minor: "86000" }, quote_token: "qt-1", payment_method: "card" });
  expect(sent[0]?.idempotency_key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
});

test("checkout price-changed: shows the delta, charges nothing, re-confirms with the new total", async ({ page, request }) => {
  await login(page, "/eg-en/checkout");
  await addAddress(page);
  await expect(page.getByText("Total", { exact: true }).locator("xpath=following-sibling::*[1]")).toHaveText("EGP 860");
  await request.post(`${MOCK}/__test/bump`);
  await page.getByRole("button", { name: "Place order" }).click();
  const box = page.getByRole("alert").filter({ hasText: "Prices changed" });
  await expect(box).toBeVisible();
  await expect(box.getByText("Total: was EGP 860, now EGP 900")).toBeVisible();
  await expect(page).toHaveURL(/checkout$/);
  await box.getByRole("button", { name: "Accept new prices and place order" }).click();
  await expect(page).toHaveURL(/\/eg-en\/orders\/.+\?paid=1$/);
  const sent = (await (await request.get(`${MOCK}/__test/checkouts`)).json()) as { accept_price_change?: boolean; client_total: { amount_minor: string }; quote_token: string }[];
  expect(sent).toHaveLength(2);
  expect(sent[1]).toMatchObject({ accept_price_change: true, client_total: { amount_minor: "90000" }, quote_token: "qt-bumped" });
});

test("checkout COD: fee shown before placing, order page asks for the confirmation code", async ({ page }) => {
  await login(page, "/eg-en/checkout");
  await addAddress(page);
  await page.getByLabel("Cash on delivery").check();
  await expect(page.getByText("Cash on delivery fee")).toBeVisible();
  await expect(page.getByText("Total", { exact: true }).locator("xpath=following-sibling::*[1]")).toHaveText("EGP 885");
  await expect(page.getByText(/send a code to confirm/)).toBeVisible();
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page).toHaveURL(/\/eg-en\/orders\/[^?]+$/);
  await page.getByLabel(/Confirmation code/).fill("123456");
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByLabel(/Confirmation code/)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Confirmed (cash on delivery)" })).toBeVisible();
});

test("account: sessions, consents and the deletion cooling flow", async ({ page }) => {
  await login(page, "/eg-en/account");
  await expect(page.getByRole("heading", { name: "Signed-in devices" })).toBeVisible();
  await page.getByRole("button", { name: /End session \(ios\)/ }).click();
  await expect(page.getByRole("button", { name: /End session/ })).toHaveCount(0);
  await page.getByLabel("Consent: analytics").click();
  await expect(page.getByLabel("Consent: analytics")).toBeChecked();
  await expect(page.getByText("Your choice was saved.")).toBeVisible();
  await page.getByLabel(/Outlex credit is forfeited/).check();
  await page.getByLabel(/I confirm I want to delete/).check();
  await page.getByRole("button", { name: "Request account deletion" }).click();
  await expect(page.getByText(/Deletion is cooling until/)).toBeVisible();
  await page.getByRole("button", { name: "Cancel deletion request" }).click();
  await expect(page.getByRole("button", { name: "Request account deletion" })).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/eg-en\/login$/);
  await page.goto("/eg-en/account");
  await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
});

test("the BFF rejects cross-origin mutations and unknown routes", async ({ request }) => {
  const evil = await request.post("/api/auth/eg/otp-request", { headers: { origin: "https://evil.test", "content-type": "application/json" }, data: { phone_e164: "+201012345678", purpose: "sign_in" } });
  expect(evil.status()).toBe(403);
  expect((await request.get("/api/bff/eg/admin/users")).status()).toBe(404);
  expect((await request.get("/api/bff/eg/cart")).status()).toBe(401);
});
