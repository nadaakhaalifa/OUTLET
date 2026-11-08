import { expect, test } from "@playwright/test";
import { t } from "./t";

const STORE = "0b7d1f4e-0000-4000-8000-000000000001";
const control = (body: object) => fetch("http://localhost:3201/__control", { method: "POST", body: JSON.stringify(body) });

test.beforeEach(async ({ context }) => {
  await control({ storeActive: true, passkey: true, reset: true });
  await context.addCookies([
    { name: "seller_session", value: "e2e-token", url: "http://localhost:3200", httpOnly: true, sameSite: "Lax" },
    { name: "seller_store", value: STORE, url: "http://localhost:3200" },
    { name: "seller_stores", value: STORE, url: "http://localhost:3200" },
  ]);
});

test("orders: accept, pack and ship with a confirmation each time, masked buyer data and SLA shown", async ({ page }) => {
  const violations: string[] = [];
  page.on("console", (m) => {
    if (/content security policy/i.test(m.text())) violations.push(m.text());
  });
  await page.goto("/eg-ar/orders");
  await expect(page.getByRole("table").getByText(t("seller.orders.status.PAID"))).toBeVisible();
  await expect(page.getByText(/اقبل خلال/)).toBeVisible();
  await page.getByRole("link", { name: "aaaaaaaa" }).click();

  await expect(page.getByRole("heading", { level: 1 })).toContainText("aaaaaaaa");
  await expect(page.getByText("+20••••••••78")).toBeVisible();
  await expect(page.getByText(t("seller.orders.delivery.live"))).toBeVisible();

  // Accept: nothing is sent until Confirm.
  await page.getByRole("button", { name: t("seller.orders.action.accept") }).click();
  await expect(page.getByText(t("seller.orders.confirm.accept"))).toBeVisible();
  const logBefore = (await (await fetch("http://localhost:3201/__log")).json()) as string[];
  expect(logBefore.some((l) => l.includes("/accept"))).toBe(false);
  await page.getByRole("button", { name: t("seller.orders.confirm.yes") }).click();
  await expect(page.getByRole("status").filter({ hasText: t("seller.orders.result.accepted") })).toBeVisible();
  await expect(page.getByText(t("seller.orders.status.ACCEPTED"))).toBeVisible();
  await expect(page.getByText(/اشحن خلال/)).toBeVisible();

  await page.getByRole("button", { name: t("seller.orders.action.pack") }).click();
  await page.getByRole("button", { name: t("seller.orders.confirm.yes") }).click();
  await expect(page.getByText(t("seller.orders.status.PACKED"))).toBeVisible();

  await page.getByRole("button", { name: t("seller.orders.action.ship") }).click();
  await page.getByLabel(t("seller.orders.ship.weight")).fill("850");
  await page.getByRole("button", { name: t("seller.orders.confirm.yes") }).click();
  await expect(page.getByRole("status").filter({ hasText: "MOCK00000001" })).toBeVisible();
  await expect(page.getByText(t("seller.orders.status.SHIPPED"))).toBeVisible();
  await expect(page.getByRole("button", { name: t("seller.orders.action.ship") })).toHaveCount(0);
  expect(violations).toEqual([]);

  const log = (await (await fetch("http://localhost:3201/__log")).json()) as string[];
  const seq = log.filter((l) => /orders\/.*\/(accept|pack)$|shipments$/.test(l));
  expect(seq.map((l) => l.replace(/orders\/[0-9a-f-]+\//, "orders/ID/"))).toEqual(["POST orders/ID/accept", "POST orders/ID/pack", "POST shipments"]);
});

test("orders: an invalid transition shows the server's refusal and changes nothing on screen", async ({ page }) => {
  await page.goto("/eg-ar/orders/aaaaaaaa-0000-4000-8000-00000000000a");
  await page.getByRole("button", { name: t("seller.orders.action.accept") }).click();
  // The order is accepted elsewhere while the confirmation is open.
  await page.request.post("http://localhost:3201/v1/eg/seller/orders/aaaaaaaa-0000-4000-8000-00000000000a/accept", { headers: { authorization: "Bearer e2e-token", "x-store-id": STORE }, data: {} });
  await page.getByRole("button", { name: t("seller.orders.confirm.yes") }).click();
  await expect(page.getByRole("alert").filter({ hasText: t("seller.orders.err.invalid") })).toBeVisible();
});

test("inventory: real levels, low-stock badge, adjust with a reason", async ({ page }) => {
  await page.goto("/eg-ar/inventory");
  const row = (sku: string) => page.getByRole("row").filter({ hasText: sku });
  await expect(row("SKU-1")).toContainText(t("seller.inventory.status.ok"));
  await expect(row("SKU-2")).toContainText(t("seller.inventory.status.low"));

  await row("SKU-2").getByRole("button", { name: new RegExp(t("seller.inventory.adjust")) }).click();
  await page.getByLabel(t("seller.inventory.adjust.delta")).fill("20");
  await page.getByRole("button", { name: t("seller.inventory.adjust.submit") }).click();
  await expect(page.getByRole("alert").filter({ hasText: t("seller.inventory.adjust.invalid") })).toBeVisible();
  await page.getByLabel(t("seller.inventory.adjust.reason")).selectOption("received");
  await page.getByRole("button", { name: t("seller.inventory.adjust.submit") }).click();
  await expect(page.getByRole("status").filter({ hasText: t("seller.inventory.adjust.saved", { onHand: "22" }) })).toBeVisible();
  await expect(row("SKU-2")).toContainText(t("seller.inventory.status.ok"));
  await expect(row("SKU-2")).toContainText("22");
});
