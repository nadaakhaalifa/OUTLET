import { expect, test, type Page } from "@playwright/test";

const MOCK = "http://localhost:3101";
const UPLOAD = "https://uploads.example.test/**";
// The mock API holds in-memory state, so these flows run one after another.
test.describe.configure({ mode: "serial" });
test.beforeEach(async ({ request }) => { await request.post(`${MOCK}/__test/reset`); });

async function login(page: Page, next: string) {
  await page.goto(`/eg-en/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel("Mobile number").fill("01012345678");
  await page.getByRole("button", { name: "Send code" }).click();
  await page.getByLabel(/Verification code/).fill("123456");
  await page.getByRole("button", { name: "Verify" }).click();
}
const seed = async (request: import("@playwright/test").APIRequestContext) => (await (await request.post(`${MOCK}/__test/seed-orders`)).json()) as { cancellable: string; delivered: string };

test("orders: list -> detail -> cancel needs a confirmation and only changes after the server answers", async ({ page, request }) => {
  const ids = await seed(request);
  await login(page, "/eg-en/orders");
  await expect(page.getByRole("heading", { name: "My orders" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Open order/ })).toHaveCount(2);
  await page.goto(`/eg-en/orders/${ids.cancellable}`);
  await expect(page.getByText("No shipment for this order yet.")).toBeVisible();
  await page.getByRole("button", { name: /Cancel the order from/ }).click();
  await expect(page.getByRole("group", { name: "Confirm cancellation" })).toBeVisible();
  await page.getByLabel("Reason for cancelling").selectOption("changed_mind");
  await page.getByRole("button", { name: "Confirm cancellation" }).click();
  await expect(page.getByText("The order was cancelled.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Cancelled" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /Cancel the order from/ })).toHaveCount(0);
});

test("returns: a defect return needs a photo; the photo goes to the signed URL and the request carries its media id", async ({ page, request }) => {
  const ids = await seed(request);
  await login(page, `/eg-en/orders/${ids.delivered}`);
  await expect(page.getByText("Delivered", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/You can return until Nov 20, 2026/)).toBeVisible();
  const puts: string[] = [];
  await page.route(UPLOAD, async (route) => { puts.push(route.request().method()); await route.fulfill({ status: 200, body: "" }); });
  await page.getByRole("link", { name: "Return or exchange Jacket" }).click();
  await expect(page.getByRole("heading", { name: "Request a return or exchange" })).toBeVisible();
  await page.getByLabel("Reason").selectOption("defective");
  await page.getByRole("button", { name: "Send return request" }).click();
  await expect(page.locator("p[role=alert]")).toContainText("could not send");
  await page.getByLabel("Add a photo").setInputFiles({ name: "defect.png", mimeType: "image/png", buffer: Buffer.from("png-bytes") });
  await expect(page.getByText("1 photo uploaded")).toBeVisible();
  expect(puts).toEqual(["PUT"]);
  await page.getByRole("button", { name: "Send return request" }).click();
  await expect(page.getByText("Your return request was sent.")).toBeVisible();
  const returns = (await (await request.get(`${MOCK}/__test/returns`)).json()) as { reason_code: string; evidence: string[] }[];
  expect(returns).toHaveLength(1);
  expect(returns[0]?.reason_code).toBe("defective");
  expect(returns[0]?.evidence).toHaveLength(1);
  await page.getByRole("link", { name: "View the return" }).click();
  await expect(page.getByRole("heading", { name: "Requested" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel return request" }).click();
  await page.getByRole("button", { name: "Confirm cancelling the request" }).click();
  await expect(page.getByRole("heading", { name: "Cancelled" })).toBeVisible();
  await page.goto("/eg-en/returns");
  await expect(page.getByRole("link", { name: /Open the return/ })).toHaveCount(1);
});

async function fillAddress(page: Page, recipient: string) {
  await page.getByLabel("Recipient name").fill(recipient);
  await page.getByLabel("Recipient mobile").fill("01012345678");
  await page.getByLabel("Governorate").selectOption("g1");
  await page.getByLabel("City").selectOption("c1");
  await page.getByLabel("Street").fill("شارع النيل");
  await page.getByLabel("Building").fill("12");
  await page.getByLabel(/Landmark/).fill("جنب الصيدلية");
  await page.getByRole("button", { name: "Save address" }).click();
}

test("addresses: add, edit, make default, delete (with confirmation)", async ({ page }) => {
  await login(page, "/eg-en/account/addresses");
  await expect(page.getByText("You have no saved addresses.")).toBeVisible();
  await page.getByRole("button", { name: "Add an address" }).click();
  await fillAddress(page, "منى");
  await expect(page.getByText("Address saved.")).toBeVisible();
  await expect(page.getByText("Default address")).toBeVisible();
  await expect(page.getByText("Cash on delivery available")).toBeVisible();
  await page.getByRole("button", { name: "Add an address" }).click();
  await fillAddress(page, "سلمى");
  await expect(page.getByRole("heading", { name: "My addresses" })).toBeVisible();
  await page.getByRole("button", { name: "Edit the address of سلمى" }).click();
  await page.getByLabel("Recipient name").fill("سلمى أحمد");
  await page.getByLabel("City").selectOption("c1");
  await page.getByRole("button", { name: "Save address" }).click();
  await expect(page.getByText("سلمى أحمد")).toBeVisible();
  await page.getByRole("button", { name: "Make the address of سلمى أحمد the default" }).click();
  await expect(page.getByText("Default address")).toHaveCount(1);
  await page.getByRole("button", { name: "Delete the address of منى" }).click();
  await page.getByRole("button", { name: "Confirm deleting the address" }).click();
  await expect(page.getByText("Address deleted.")).toBeVisible();
  await expect(page.getByText("منى", { exact: true })).toHaveCount(0);
});
